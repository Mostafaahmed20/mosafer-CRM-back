import { Response, Router } from "express";
import { Order, deriveOrderStatusAfterPayment } from "../models/Order.js";
import { OrderQuote, calculateQuoteTotal } from "../models/OrderQuote.js";
import { OrderPayment, calculateOrderPaymentTotals } from "../models/OrderPayment.js";
import { uploadOrderAttachment, storeOrderAttachment } from "../lib/orderAttachments.js";
import { safeUnlink } from "../lib/cloudinary.js";
import { OrderTraveler } from "../models/OrderTraveler.js";
import { OrderPackage } from "../models/OrderPackage.js";
import { Traveler } from "../models/Traveler.js";
import { CustomerTraveler } from "../models/CustomerTraveler.js";
import { writeAuditEvent } from "../lib/audit.js";
import { AuthRequest, authMiddleware, requireVerifiedEmail, requireWorkflowRole, requireAnyWorkflowRole } from "../middleware/auth.js";
import { isAccountingLocked } from "../lib/accountingReadiness.js";

import { findAccessibleOrder, getAccessibleOrderFilter } from "../lib/orderAccess.js";

const router = Router();
router.use(authMiddleware, requireVerifiedEmail);

router.get("/:orderId/quote", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });

  const quotes = await OrderQuote.find({ orderId: order._id }).sort({ version: -1 });
  res.json({
    quotes,
    latestTotal: quotes[0] ? calculateQuoteTotal(quotes[0].lines) : 0,
  });
});

router.post("/:orderId/quote", requireWorkflowRole("sales"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (isAccountingLocked(order.accountingStatus)) return res.status(409).json({ message: "Order quotations are locked after accounting handoff" });

  const latest = await OrderQuote.findOne({ orderId: order._id }).sort({ version: -1 }).select("version");
  const quote = await OrderQuote.create({
    orderId: order._id,
    version: (latest?.version || 0) + 1,
    status: "draft",
    currency: String(req.body?.currency || order.currency || "USD").toUpperCase(),
    lines: Array.isArray(req.body?.lines) ? req.body.lines : [],
    notes: String(req.body?.notes || ""),
    createdBy: req.userId,
  });

  res.status(201).json({ quote, total: calculateQuoteTotal(quote.lines) });
});

router.get("/:orderId/payments", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });

  const payments = await OrderPayment.find({ orderId: order._id }).sort({ createdAt: -1 });
  res.json({
    payments,
    totals: calculateOrderPaymentTotals(payments.map((payment) => ({ amount: payment.amount, status: payment.status }))),
  });
});

router.post("/:orderId/payments", requireWorkflowRole("accounting"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (isAccountingLocked(order.accountingStatus)) return res.status(409).json({ message: "Order payments are locked after accounting handoff" });

  const amount = Math.round(Number(req.body?.amount || 0) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: "Payment amount must be greater than zero" });
  const currency = String(req.body?.currency || order.currency || "USD").trim().toUpperCase();
  const paymentMethod = String(req.body?.paymentMethod || "manual").trim().toLowerCase();
  const paymentReference = String(req.body?.paymentReference || "").trim();
  const idempotencyKey = String(req.body?.idempotencyKey || "").trim();
  const status = String(req.body?.status || "pending").toLowerCase();
  if (!idempotencyKey) return res.status(400).json({ message: "Payment idempotency key is required" });
  if (!["pending", "posted"].includes(status)) return res.status(400).json({ message: "Payments must start as pending or posted" });
  if (!paymentMethod || !/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ message: "Valid payment method and currency are required" });

  const previous = await OrderPayment.findOne({ orderId: order._id, idempotencyKey });
  if (previous) {
    if (Number(previous.amount) !== amount || previous.currency !== currency || previous.paymentMethod !== paymentMethod || (previous.paymentReference || "") !== paymentReference || previous.status !== status) {
      return res.status(409).json({ message: "Payment idempotency key was reused with different details", code: "PAYMENT_KEY_REUSED" });
    }
    return res.status(200).json({ payment: previous, duplicate: true });
  }
  const normalizedReference = paymentReference.toLowerCase();
  if (normalizedReference && await OrderPayment.exists({ orderId: order._id, dedupeReference: normalizedReference })) {
    return res.status(409).json({ message: "This payment reference is already recorded", code: "PAYMENT_REFERENCE_DUPLICATE" });
  }

  let payment;
  try {
    payment = await OrderPayment.create({
      orderId: order._id,
      paymentMethod,
      paymentReference,
      ...(paymentReference ? { dedupeReference: normalizedReference } : {}),
      idempotencyKey,
      amount,
      currency,
      status,
      notes: String(req.body?.notes || ""),
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      const sameKey = await OrderPayment.findOne({ orderId: order._id, idempotencyKey });
      if (sameKey) {
        if (Number(sameKey.amount) !== amount || sameKey.currency !== currency || sameKey.paymentMethod !== paymentMethod || (sameKey.paymentReference || "") !== paymentReference || sameKey.status !== status) {
          return res.status(409).json({ message: "Payment idempotency key was reused with different details", code: "PAYMENT_KEY_REUSED" });
        }
        return res.status(200).json({ payment: sameKey, duplicate: true });
      }
      return res.status(409).json({ message: "This payment reference is already recorded", code: "PAYMENT_REFERENCE_DUPLICATE" });
    }
    throw error;
  }

  const paymentTotals = await OrderPayment.find({ orderId: order._id });
  const postedTotals = calculateOrderPaymentTotals(
    paymentTotals.map((entry) => ({ amount: entry.amount, status: entry.status }))
  );
  order.amountPaid = postedTotals.net;
  order.status = deriveOrderStatusAfterPayment(order.status, order.amountPaid);
  await order.save();

  res.status(201).json(payment);
});

router.get("/:orderId/travelers", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });

  const travelers = await OrderTraveler.find({ orderId: order._id }).sort({ createdAt: -1 });
  res.json(travelers);
});

router.post("/:orderId/travelers", requireAnyWorkflowRole(["sales", "operations"]), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (isAccountingLocked(order.accountingStatus)) return res.status(409).json({ message: "Order travelers are locked after accounting handoff" });

  const travelerId = String(req.body?.travelerId || "").trim();
  let source: any;
  if (travelerId) {
    const linked = await CustomerTraveler.exists({ customerId: order.customerId, travelerId });
    if (!linked) return res.status(400).json({ message: "Traveler is not linked to this order's customer" });
    // The customer-traveler link is the authorization boundary. The profile may belong
    // to a different board member than the person who converted the order.
    source = await Traveler.findById(travelerId);
    if (!source) return res.status(404).json({ message: "Traveler not found" });
  }

  const firstName = String(source?.firstName ?? req.body?.firstName ?? "").trim();
  const lastName = String(source?.lastName ?? req.body?.lastName ?? "").trim();
  if (!firstName || !lastName) {
    return res.status(400).json({ message: "firstName and lastName are required" });
  }
  const dateOfBirth = (source?.dateOfBirth ?? req.body?.dateOfBirth)
    ? new Date(source?.dateOfBirth ?? req.body.dateOfBirth)
    : undefined;
  if (dateOfBirth && Number.isNaN(dateOfBirth.getTime())) {
    return res.status(400).json({ message: "dateOfBirth must be a valid date" });
  }

  const existingSnapshot = source?._id
    ? await OrderTraveler.findOne({ orderId: order._id, travelerId: source._id })
    : null;
  const snapshot = existingSnapshot || await OrderTraveler.create({
      orderId: order._id,
      travelerId: source?._id,
      firstName,
      lastName,
      email: String(source?.email ?? req.body?.email ?? ""),
      phone: String(source?.phone ?? req.body?.phone ?? ""),
      passportNumber: String(req.body?.passportNumber || ""),
      nationality: String(source?.nationality ?? req.body?.nationality ?? ""),
      dateOfBirth,
      notes: String(req.body?.notes || ""),
    });

  // Adding a traveler to the sale also assigns them to its active package.
  const activePackage = await OrderPackage.findOne({ orderId: order._id, status: { $ne: "cancelled" } }).sort({ updatedAt: -1 });
  if (activePackage && !activePackage.travelerIds.some((id) => String(id) === String(snapshot._id))) {
    activePackage.travelerIds.push(snapshot._id);
    await activePackage.save();
  }

  await writeAuditEvent({
    req,
    action: "order.traveler_snapshotted",
    message: `Added traveler ${firstName} ${lastName} to order ${order.orderNumber}`,
    category: "booking",
    target: { _id: snapshot._id, type: "order_traveler", label: `${firstName} ${lastName}` },
    meta: { orderId: String(order._id), sourceTravelerId: travelerId || undefined },
  });

  res.status(201).json(snapshot);
});

router.post("/:orderId/payments/:paymentId/attachments", requireWorkflowRole("accounting"), uploadOrderAttachment.single("file"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) {
    safeUnlink(req.file?.path);
    return res.status(404).json({ message: "Order not found" });
  }
  if (isAccountingLocked(order.accountingStatus)) {
    safeUnlink(req.file?.path);
    return res.status(409).json({ message: "Payment attachments are locked after accounting handoff" });
  }
  const payment = await OrderPayment.findOne({ _id: req.params.paymentId, orderId: order._id });
  if (!payment) {
    safeUnlink(req.file?.path);
    return res.status(404).json({ message: "Payment not found" });
  }
  if (!req.file) return res.status(400).json({ message: "Choose a receipt or payment proof file" });

  const duplicate = payment.attachments.find((item) => item.name === req.file!.originalname && item.size === req.file!.size && item.type === req.file!.mimetype);
  if (duplicate) {
    safeUnlink(req.file.path);
    return res.json({ payment, attachment: duplicate, duplicate: true });
  }

  try {
    const attachment = await storeOrderAttachment(req.file, String(req.userId));
    payment.attachments.push(attachment as any);
    await payment.save();
    res.status(201).json({ payment, attachment });
  } catch (error) {
    safeUnlink(req.file.path);
    throw error;
  }
});

export default router;
