import { Response, Router } from "express";
import { Card } from "../models/Card.js";
import { Quotation } from "../models/Quotation.js";
import { CustomerProfile } from "../models/CustomerProfile.js";
import { Order, calculateOrderSupplierCost } from "../models/Order.js";
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

router.post("/:cardId/quotations/:quotationId/convert-to-order", requireWorkflowRole("sales"), async (req: BoardAuthRequest, res: Response) => {
  const card = await getRequest(req.params.cardId, req.params.boardId);
  if (!card) return res.status(404).json({ message: "Travel request not found" });

  const quotation = await Quotation.findOne({ _id: req.params.quotationId, card: card._id, status: "Accepted" });
  if (!quotation) return res.status(409).json({ message: "Accept the quotation before creating the sale" });

  const customerId = String(req.body?.customerId || "").trim();
  if (!customerId) return res.status(400).json({ message: "Choose a customer before creating the sale" });

  const customer = await CustomerProfile.findOne({ _id: customerId, owner: req.userId }).select("_id");
  if (!customer) return res.status(404).json({ message: "Customer profile not found" });

  const existing = await Order.findOne({ sourceCardId: card._id });
  if (existing) return res.json({ order: existing, duplicate: true });

  const productTypeFor = (serviceType: string) => {
    const normalized = serviceType.toLowerCase();
    if (normalized === "flight") return "flight";
    if (normalized === "hotel") return "hotel";
    if (normalized === "tour") return "package";
    if (normalized === "transfer") return "transfer";
    return "other";
  };

  const items = quotation.lines
    .filter((line) => String(line.description || "").trim())
    .map((line) => ({
      productType: productTypeFor(line.serviceType),
      description: String(line.description).trim(),
      quantity: Math.max(1, Number(line.quantity || 1)),
      salePrice: Math.max(0, Number(line.sellingRate || 0)),
      supplierCost: Math.max(0, Number(line.netRate || 0)),
      tax: 0,
      commission: 0,
      status: "draft",
      supplierReference: "",
      metadata: { supplierName: String(line.supplierName || "").trim() },
    }));

  if (!items.length) return res.status(400).json({ message: "Add at least one service to the quotation" });

  const saleSubtotal = items.reduce((total, item) => total + item.quantity * item.salePrice, 0);
  const order = await Order.create({
    orderNumber: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    customerId: customer._id,
    ownerId: req.userId,
    currency: quotation.currency,
    status: "confirmed",
    accountingStatus: "not_ready",
    salesChannel: "chat",
    saleSubtotal,
    taxes: 0,
    serviceFees: 0,
    markup: 0,
    discounts: 0,
    supplierTaxes: 0,
    paymentFees: 0,
    supplierCost: calculateOrderSupplierCost(items),
    source: "quotation",
    sourceCardId: card._id,
    sourceQuotationId: quotation._id,
    sourceBoardId: req.params.boardId,
    sourceListId: card.list,
    statusHistory: [{ status: "confirmed", reason: "Client accepted quotation", changedBy: String(req.userId), changedAt: new Date() }],
    items,
  });

  card.salesStage = "Won";
  card.status = "Closed";
  card.orderId = order._id;
  card.accountingStatus = "Ready for accounting";
  card.dueComplete = true;
  card.completedAt = new Date();
  await card.save();

  await writeAuditEvent({
    req,
    action: "sale.created_from_quotation",
    message: `Created sale ${order.orderNumber} from accepted quotation v${quotation.version}`,
    category: "sales",
    target: { id: order._id, type: "order", label: order.orderNumber },
    meta: { cardId: String(card._id), quotationId: String(quotation._id), customerId, customerTotal: order.customerTotal, supplierCost: order.supplierCost, grossMargin: order.grossMargin },
  });

  res.status(201).json({ order, card, duplicate: false });
});

export default router;
