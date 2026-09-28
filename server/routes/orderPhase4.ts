import mongoose from "mongoose";
import { Response, Router } from "express";
import { Order, deriveOrderStatusAfterSupplierBooking, setOrderItemActualSupplierCost } from "../models/Order.js";
import {
  OrderFulfillment,
  buildFulfillmentHistory,
  buildSupplierReferenceDuplicateFilter,
  canCancelSupplierFulfillment,
  calculateSupplierInvoiceSettlement,
  calculateFulfillmentProgress,
  findSupplierPaymentByIdempotencyKey,
} from "../models/OrderFulfillment.js";
import { AuthRequest, authMiddleware, requireVerifiedEmail, requireWorkflowRole } from "../middleware/auth.js";
import { isAccountingLocked } from "../lib/accountingReadiness.js";

import { findAccessibleOrder, getAccessibleOrderFilter } from "../lib/orderAccess.js";

const router = Router();
router.use(authMiddleware, requireVerifiedEmail);

function getDuplicateKeyMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 11000) return null;
  if ("keyPattern" in error && typeof error.keyPattern === "object" && error.keyPattern !== null && "orderItemId" in error.keyPattern) {
    return "Another active fulfillment is already linked to this order service";
  }
  return "This supplier booking reference is already used on this order";
}

function optionalAmount(value: number | undefined): number | null {
  return value === undefined ? null : Number(value);
}

router.get("/:orderId/fulfillment", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });

  const fulfillment = await OrderFulfillment.find({ orderId: order._id }).sort({ createdAt: -1 });
  res.json({
    items: fulfillment.map((item) => ({
      ...item.toObject(),
      supplierInvoiceSettlement: item.supplierInvoiceAmount === undefined
        ? null
        : calculateSupplierInvoiceSettlement(item.supplierInvoiceAmount, item.supplierPayments, item.supplierInvoiceDueAt),
    })),
    totalProgress: fulfillment.length
      ? Math.round(fulfillment.reduce((sum, item) => sum + calculateFulfillmentProgress(item.tasks), 0) / fulfillment.length)
      : 0,
  });
});

router.post("/:orderId/fulfillment/:fulfillmentId/supplier-payments", requireWorkflowRole("accounting"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (isAccountingLocked(order.accountingStatus)) return res.status(409).json({ message: "Supplier payments are locked after accounting handoff" });

  const fulfillment = await OrderFulfillment.findOne({ _id: req.params.fulfillmentId, orderId: order._id });
  if (!fulfillment) return res.status(404).json({ message: "Fulfillment item not found" });
  if (fulfillment.supplierInvoiceAmount === undefined) {
    return res.status(409).json({ message: "Record the supplier invoice before posting a payment" });
  }

  const requestedAmount = Number(req.body?.amount);
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    return res.status(400).json({ message: "Supplier payment amount must be greater than zero" });
  }
  const amount = Math.round(requestedAmount * 100) / 100;
  if (amount <= 0) {
    return res.status(400).json({ message: "Supplier payment amount must be at least one cent" });
  }

  const idempotencyKey = String(req.body?.idempotencyKey || "").trim();
  if (!idempotencyKey) {
    return res.status(400).json({ message: "Supplier payment idempotency key is required" });
  }
  const paymentReference = String(req.body?.paymentReference || "").trim();
  const paymentMethod = String(req.body?.paymentMethod || "manual").trim();
  const paidAt = req.body?.paidAt ? new Date(req.body.paidAt) : new Date();
  if (!paymentMethod) {
    return res.status(400).json({ message: "Supplier payment method is required" });
  }
  if (Number.isNaN(paidAt.getTime())) {
    return res.status(400).json({ message: "Supplier payment date is invalid" });
  }
  const priorAttempt = findSupplierPaymentByIdempotencyKey(fulfillment.supplierPayments, idempotencyKey);
  if (priorAttempt) {
    if (Number(priorAttempt.amount) !== amount || (priorAttempt.paymentReference || "") !== paymentReference) {
      return res.status(409).json({ message: "Supplier payment idempotency key was reused with different details" });
    }
    return res.status(200).json({
      payment: priorAttempt,
      settlement: calculateSupplierInvoiceSettlement(
        fulfillment.supplierInvoiceAmount,
        fulfillment.supplierPayments,
        fulfillment.supplierInvoiceDueAt
      ),
      fulfillment,
    });
  }
  if (paymentReference && fulfillment.supplierPayments.some((payment) =>
    payment.paymentReference?.trim().toLowerCase() === paymentReference.toLowerCase()
  )) {
    return res.status(409).json({ message: "This supplier payment reference is already recorded" });
  }

  const payment = {
    amount,
    idempotencyKey,
    paymentReference,
    paymentMethod,
    paidAt,
    recordedBy: String(req.userId || ""),
  };
  const paymentFilter: Record<string, unknown> = {
    _id: fulfillment._id,
    orderId: order._id,
    $expr: {
      $lte: [
        { $add: [{ $ifNull: [{ $sum: "$supplierPayments.amount" }, 0] }, Math.round(amount * 100) / 100] },
        "$supplierInvoiceAmount",
      ],
    },
  };
  const noDuplicatePayment: Record<string, unknown>[] = [
    { supplierPayments: { $not: { $elemMatch: { idempotencyKey } } } },
  ];
  if (paymentReference) {
    noDuplicatePayment.push({
      supplierPayments: {
        $not: {
          $elemMatch: {
            paymentReference: new RegExp(`^${paymentReference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
          },
        },
      },
    });
  }
  paymentFilter.$and = noDuplicatePayment;

  const updatedFulfillment = await OrderFulfillment.findOneAndUpdate(
    paymentFilter,
    { $push: { supplierPayments: payment } },
    { new: true, runValidators: true }
  );
  if (!updatedFulfillment) {
    const latestFulfillment = await OrderFulfillment.findOne({ _id: req.params.fulfillmentId, orderId: order._id });
    if (!latestFulfillment) return res.status(404).json({ message: "Fulfillment item not found" });
    const committedAttempt = findSupplierPaymentByIdempotencyKey(latestFulfillment.supplierPayments, idempotencyKey);
    if (committedAttempt) {
      return res.status(200).json({
        payment: committedAttempt,
        settlement: calculateSupplierInvoiceSettlement(
          latestFulfillment.supplierInvoiceAmount!,
          latestFulfillment.supplierPayments,
          latestFulfillment.supplierInvoiceDueAt
        ),
        fulfillment: latestFulfillment,
      });
    }
    if (paymentReference && latestFulfillment.supplierPayments.some((entry) =>
      entry.paymentReference?.trim().toLowerCase() === paymentReference.toLowerCase()
    )) {
      return res.status(409).json({ message: "This supplier payment reference is already recorded" });
    }
    return res.status(400).json({ message: "Supplier payment cannot exceed the invoice balance" });
  }

  res.status(201).json({
    payment: updatedFulfillment.supplierPayments[updatedFulfillment.supplierPayments.length - 1],
    settlement: calculateSupplierInvoiceSettlement(
      updatedFulfillment.supplierInvoiceAmount!,
      updatedFulfillment.supplierPayments,
      updatedFulfillment.supplierInvoiceDueAt
    ),
    fulfillment: updatedFulfillment,
  });
});

router.post("/:orderId/fulfillment", requireWorkflowRole("operations"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (isAccountingLocked(order.accountingStatus)) return res.status(409).json({ message: "Supplier bookings are locked after accounting handoff" });

  const status = String(req.body?.status || "pending").toLowerCase();
  const supplierName = String(req.body?.supplierName || "").trim();
  const supplierReference = String(req.body?.supplierReference || "").trim();
  const allowedStatuses = ["pending", "booked", "in_progress", "completed", "cancelled"];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ message: "Invalid fulfillment status" });
  }
  if (supplierReference && !supplierName) {
    return res.status(400).json({ message: "Supplier name is required when a booking reference is provided" });
  }
  const duplicateFilter = buildSupplierReferenceDuplicateFilter(order._id, supplierName, supplierReference);
  if (status !== "cancelled" && duplicateFilter && await OrderFulfillment.exists(duplicateFilter)) {
    return res.status(409).json({ message: "This supplier booking reference is already used on this order" });
  }

  try {
    const item = await OrderFulfillment.create({
      orderId: order._id,
      supplierId: req.body?.supplierId || undefined,
      supplierName,
      supplierReference,
      serviceType: String(req.body?.serviceType || "other"),
      status,
      notes: String(req.body?.notes || ""),
      tasks: Array.isArray(req.body?.tasks) ? req.body.tasks : [],
    });
    return res.status(201).json(item);
  } catch (error) {
    const duplicateMessage = getDuplicateKeyMessage(error);
    if (duplicateMessage) {
      return res.status(409).json({ message: duplicateMessage });
    }
    throw error;
  }
});

router.patch("/:orderId/fulfillment/:fulfillmentId", requireWorkflowRole("operations"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (isAccountingLocked(order.accountingStatus)) return res.status(409).json({ message: "Supplier fulfillment is locked after accounting handoff" });

  const fulfillment = await OrderFulfillment.findOne({ _id: req.params.fulfillmentId, orderId: order._id });
  if (!fulfillment) return res.status(404).json({ message: "Fulfillment item not found" });

  const allowedStatuses = ["pending", "booked", "in_progress", "completed", "cancelled"];
  if (req.body?.status !== undefined && !allowedStatuses.includes(String(req.body.status))) {
    return res.status(400).json({ message: "Invalid fulfillment status" });
  }

  const nextSupplierName = String(req.body?.supplierName ?? fulfillment.supplierName ?? "").trim();
  const nextSupplierReference = String(req.body?.supplierReference ?? fulfillment.supplierReference ?? "").trim();
  const nextFulfillmentStatus = String(req.body?.status ?? fulfillment.status).toLowerCase();
  const nextOrderItemId = req.body?.orderItemId === null || req.body?.orderItemId === ""
    ? ""
    : String(req.body?.orderItemId ?? fulfillment.orderItemId ?? "");
  const hasInvoiceAmountUpdate = Object.prototype.hasOwnProperty.call(req.body || {}, "supplierInvoiceAmount");
  const rawInvoiceAmount = hasInvoiceAmountUpdate ? req.body.supplierInvoiceAmount : fulfillment.supplierInvoiceAmount;
  const nextInvoiceAmount = rawInvoiceAmount === null || rawInvoiceAmount === "" || rawInvoiceAmount === undefined
    ? undefined
    : Number(rawInvoiceAmount);
  const hasInvoiceDueDateUpdate = Object.prototype.hasOwnProperty.call(req.body || {}, "supplierInvoiceDueAt");
  const rawInvoiceDueDate = hasInvoiceDueDateUpdate ? req.body.supplierInvoiceDueAt : fulfillment.supplierInvoiceDueAt;
  const nextInvoiceDueAt = rawInvoiceDueDate === null || rawInvoiceDueDate === "" || rawInvoiceDueDate === undefined
    ? undefined
    : new Date(rawInvoiceDueDate);
  const nextInvoiceReference = String(req.body?.supplierInvoiceReference ?? fulfillment.supplierInvoiceReference ?? "").trim();

  if (nextFulfillmentStatus === "cancelled" && !canCancelSupplierFulfillment(
    nextInvoiceAmount,
    nextInvoiceReference,
    fulfillment.supplierPayments
  )) {
    return res.status(409).json({ message: "Clear the supplier invoice before cancelling this fulfillment" });
  }
  if (nextInvoiceDueAt && Number.isNaN(nextInvoiceDueAt.getTime())) {
    return res.status(400).json({ message: "Supplier invoice due date is invalid" });
  }
  if (nextInvoiceDueAt && nextInvoiceAmount === undefined) {
    return res.status(400).json({ message: "Record the supplier invoice amount before setting a due date" });
  }
  if (nextInvoiceAmount !== undefined && (!Number.isFinite(nextInvoiceAmount) || nextInvoiceAmount < 0)) {
    return res.status(400).json({ message: "Supplier invoice amount must be zero or greater" });
  }
  if (nextInvoiceAmount !== undefined && !nextOrderItemId) {
    return res.status(400).json({ message: "Link the fulfillment to an order service before entering an invoice amount" });
  }
  if (!nextOrderItemId && nextInvoiceReference) {
    return res.status(400).json({ message: "Link the fulfillment to an order service before entering an invoice reference" });
  }
  const supplierPaidTotal = fulfillment.supplierPayments.reduce((total, payment) => total + Number(payment.amount || 0), 0);
  if (fulfillment.supplierPayments.length && nextOrderItemId !== String(fulfillment.orderItemId || "")) {
    return res.status(409).json({ message: "A service link cannot change after supplier payments are recorded" });
  }
  if (fulfillment.supplierPayments.length && nextInvoiceReference !== String(fulfillment.supplierInvoiceReference || "")) {
    return res.status(409).json({ message: "The supplier invoice reference cannot change after payments are recorded" });
  }
  if (fulfillment.supplierPayments.length && nextInvoiceAmount === undefined) {
    return res.status(409).json({ message: "An invoice with recorded payments cannot be cleared" });
  }
  if (nextInvoiceAmount !== undefined && Math.round(nextInvoiceAmount * 100) < Math.round(supplierPaidTotal * 100)) {
    return res.status(400).json({ message: "Invoice amount cannot be less than supplier payments already recorded" });
  }
  const nextOrderItem = nextOrderItemId
    ? order.items.find((item) => String(item._id) === nextOrderItemId)
    : undefined;
  if (nextOrderItemId && !nextOrderItem) {
    return res.status(400).json({ message: "Linked service does not belong to this order" });
  }
  if (nextOrderItemId && nextFulfillmentStatus !== "cancelled") {
    const linkedElsewhere = await OrderFulfillment.exists({
      orderId: order._id,
      orderItemId: nextOrderItemId,
      _id: { $ne: fulfillment._id },
      $or: [
        { status: { $in: ["pending", "booked", "in_progress", "completed"] } },
        { supplierInvoiceAmount: { $exists: true } },
        { "supplierPayments.0": { $exists: true } },
      ],
    });
    if (linkedElsewhere) {
      return res.status(409).json({ message: "Another active fulfillment is already linked to this order service" });
    }
  }
  if (!nextOrderItemId && nextInvoiceAmount !== undefined) {
    return res.status(400).json({ message: "Clear the supplier invoice amount before unlinking this service" });
  }

  if (
    nextSupplierReference &&
    !nextSupplierName &&
    (req.body?.supplierName !== undefined || req.body?.supplierReference !== undefined)
  ) {
    return res.status(400).json({ message: "Supplier name is required when a booking reference is provided" });
  }
  const duplicateFilter = buildSupplierReferenceDuplicateFilter(
    order._id,
    nextSupplierName,
    nextSupplierReference,
    fulfillment._id
  );
  if (nextFulfillmentStatus !== "cancelled" && duplicateFilter && await OrderFulfillment.exists(duplicateFilter)) {
    return res.status(409).json({ message: "This supplier booking reference is already used on this order" });
  }

  const fields = ["supplierName", "supplierReference", "supplierInvoiceDueAt", "serviceType", "notes", "status", "bookedAt", "completedAt"] as const;
  const previousValues = {
    orderItemId: fulfillment.orderItemId,
    supplierName: fulfillment.supplierName,
    supplierReference: fulfillment.supplierReference,
    supplierInvoiceReference: fulfillment.supplierInvoiceReference,
    supplierInvoiceAmount: fulfillment.supplierInvoiceAmount,
    supplierInvoiceDueAt: fulfillment.supplierInvoiceDueAt,
    serviceType: fulfillment.serviceType,
    status: fulfillment.status,
    notes: fulfillment.notes,
    tasks: fulfillment.tasks.map((task) => ({ taskId: task.taskId, title: task.title, status: task.status })),
  };
  const updates: Record<string, unknown> = {};
  updates.orderItemId = nextOrderItemId || null;
  updates.supplierInvoiceReference = nextInvoiceReference;
  updates.supplierInvoiceAmount = nextInvoiceAmount ?? null;
  updates.supplierInvoiceDueAt = nextInvoiceDueAt ?? null;

  const previousItemCosts = order.items.map((item) => ({
    orderItemId: String(item._id),
    supplierCost: item.supplierCost,
    estimatedSupplierCost: item.estimatedSupplierCost,
  }));
  const originalOrderSupplierCost = Number(order.supplierCost || 0);
  const originalOrderStatus = order.status;
  const originalFulfillmentUpdatedAt = fulfillment.updatedAt?.getTime();
  const originalOrderUpdatedAt = order.updatedAt?.getTime();
  const previousOrderItemId = String(fulfillment.orderItemId || "");
  const previousInvoiceAmount = fulfillment.supplierInvoiceAmount;
  const costAssignmentChanged = previousOrderItemId !== nextOrderItemId || previousInvoiceAmount !== nextInvoiceAmount;
  if (costAssignmentChanged) {
    if (previousOrderItemId && previousInvoiceAmount !== undefined) {
      if (!setOrderItemActualSupplierCost(order, previousOrderItemId, undefined)) {
        return res.status(400).json({ message: "Previously linked order service was not found" });
      }
    }
    if (nextOrderItemId && nextInvoiceAmount !== undefined) {
      if (!setOrderItemActualSupplierCost(order, nextOrderItemId, nextInvoiceAmount)) {
        return res.status(400).json({ message: "Linked service could not accept the supplier invoice cost" });
      }
    }
  }

  for (const field of fields) {
    if (req.body?.[field] !== undefined) {
      const value = field === "supplierInvoiceDueAt"
        ? nextInvoiceDueAt
        : typeof req.body[field] === "string" && ["supplierName", "supplierReference", "serviceType", "notes", "status"].includes(field)
          ? req.body[field].trim()
          : req.body[field];
      updates[field] = value;
      fulfillment[field] = value;
    }
  }
  if (Array.isArray(req.body?.tasks)) {
    updates.tasks = req.body.tasks;
  }
  const changes = buildFulfillmentHistory(
    previousValues,
    updates,
    String(req.userId || "")
  );
  fulfillment.history = [...fulfillment.history, ...changes].slice(-50);
  fulfillment.orderItemId = nextOrderItemId || undefined;
  fulfillment.supplierInvoiceReference = nextInvoiceReference;
  fulfillment.supplierInvoiceAmount = nextInvoiceAmount;
  fulfillment.supplierInvoiceDueAt = nextInvoiceDueAt;
  if (Array.isArray(req.body?.tasks)) {
    fulfillment.tasks = req.body.tasks;
  }

  const nextStatus = deriveOrderStatusAfterSupplierBooking(
    order.status,
    String(req.body?.status ?? fulfillment.status)
  );
  order.status = nextStatus;

  const session = await mongoose.startSession();
  let savedFulfillment: typeof fulfillment | null = null;
  try {
    await session.withTransaction(async () => {
      const currentOrder = await Order.findOne({ _id: order._id, ownerId: req.userId }).session(session);
      const currentFulfillment = await OrderFulfillment.findOne({ _id: fulfillment._id, orderId: order._id }).session(session);
      if (!currentOrder || !currentFulfillment) {
        throw new Error("Order or fulfillment no longer exists");
      }

      if (
        currentOrder.updatedAt?.getTime() !== originalOrderUpdatedAt ||
        currentFulfillment.updatedAt?.getTime() !== originalFulfillmentUpdatedAt ||
        Number(currentOrder.supplierCost || 0) !== originalOrderSupplierCost ||
        currentOrder.status !== originalOrderStatus ||
        String(currentFulfillment.orderItemId || "") !== previousOrderItemId ||
        optionalAmount(currentFulfillment.supplierInvoiceAmount) !== optionalAmount(previousInvoiceAmount) ||
        currentFulfillment.supplierPayments.length !== fulfillment.supplierPayments.length
      ) {
        throw new Error("ORDER_FULFILLMENT_STALE");
      }

      if (costAssignmentChanged) {
        currentOrder.supplierCost = order.supplierCost;
        for (const previousItem of previousItemCosts) {
          const currentItem = currentOrder.items.find((item) => String(item._id) === previousItem.orderItemId);
          const stagedItem = order.items.find((item) => String(item._id) === previousItem.orderItemId);
          if (!currentItem || !stagedItem) throw new Error("ORDER_FULFILLMENT_STALE");
          if (
            Number(currentItem.supplierCost || 0) !== Number(previousItem.supplierCost || 0) ||
            optionalAmount(currentItem.estimatedSupplierCost) !== optionalAmount(previousItem.estimatedSupplierCost)
          ) {
            throw new Error("ORDER_FULFILLMENT_STALE");
          }
          currentItem.supplierCost = stagedItem.supplierCost;
          currentItem.estimatedSupplierCost = stagedItem.estimatedSupplierCost;
        }
      }

      currentOrder.status = order.status;
      currentFulfillment.orderItemId = fulfillment.orderItemId;
      currentFulfillment.supplierName = fulfillment.supplierName;
      currentFulfillment.supplierReference = fulfillment.supplierReference;
      currentFulfillment.supplierInvoiceReference = fulfillment.supplierInvoiceReference;
      currentFulfillment.supplierInvoiceAmount = fulfillment.supplierInvoiceAmount;
      currentFulfillment.supplierInvoiceDueAt = fulfillment.supplierInvoiceDueAt;
      currentFulfillment.serviceType = fulfillment.serviceType;
      currentFulfillment.status = fulfillment.status;
      currentFulfillment.bookedAt = fulfillment.bookedAt;
      currentFulfillment.completedAt = fulfillment.completedAt;
      currentFulfillment.notes = fulfillment.notes;
      currentFulfillment.tasks = fulfillment.tasks;
      currentFulfillment.history = fulfillment.history;

      if (costAssignmentChanged || currentOrder.status !== originalOrderStatus) {
        await currentOrder.save({ session });
      }
      await currentFulfillment.save({ session });
      savedFulfillment = currentFulfillment;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ORDER_FULFILLMENT_STALE") {
      return res.status(409).json({ message: "Order data changed while saving; reload and try again" });
    }
    const duplicateMessage = getDuplicateKeyMessage(error);
    if (duplicateMessage) {
      return res.status(409).json({ message: duplicateMessage });
    }
    throw error;
  } finally {
    await session.endSession();
  }

  res.json(savedFulfillment);
});

export default router;
