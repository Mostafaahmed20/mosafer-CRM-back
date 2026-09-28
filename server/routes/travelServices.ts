import { Response, Router } from "express";
import { authMiddleware, requireVerifiedEmail, requireWorkflowRole } from "../middleware/auth.js";
import { Card } from "../models/Card.js";
import { TRAVEL_SERVICE_TYPES, TravelService } from "../models/TravelService.js";
import { boardAuth, BoardAuthRequest } from "../middleware/boardAuth.js";

const router = Router({ mergeParams: true });
router.use(authMiddleware, requireVerifiedEmail, boardAuth("guest"));

async function getRequest(cardId: string, boardId: string) {
  const card = await Card.findById(cardId).populate("list", "board");
  return card && String((card.list as any)?.board) === boardId ? card : null;
}

function serviceData(body: Record<string, unknown>) {
  const allowed = ["type", "title", "supplierName", "pricingSource", "supplierReference", "currency", "netCost", "sellingPrice", "status", "details", "notes"];
  return Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
}

function validateService(data: Record<string, unknown>): string | null {
  if (data.type && !TRAVEL_SERVICE_TYPES.includes(data.type as any)) return "Invalid travel service type";
  if (data.currency && !/^[A-Za-z]{3}$/.test(String(data.currency))) return "Currency must be a three-letter code";
  for (const field of ["netCost", "sellingPrice"]) {
    if (data[field] !== undefined && (!Number.isFinite(Number(data[field])) || Number(data[field]) < 0)) return `${field} must be a non-negative number`;
  }
  return null;
}

router.get("/:cardId/services", async (req: BoardAuthRequest, res: Response) => {
  const card = await getRequest(req.params.cardId, req.params.boardId);
  if (!card) return res.status(404).json({ message: "Travel request not found" });
  res.json(await TravelService.find({ card: card._id }).sort({ createdAt: 1 }));
});

router.post("/:cardId/services", requireWorkflowRole("operations"), async (req: BoardAuthRequest, res: Response) => {
  const card = await getRequest(req.params.cardId, req.params.boardId);
  if (!card) return res.status(404).json({ message: "Travel request not found" });
  const data = serviceData(req.body || {});
  if (!data.type || !String(data.title || "").trim()) return res.status(400).json({ message: "Service type and title are required" });
  const validationError = validateService(data);
  if (validationError) return res.status(400).json({ message: validationError });
  res.status(201).json(await TravelService.create({ ...data, card: card._id, createdBy: req.userId }));
});

router.patch("/:cardId/services/:serviceId", requireWorkflowRole("operations"), async (req: BoardAuthRequest, res: Response) => {
  const card = await getRequest(req.params.cardId, req.params.boardId);
  if (!card) return res.status(404).json({ message: "Travel request not found" });
  const data = serviceData(req.body || {});
  const validationError = validateService(data);
  if (validationError) return res.status(400).json({ message: validationError });
  const service = await TravelService.findOne({ _id: req.params.serviceId, card: card._id });
  if (!service) return res.status(404).json({ message: "Travel service not found" });
  Object.assign(service, data);
  await service.save();
  res.json(service);
});

router.delete("/:cardId/services/:serviceId", requireWorkflowRole("operations"), async (req: BoardAuthRequest, res: Response) => {
  const card = await getRequest(req.params.cardId, req.params.boardId);
  if (!card) return res.status(404).json({ message: "Travel request not found" });
  const service = await TravelService.findOneAndDelete({ _id: req.params.serviceId, card: card._id });
  if (!service) return res.status(404).json({ message: "Travel service not found" });
  res.status(204).send();
});

export default router;
