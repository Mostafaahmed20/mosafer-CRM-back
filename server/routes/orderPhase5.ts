import { Response, Router } from "express";
import { Order, setOrderItemActualSupplierCost } from "../models/Order.js";
import { OrderPackage, buildCustomerTripPack, summarizeOrderPackage, type IOrderPackageItem } from "../models/OrderPackage.js";
import { OrderTraveler } from "../models/OrderTraveler.js";
import { CustomerProfile } from "../models/CustomerProfile.js";
import { OrderFulfillment } from "../models/OrderFulfillment.js";
import { OrderPayment, calculateOrderPaymentTotals } from "../models/OrderPayment.js";
import { OrderAmendment } from "../models/OrderAmendment.js";
import { Card } from "../models/Card.js";
import { getAccountingReadiness, isAccountingLocked } from "../lib/accountingReadiness.js";
import { writeAuditEvent } from "../lib/audit.js";
import { getSocketInstance } from "../socket.js";
import { AuthRequest, authMiddleware, requireVerifiedEmail, requireWorkflowRole } from "../middleware/auth.js";

import { findAccessibleOrder, getAccessibleOrderFilter } from "../lib/orderAccess.js";

const router = Router();
router.use(authMiddleware, requireVerifiedEmail);

async function accountingReadinessForOrder(order: InstanceType<typeof Order>) {
  const [customer, pkg, fulfillments, payments, travelers] = await Promise.all([
    CustomerProfile.findOne({ _id: order.customerId, owner: order.ownerId }).select("agencyName location email"),
    OrderPackage.findOne({ orderId: order._id, status: { $ne: "cancelled" } }).sort({ updatedAt: -1 }),
    OrderFulfillment.find({ orderId: order._id, status: { $ne: "cancelled" } }),
    OrderPayment.find({ orderId: order._id }),
    OrderTraveler.find({ orderId: order._id }),
  ]);
  const paymentTotals = calculateOrderPaymentTotals(payments.map((payment) => ({ amount: payment.amount, status: payment.status })));
  const readiness = getAccountingReadiness({
    customer,
    package: pkg,
    items: order.items,
    fulfillments,
    currency: order.currency,
    balance: order.balance,
    customerPayments: { paid: paymentTotals.net, pending: paymentTotals.pending },
    travelerCount: travelers.length,
  });
  return { ...readiness, customer, pkg, fulfillments, paymentTotals, travelers };
}

async function syncLinkedCardAccounting(order: InstanceType<typeof Order>, updates: Record<string, unknown>, userId?: string) {
  const card = await Card.findOneAndUpdate({ orderId: order._id }, updates, { new: true }).populate("list", "board");
  const boardId = String((card?.list as any)?.board || "");
  if (card && boardId) {
    try {
      getSocketInstance().to(`board:${boardId}`).emit("card:updated", { card, userId });
    } catch {
      // The saved accounting state remains authoritative if realtime is unavailable.
    }
  }
}

router.get("/:orderId/accounting/readiness", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  const readiness = await accountingReadinessForOrder(order);
  res.json({ ready: readiness.ready, blockers: readiness.blockers, accountingStatus: order.accountingStatus });
});

router.get("/:orderId/amendments", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  const amendments = await OrderAmendment.find({ orderId: order._id }).sort({ createdAt: -1 });
  res.json({ amendments });
});

router.post("/:orderId/amendments", requireWorkflowRole("sales"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (order.accountingStatus !== "closed") return res.status(409).json({ message: "Amendments can only be requested after accounting has closed the sale" });
  const reason = String(req.body?.reason || "").trim();
  if (reason.length < 8) return res.status(400).json({ message: "Explain why the closed sale needs an amendment (at least 8 characters)" });
  const unresolved = await OrderAmendment.exists({ orderId: order._id, status: { $in: ["requested", "approved"] } });
  if (unresolved) return res.status(409).json({ message: "This sale already has an open amendment request" });
  const amendment = await OrderAmendment.create({
    orderId: order._id,
    reason,
    requestedBy: req.userId,
    beforeSnapshot: {
      customerTotal: order.customerTotal,
      supplierCost: order.supplierCost,
      grossMargin: order.grossMargin,
      amountPaid: order.amountPaid,
      balance: order.balance,
      currency: order.currency,
      items: order.items.map((item) => ({ description: item.description, quantity: item.quantity, salePrice: item.salePrice, supplierCost: item.supplierCost })),
    },
  });
  await writeAuditEvent({ req, action: "sale.amendment_requested", message: `Amendment requested for closed sale ${order.orderNumber}`, category: "finance", target: { id: amendment._id, type: "order_amendment", label: order.orderNumber }, meta: { orderId: String(order._id), reason } });
  res.status(201).json({ amendment });
});

router.post("/:orderId/amendments/:amendmentId/decision", requireWorkflowRole("accounting"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  const amendment = await OrderAmendment.findOne({ _id: req.params.amendmentId, orderId: order._id, status: "requested" });
  if (!amendment) return res.status(404).json({ message: "Open amendment request not found" });
  const decision = String(req.body?.decision || "").toLowerCase();
  if (decision !== "approve" && decision !== "reject") return res.status(400).json({ message: "Decision must be approve or reject" });
  if (order.accountingStatus !== "closed") return res.status(409).json({ message: "Sale is no longer closed; refresh before deciding this amendment" });
  amendment.status = decision === "approve" ? "approved" : "rejected";
  amendment.decisionBy = req.userId as any;
  amendment.decisionAt = new Date();
  amendment.decisionNotes = String(req.body?.notes || "").trim();
  await amendment.save();
  if (decision === "approve") {
    order.accountingStatus = "not_ready";
    order.accountingReference = "";
    order.accountingHandoffAt = undefined;
    order.accountingHandoffBy = undefined;
    order.accountingReceivedAt = undefined;
    order.accountingReceivedBy = undefined;
    await order.save();
    await syncLinkedCardAccounting(order, { status: "In Progress", accountingStatus: "Not ready", accountingReference: "" }, req.userId);
  }
  const auditAction = decision === "approve" ? "sale.amendment_approved" : "sale.amendment_rejected";
  await writeAuditEvent({ req, action: auditAction, message: `Amendment ${decision === "approve" ? "approved" : "rejected"} for sale ${order.orderNumber}`, category: "finance", target: { id: amendment._id, type: "order_amendment", label: order.orderNumber }, meta: { orderId: String(order._id), notes: amendment.decisionNotes } });
  res.json({ amendment, order });
});

router.post("/:orderId/accounting/handoff", requireWorkflowRole("sales"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (order.accountingStatus !== "not_ready") {
    return res.status(409).json({ message: `Order is already ${order.accountingStatus} in accounting` });
  }
  const readiness = await accountingReadinessForOrder(order);
  if (!readiness.ready) {
    return res.status(409).json({ message: "Complete the accounting checklist first", code: "ACCOUNTING_NOT_READY", blockers: readiness.blockers });
  }

  for (const fulfillment of readiness.fulfillments) {
    if (fulfillment.orderItemId && fulfillment.supplierInvoiceAmount !== undefined) {
      setOrderItemActualSupplierCost(order, String(fulfillment.orderItemId), fulfillment.supplierInvoiceAmount);
    }
  }
  await order.save();
  order.accountingStatus = "sent";
  order.accountingHandoffAt = new Date();
  order.accountingHandoffBy = req.userId;
  order.accountingSnapshot = {
    customerTotal: order.customerTotal,
    supplierCost: order.supplierCost,
    grossMargin: order.grossMargin,
    amountPaid: readiness.paymentTotals.net,
    balance: order.balance,
    currency: order.currency,
    capturedAt: new Date(),
  };
  await order.save();
  await syncLinkedCardAccounting(order, { accountingStatus: "Sent to accounting" }, req.userId);
  await writeAuditEvent({
    req,
    action: "accounting.handoff",
    message: `Order ${order.orderNumber} handed to accounting`,
    category: "finance",
    target: { id: order._id, type: "order", label: order.orderNumber },
    meta: { ...order.accountingSnapshot },
  });
  res.json({ order, snapshot: order.accountingSnapshot });
});

router.post("/:orderId/accounting/receive", requireWorkflowRole("accounting"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (order.accountingStatus !== "sent") return res.status(409).json({ message: "Only a handed-off order can be received by accounting" });
  const reference = String(req.body?.accountingReference || "").trim();
  if (!reference) return res.status(400).json({ message: "Accounting reference is required" });

  order.accountingStatus = "received";
  order.accountingReference = reference;
  order.accountingNotes = String(req.body?.accountingNotes || order.accountingNotes || "").trim();
  order.accountingReceivedAt = new Date();
  order.accountingReceivedBy = req.userId;
  await order.save();
  await syncLinkedCardAccounting(order, { accountingStatus: "Accounting received", accountingReference: reference, accountingNotes: order.accountingNotes }, req.userId);
  await writeAuditEvent({ req, action: "accounting.received", message: `Accounting received order ${order.orderNumber}`, category: "finance", target: { id: order._id, type: "order", label: order.orderNumber }, meta: { accountingReference: reference } });
  res.json({ order });
});

router.post("/:orderId/accounting/close", requireWorkflowRole("accounting"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (order.accountingStatus !== "received") return res.status(409).json({ message: "Accounting must receive the order before it can be closed" });
  if (order.balance > 0.009) return res.status(409).json({ message: "Settle the customer balance before closing the sale" });

  const fulfillments = await OrderFulfillment.find({ orderId: order._id, status: { $ne: "cancelled" } });
  const openSupplierBalance = fulfillments.some((item) => {
    if (item.supplierInvoiceAmount === undefined) return true;
    const paid = item.supplierPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    return paid + 0.009 < item.supplierInvoiceAmount || item.status !== "completed";
  });
  if (openSupplierBalance) return res.status(409).json({ message: "Complete supplier services and settle all supplier invoices before closing the sale" });

  order.accountingStatus = "closed";
  order.accountingClosedAt = new Date();
  order.accountingClosedBy = req.userId;
  await order.save();
  const completedAmendment = await OrderAmendment.findOne({ orderId: order._id, status: "approved" }).sort({ createdAt: -1 });
  if (completedAmendment) {
    completedAmendment.status = "completed";
    completedAmendment.completedAt = new Date();
    completedAmendment.afterSnapshot = {
      customerTotal: order.customerTotal,
      supplierCost: order.supplierCost,
      grossMargin: order.grossMargin,
      amountPaid: order.amountPaid,
      balance: order.balance,
      currency: order.currency,
      items: order.items.map((item) => ({ description: item.description, quantity: item.quantity, salePrice: item.salePrice, supplierCost: item.supplierCost })),
    };
    await completedAmendment.save();
  }
  await syncLinkedCardAccounting(order, { status: "Closed", accountingStatus: "Closed" }, req.userId);
  await writeAuditEvent({ req, action: "sale.closed", message: `Closed sale ${order.orderNumber}`, category: "finance", target: { id: order._id, type: "order", label: order.orderNumber }, meta: { ...(order.accountingSnapshot || {}), accountingReference: order.accountingReference } });
  res.json({ order });
});

const VALID_PACKAGE_STATUSES = ["draft", "ready", "confirmed", "in_travel", "completed", "cancelled"] as const;

type OrderPackageStatusValue = (typeof VALID_PACKAGE_STATUSES)[number];

function isPackageStatus(value: unknown): value is OrderPackageStatusValue {
  return typeof value === "string" && VALID_PACKAGE_STATUSES.includes(value as OrderPackageStatusValue);
}

function normalizePackageItems(items: unknown): IOrderPackageItem[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => ({
    title: String(item?.title || item?.description || "Travel service").trim() || "Travel service",
    serviceType: String(item?.serviceType || item?.productType || "other").trim() || "other",
    startDate: item?.startDate ? new Date(item.startDate) : undefined,
    endDate: item?.endDate ? new Date(item.endDate) : undefined,
    supplierName: String(item?.supplierName || ""),
    supplierReference: String(item?.supplierReference || ""),
    notes: String(item?.notes || ""),
  }));
}

function derivePackageRange(items: IOrderPackageItem[]) {
  const starts = items.map((item) => item.startDate ? new Date(item.startDate) : undefined).filter((date): date is Date => Boolean(date && !Number.isNaN(date.getTime())));
  const ends = items.map((item) => item.endDate ? new Date(item.endDate) : undefined).filter((date): date is Date => Boolean(date && !Number.isNaN(date.getTime())));
  return {
    startDate: starts.length ? new Date(Math.min(...starts.map((date) => date.getTime()))) : undefined,
    endDate: ends.length ? new Date(Math.max(...ends.map((date) => date.getTime()))) : undefined,
  };
}

router.get("/:orderId/trip-pack", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  await order.populate("customerId", "customerName agencyName email");

  const pkg = await OrderPackage.findOne({ orderId: order._id, status: { $ne: "cancelled" } })
    .sort({ updatedAt: -1 });
  const travelerFilter = pkg?.travelerIds.length
    ? { _id: { $in: pkg.travelerIds }, orderId: order._id }
    : { orderId: order._id };
  const travelers = await OrderTraveler.find(travelerFilter).sort({ lastName: 1, firstName: 1 });
  const customer = typeof order.customerId === "object" && order.customerId !== null
    ? order.customerId as unknown as { customerName?: string; agencyName?: string; email?: string }
    : null;

  res.json(buildCustomerTripPack({
    order: order.toObject(),
    customer,
    package: pkg?.toObject() || null,
    travelers: travelers.map((traveler) => ({
      _id: traveler._id,
      firstName: traveler.firstName,
      lastName: traveler.lastName,
    })),
  }));
});

router.get("/:orderId/packages", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });

  const packages = await OrderPackage.find({ orderId: order._id }).sort({ createdAt: -1 });
  res.json({
    items: packages,
    summaries: packages.map((pkg) => summarizeOrderPackage({
      packageId: String(pkg._id),
      packageName: pkg.packageName,
      status: pkg.status,
      travelerCount: pkg.travelerIds?.length || 0,
      items: pkg.items,
      startDate: pkg.startDate,
      endDate: pkg.endDate,
    })),
  });
});

router.get("/:orderId/packages/:packageId", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });

  const pkg = await OrderPackage.findOne({ _id: req.params.packageId, orderId: order._id });
  if (!pkg) return res.status(404).json({ message: "Package not found" });

  res.json({
    package: pkg,
    summary: summarizeOrderPackage({
      packageId: String(pkg._id),
      packageName: pkg.packageName,
      status: pkg.status,
      travelerCount: pkg.travelerIds?.length || 0,
      items: pkg.items,
      startDate: pkg.startDate,
      endDate: pkg.endDate,
    }),
  });
});

router.post("/:orderId/packages", requireWorkflowRole("operations"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (isAccountingLocked(order.accountingStatus)) return res.status(409).json({ message: "Packages are locked after accounting handoff" });

  const travelerIds = Array.isArray(req.body?.travelerIds)
    ? req.body.travelerIds.filter((id: unknown) => Boolean(id))
    : [];

  if (travelerIds.length) {
    const validTravelers = await OrderTraveler.countDocuments({
      _id: { $in: travelerIds },
      orderId: order._id,
    });

    if (validTravelers !== travelerIds.length) {
      return res.status(400).json({ message: "One or more traveler IDs do not belong to this order" });
    }
  }

  const requestedStatus = req.body?.status;
  const resolvedStatus: OrderPackageStatusValue = isPackageStatus(requestedStatus)
    ? requestedStatus
    : "draft";

  const items = normalizePackageItems(req.body?.items);
  const range = derivePackageRange(items);
  const pkg = await OrderPackage.create({
    orderId: order._id,
    packageName: String(req.body?.packageName || order.orderNumber || "Travel package").trim() || "Travel package",
    status: resolvedStatus,
    startDate: req.body?.startDate ? new Date(req.body.startDate) : range.startDate,
    endDate: req.body?.endDate ? new Date(req.body.endDate) : range.endDate,
    summary: String(req.body?.summary || ""),
    items,
    travelerIds,
  });

  res.status(201).json({
    package: pkg,
    summary: summarizeOrderPackage({
      packageId: String(pkg._id),
      packageName: pkg.packageName,
      status: pkg.status,
      travelerCount: pkg.travelerIds?.length || 0,
      items: pkg.items,
      startDate: pkg.startDate,
      endDate: pkg.endDate,
    }),
  });
});

router.patch("/:orderId/packages/:packageId", requireWorkflowRole("operations"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.orderId, String(req.userId));
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (isAccountingLocked(order.accountingStatus)) return res.status(409).json({ message: "Packages are locked after accounting handoff" });

  const pkg = await OrderPackage.findOne({ _id: req.params.packageId, orderId: order._id });
  if (!pkg) return res.status(404).json({ message: "Package not found" });

  const nextTravelerIds = Array.isArray(req.body?.travelerIds) ? req.body.travelerIds.filter((id: unknown) => Boolean(id)) : pkg.travelerIds;
  if (nextTravelerIds.length) {
    const validTravelers = await OrderTraveler.countDocuments({
      _id: { $in: nextTravelerIds },
      orderId: order._id,
    });

    if (validTravelers !== nextTravelerIds.length) {
      return res.status(400).json({ message: "One or more traveler IDs do not belong to this order" });
    }
  }

  const nextStatus = isPackageStatus(req.body?.status) ? req.body.status : pkg.status;

  const nextItems = Array.isArray(req.body?.items) ? normalizePackageItems(req.body.items) : pkg.items;
  const derivedRange = derivePackageRange(nextItems);
  const nextPackage = {
    packageName: req.body?.packageName !== undefined ? String(req.body.packageName).trim() || pkg.packageName : pkg.packageName,
    status: nextStatus,
    startDate: req.body?.startDate !== undefined ? (req.body.startDate ? new Date(req.body.startDate) : derivedRange.startDate) : (pkg.startDate || derivedRange.startDate),
    endDate: req.body?.endDate !== undefined ? (req.body.endDate ? new Date(req.body.endDate) : derivedRange.endDate) : (pkg.endDate || derivedRange.endDate),
    summary: req.body?.summary !== undefined ? String(req.body.summary || "") : pkg.summary,
    items: nextItems,
    travelerIds: Array.isArray(req.body?.travelerIds) ? nextTravelerIds : pkg.travelerIds,
  };

  Object.assign(pkg, nextPackage);
  await pkg.save();

  res.json({
    package: pkg,
    summary: summarizeOrderPackage({
      packageName: pkg.packageName,
      status: pkg.status,
      travelerCount: pkg.travelerIds?.length || 0,
      items: pkg.items,
      startDate: pkg.startDate,
      endDate: pkg.endDate,
    }),
  });
});

export default router;
