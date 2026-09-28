import { Response, Router } from "express";
import { Card } from "../models/Card.js";
import { Quotation } from "../models/Quotation.js";
import { boardAuth, BoardAuthRequest } from "../middleware/boardAuth.js";
import { writeAuditEvent } from "../lib/audit.js";
import { authMiddleware, requireVerifiedEmail, requireWorkflowRole } from "../middleware/auth.js";

const router = Router({ mergeParams: true });
router.use(authMiddleware, requireVerifiedEmail, boardAuth("guest"));

async function getRequest(cardId: string, boardId: string) {
  const card = await Card.findById(cardId).populate("list", "board");
  if (!card || String((card.list as any)?.board) !== boardId) return null;
  return card;
}

router.get("/:cardId/quotations", async (req: BoardAuthRequest, res: Response) => {
  const card = await getRequest(req.params.cardId, req.params.boardId);
  if (!card) return res.status(404).json({ message: "Travel request not found" });
  res.json(await Quotation.find({ card: card._id }).sort({ version: -1 }));
});

router.post("/:cardId/quotations", requireWorkflowRole("sales"), async (req: BoardAuthRequest, res: Response) => {
  const card = await getRequest(req.params.cardId, req.params.boardId);
  if (!card) return res.status(404).json({ message: "Travel request not found" });
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  const latest = await Quotation.findOne({ card: card._id }).sort({ version: -1 }).select("version");
  const quotation = await Quotation.create({
    card: card._id,
    version: (latest?.version || 0) + 1,
    currency: String(req.body.currency || "USD").toUpperCase(),
    lines,
    notes: String(req.body.notes || ""),
    createdBy: req.userId,
  });
  res.status(201).json(quotation);
});

router.patch("/:cardId/quotations/:quotationId", requireWorkflowRole("sales"), async (req: BoardAuthRequest, res: Response) => {
  const card = await getRequest(req.params.cardId, req.params.boardId);
  if (!card) return res.status(404).json({ message: "Travel request not found" });
  const quotation = await Quotation.findOne({ _id: req.params.quotationId, card: card._id });
  if (!quotation) return res.status(404).json({ message: "Quotation not found" });

  if (quotation.status === "Accepted") {
    return res.status(409).json({ message: "Accepted quotations are locked; create a new version to make changes" });
  }

  const requestedStatus = req.body?.status;
  if (requestedStatus !== undefined) {
    const allowedTransitions: Record<string, string[]> = {
      Draft: ["Sent", "Rejected", "Expired"],
      Sent: ["Accepted", "Rejected", "Expired"],
    };
    if (!allowedTransitions[quotation.status]?.includes(String(requestedStatus))) {
      return res.status(400).json({ message: "Invalid quotation status transition" });
    }
    quotation.status = requestedStatus;
    if (requestedStatus === "Sent") quotation.sentAt = new Date();
    if (requestedStatus === "Accepted") quotation.acceptedAt = new Date();
  }

  if (quotation.status === "Draft") {
    if (req.body?.currency !== undefined) quotation.currency = String(req.body.currency).toUpperCase();
    if (req.body?.lines !== undefined) quotation.lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (req.body?.notes !== undefined) quotation.notes = String(req.body.notes || "");
  }
  await quotation.save();
  if (requestedStatus === "Sent" || requestedStatus === "Accepted") {
    try {
      await writeAuditEvent({
        req,
        action: requestedStatus === "Sent" ? "quotation.sent" : "quotation.accepted",
        message: `Quotation v${quotation.version} marked ${String(requestedStatus).toLowerCase()}`,
        category: "sales",
        target: { _id: quotation._id, type: "quotation", label: `v${quotation.version}` },
        meta: { cardId: String(card._id), version: quotation.version },
      });
    } catch (error) {
      req.log?.error({ err: error }, "Failed to write quotation audit event");
    }
  }
  res.json(quotation);
});

export default router;
