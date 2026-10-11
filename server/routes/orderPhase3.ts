import mongoose from "mongoose";
import { Response, Router } from "express";
import { Order, deriveOrderStatusAfterSupplierBooking } from "../models/Order.js";
import { OrderQuote, applyQuoteAcceptance, calculateQuoteTotal } from "../models/OrderQuote.js";
import { OrderPayment, calculateOrderPaymentTotals, calculateOrderSettlement } from "../models/OrderPayment.js";
import { OrderFulfillment, buildSupplierReferenceDuplicateFilter } from "../models/OrderFulfillment.js";
import { AuthRequest, authMiddleware, requireVerifiedEmail, requireWorkflowRole, requireAnyWorkflowRole } from "../middleware/auth.js";
import { getSupplierSubmissionBlocker } from "../lib/clientPaymentVerification.js";

import { findAccessibleOrder, getAccessibleOrderFilter } from "../lib/orderAccess.js";

const router = Router();
router.use(authMiddleware, requireVerifiedEmail);

router.post("/:orderId/quotes/:quoteId/accept", requireWorkflowRole("sales"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });

  const quote = await OrderQuote.findOne({ _id: req.params.quoteId, orderId: order._id });
  if (!quote) return res.status(404).json({ message: "Quote not found" });

  const acceptedQuote = {
    ...quote.toObject(),
    status: "accepted",
    acceptedAt: new Date(),
    lockedTotal: calculateQuoteTotal(quote.lines),
  };

  await OrderQuote.updateOne({ _id: quote._id }, { $set: { ...acceptedQuote, status: "accepted" } });
  order.status = "confirmed";
  await order.save();

  res.json({
    quote: { ...acceptedQuote, status: "accepted" },
    order,
  });
});

router.get("/:orderId/settlement", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });

  const payments = await OrderPayment.find({ orderId: order._id });
  const totals = calculateOrderPaymentTotals(payments.map((payment) => ({ amount: payment.amount, status: payment.status })));
  const settlement = calculateOrderSettlement({
    customerTotal: Number(order.customerTotal || 0),
    paid: totals.paid,
    refunded: totals.refunded,
    pending: totals.pending,
  });

  res.json({ totals, settlement, orderStatus: order.status });
});

router.post("/:orderId/supplier-bookings", requireAnyWorkflowRole(["sales", "operations"]), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });

  const clientPayments = await OrderPayment.find({ orderId: order._id });
  const paymentBlocker = getSupplierSubmissionBlocker({
    customerTotal: order.customerTotal,
    currency: order.currency,
    payments: clientPayments.map((payment) => ({
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      accountantConfirmation: payment.accountantConfirmation,
    })),
  });
  if (paymentBlocker) return res.status(409).json({ message: paymentBlocker, code: "CLIENT_PAYMENT_NOT_VERIFIED" });

  const payload = {
    orderId: order._id,
    supplierId: String(req.body?.supplierId || ""),
    supplierName: String(req.body?.supplierName || "").trim(),
    reference: String(req.body?.reference || "").trim(),
    status: String(req.body?.status || "pending").toLowerCase(),
    notes: String(req.body?.notes || ""),
    bookedAt: req.body?.bookedAt ? new Date(req.body.bookedAt) : new Date(),
  };

  if (payload.status !== "pending" && payload.status !== "booked") {
    return res.status(400).json({ message: "Supplier booking status must be pending or booked" });
  }
  if (payload.reference && !payload.supplierName) {
    return res.status(400).json({ message: "Supplier name is required when a booking reference is provided" });
  }
  const duplicateFilter = buildSupplierReferenceDuplicateFilter(
    order._id,
    payload.supplierName,
    payload.reference
  );
  if (duplicateFilter && await OrderFulfillment.exists(duplicateFilter)) {
    return res.status(409).json({ message: "This supplier booking reference is already used on this order" });
  }

  const session = await mongoose.startSession();
  let fulfillment: InstanceType<typeof OrderFulfillment> | null = null;
  try {
    await session.withTransaction(async () => {
      const accessFilter = await getAccessibleOrderFilter(String(req.userId));
      const currentOrder = await Order.findOne({ _id: order._id, ...accessFilter }).session(session);
      if (!currentOrder) throw new Error("Order not found");

      const newFulfillment = new OrderFulfillment({
        orderId: currentOrder._id,
        supplierId: req.body?.supplierId || undefined,
        supplierName: payload.supplierName,
        supplierReference: payload.reference,
        serviceType: String(req.body?.serviceType || "travel_service"),
        status: payload.status,
        bookedAt: payload.status === "booked" ? payload.bookedAt : undefined,
        notes: payload.notes,
        tasks: Array.isArray(req.body?.tasks) ? req.body.tasks : [{ title: "Confirm supplier booking", status: payload.status === "booked" ? "done" : "pending" }],
      });
      await newFulfillment.save({ session });

      const nextStatus = deriveOrderStatusAfterSupplierBooking(currentOrder.status, payload.status);
      if (nextStatus !== currentOrder.status) {
        currentOrder.status = nextStatus;
        await currentOrder.save({ session });
      }
      fulfillment = newFulfillment;
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      return res.status(409).json({ message: "This supplier booking reference is already used on this order" });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  res.status(201).json({
    ok: true,
    booking: payload,
    fulfillment,
    orderId: order._id,
  });
});

router.get("/:orderId/accepted-quote", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });

  const quote = await OrderQuote.findOne({ orderId: order._id, status: "accepted" }).sort({ version: -1 });
  if (!quote) return res.status(404).json({ message: "Accepted quote not found" });

  const acceptedVersion = applyQuoteAcceptance([quote.toObject() as any]);

  res.json({
    quote: acceptedVersion[0] || quote,
    total: calculateQuoteTotal(quote.lines),
  });
});

export default router;
