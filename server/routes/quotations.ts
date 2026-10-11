import { Response, Router } from "express";
import { Card } from "../models/Card.js";
import { Quotation } from "../models/Quotation.js";
import { boardAuth, BoardAuthRequest } from "../middleware/boardAuth.js";
import { writeAuditEvent } from "../lib/audit.js";
import { authMiddleware, requireVerifiedEmail, requireWorkflowRole } from "../middleware/auth.js";
import { CustomerProfile } from "../models/CustomerProfile.js";
import { Order, calculateOrderSupplierCost } from "../models/Order.js";
import { OrderFulfillment } from "../models/OrderFulfillment.js";
import { nextReservationReference } from "../models/Counter.js";

const router = Router({ mergeParams: true });
router.use(authMiddleware, requireVerifiedEmail, boardAuth("guest"));

async function getRequest(cardId: string, boardId: string) {
  const card = await Card.findById(cardId).populate("list", "board");
  if (!card || String((card.list as any)?.board) !== boardId) return null;
  return card;
}

async function ensureSupplierBookingRows(order: InstanceType<typeof Order>, card: InstanceType<typeof Card>) {
  await Promise.all(order.items.map((item) => OrderFulfillment.updateOne(
    { orderId: order._id, orderItemId: item._id, status: { $ne: "cancelled" } },
    { $setOnInsert: {
      orderId: order._id,
      orderItemId: item._id,
      supplierName: String(item.metadata?.supplierName || card.supplierName || "").trim(),
      supplierReference: order.items.length === 1 ? String(card.supplierConfirmationNumber || "").trim() : "",
      hotelConfirmationNumber: order.items.length === 1 ? String(card.hotelConfirmationNumber || "").trim() : "",
      serviceType: item.productType,
      status: "pending",
    } },
    { upsert: true, setDefaultsOnInsert: true }
  )));
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

  const quotation = await Quotation.findOne({ _id: req.params.quotationId, card: card._id });
  if (!quotation) return res.status(404).json({ message: "Quotation not found" });
  if (quotation.status !== "Accepted") {
    return res.status(409).json({ message: "Only an accepted quotation can be converted to a sale" });
  }

  const customerId = String(req.body?.customerId || "");
  const customer = await CustomerProfile.findById(customerId);
  if (!customer) return res.status(404).json({ message: "Customer profile not found" });

  const existingOrder = await Order.findOne({ sourceCardId: card._id });
  if (existingOrder) {
    if (String(existingOrder.ownerId) !== String(req.userId)) {
      return res.status(409).json({ message: "This travel request has already been converted to a sale" });
    }
    await ensureSupplierBookingRows(existingOrder, card);
    return res.json({ order: existingOrder, duplicate: true });
  }

  const list = card.list as any;
  if (!card.reservationRef) {
    card.reservationRef = await nextReservationReference();
    await card.save();
  }
  const items = quotation.lines.map((line) => ({
    productType: ({ Flight: "flight", Hotel: "hotel", Tour: "activity", Transfer: "transfer", Other: "other" } as const)[line.serviceType],
    description: line.description.trim() || line.serviceType,
    quantity: Math.max(1, Number(line.quantity || 1)),
    salePrice: Number(line.sellingRate || 0),
    supplierCost: Number(line.netRate || 0),
    estimatedSupplierCost: Number(line.netRate || 0),
    status: "draft",
    metadata: { supplierName: line.supplierName || "", quotationVersion: quotation.version },
  }));
  const saleSubtotal = items.reduce((sum, item) => sum + item.salePrice * item.quantity, 0);

  try {
    const order = await Order.create({
      orderNumber: `ORD-${Date.now()}`,
      reservationRef: card.reservationRef,
      customerId: customer._id,
      ownerId: req.userId,
      currency: quotation.currency,
      status: "draft",
      accountingStatus: "not_ready",
      saleSubtotal,
      supplierCost: calculateOrderSupplierCost(items),
      source: "accepted_quotation",
      sourceCardId: card._id,
      sourceQuotationId: quotation._id,
      sourceBoardId: req.params.boardId,
      sourceListId: list?._id || card.list,
      statusHistory: [{ status: "draft", reason: `Created from accepted quotation v${quotation.version}`, changedBy: req.userId, changedAt: new Date() }],
      items,
    });
    await ensureSupplierBookingRows(order, card);

    try {
      await writeAuditEvent({
        req,
        action: "sale.created_from_quotation",
        message: `Created sale ${order.orderNumber} from quotation v${quotation.version}`,
        category: "sales",
        card: { id: card._id, title: card.title },
        target: { id: order._id, type: "order", label: order.orderNumber },
        meta: { quotationId: String(quotation._id), customerId: String(customer._id) },
      });
    } catch (error) {
      req.log?.error({ err: error }, "Failed to write quotation conversion audit event");
    }

    return res.status(201).json({ order, duplicate: false });
  } catch (error: any) {
    if (error?.code === 11000) {
      const duplicateOrder = await Order.findOne({ sourceCardId: card._id });
      if (duplicateOrder && String(duplicateOrder.ownerId) === String(req.userId)) {
        return res.json({ order: duplicateOrder, duplicate: true });
      }
      return res.status(409).json({ message: "This travel request has already been converted to a sale" });
    }
    req.log?.error({ err: error }, "Failed to convert quotation to order");
    return res.status(500).json({ message: "Unable to create sale from quotation" });
  }
});

export default router;
