import { Response, Router } from "express";
import { Order, ORDER_STATUSES, ORDER_ITEM_PRODUCT_TYPES, calculateOrderSupplierCost } from "../models/Order.js";
import { OrderFulfillment, calculateSupplierInvoiceSettlement } from "../models/OrderFulfillment.js";
import { AuthRequest, authMiddleware, requireVerifiedEmail, requireWorkflowRole } from "../middleware/auth.js";
import { isAccountingLocked } from "../lib/accountingReadiness.js";
import { writeAuditEvent } from "../lib/audit.js";

import { findAccessibleOrder, getAccessibleOrderFilter } from "../lib/orderAccess.js";
import { describeLedgerDerivedOrderFields, getLedgerDerivedOrderFields } from "../lib/orderFinancialInput.js";
import { nextReservationReference } from "../models/Counter.js";

const router = Router();
router.use(authMiddleware, requireVerifiedEmail);

function asNumber(value: unknown, fallback = 0) {
  const amount = Number(value ?? fallback);
  return Number.isFinite(amount) ? amount : fallback;
}

function sanitizeOrderPayload(body: Record<string, any>, preserveItemIds = false) {
  const itemPayload = Array.isArray(body.items) ? body.items : [];
  const normalizedItems = itemPayload.map((item) => ({
    ...(preserveItemIds && item?._id ? { _id: item._id } : {}),
    productType: ORDER_ITEM_PRODUCT_TYPES.includes(item?.productType) ? item.productType : "other",
    description: String(item?.description || "Order item").trim(),
    quantity: Math.max(1, Number(item?.quantity ?? 1)),
    salePrice: asNumber(item?.salePrice),
    ...(item?.supplierCost !== undefined ? { supplierCost: asNumber(item.supplierCost) } : {}),
    tax: asNumber(item?.tax),
    commission: asNumber(item?.commission),
    status: ORDER_STATUSES.includes(item?.status) ? item.status : "draft",
    serviceStart: item?.serviceStart ? new Date(item.serviceStart) : undefined,
    serviceEnd: item?.serviceEnd ? new Date(item.serviceEnd) : undefined,
    supplierReference: String(item?.supplierReference || ""),
    metadata: item?.metadata ?? {},
  }));

  return {
    customerId: body.customerId,
    branchId: body.branchId,
    currency: String(body.currency || "USD").toUpperCase(),
    status: ORDER_STATUSES.includes(body.status) ? body.status : "draft",
    salesChannel: String(body.salesChannel || "direct"),
    saleSubtotal: asNumber(body.saleSubtotal),
    taxes: asNumber(body.taxes),
    serviceFees: asNumber(body.serviceFees),
    markup: asNumber(body.markup),
    discounts: asNumber(body.discounts),
    supplierTaxes: asNumber(body.supplierTaxes),
    paymentFees: asNumber(body.paymentFees),
    source: String(body.source || "manual"),
    travelDate: body.travelDate ? new Date(body.travelDate) : undefined,
    items: normalizedItems,
  };
}

router.get("/", async (req: AuthRequest, res: Response) => {
  const orders = await Order.find(await getAccessibleOrderFilter(String(req.userId)))
    .populate("customerId", "customerName agencyName email")
    .sort({ updatedAt: -1 })
    .limit(200);
  res.json(orders);
});

router.get("/supplier-payables", async (req: AuthRequest, res: Response) => {
  const requestedStatus = String(req.query.status || "open");
  if (!["open", "overdue", "paid", "all"].includes(requestedStatus)) {
    return res.status(400).json({ message: "Invalid supplier invoice status filter" });
  }

  const orders = await Order.find(await getAccessibleOrderFilter(String(req.userId)))
    .populate("customerId", "customerName agencyName email")
    .select("orderNumber customerId currency items")
    .sort({ updatedAt: -1 });
  const ordersById = new Map(orders.map((order) => [String(order._id), order]));
  if (!orders.length) return res.json({ items: [], total: 0 });

  const fulfillments = await OrderFulfillment.find({
    orderId: { $in: orders.map((order) => order._id) },
    supplierInvoiceAmount: { $exists: true },
  }).sort({ supplierInvoiceDueAt: 1, updatedAt: -1 });

  const items = fulfillments.flatMap((fulfillment) => {
    const order = ordersById.get(String(fulfillment.orderId));
    if (!order || fulfillment.supplierInvoiceAmount === undefined) return [];

    const settlement = calculateSupplierInvoiceSettlement(
      fulfillment.supplierInvoiceAmount,
      fulfillment.supplierPayments,
      fulfillment.supplierInvoiceDueAt
    );
    const matchesStatus = requestedStatus === "all"
      || (requestedStatus === "open" && settlement.status !== "paid")
      || settlement.status === requestedStatus;
    if (!matchesStatus) return [];

    const service = order.items.find((item) => String(item._id) === String(fulfillment.orderItemId || ""));
    return [{
      fulfillmentId: fulfillment._id,
      orderId: order._id,
      orderNumber: order.orderNumber,
      customer: order.customerId,
      currency: fulfillment.supplierInvoiceCurrency || order.currency,
      supplierName: fulfillment.supplierName || "Supplier",
      invoiceReference: fulfillment.supplierInvoiceReference || "",
      invoiceAmount: fulfillment.supplierInvoiceAmount,
      dueAt: fulfillment.supplierInvoiceDueAt,
      serviceDescription: service?.description || fulfillment.serviceType || "Travel service",
      settlement,
      fulfillmentStatus: fulfillment.status,
    }];
  });

  res.json({ items, total: items.length });
});

router.get("/:id", async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.id, String(req.userId));
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }
  await order.populate("customerId", "customerName agencyName email");
  res.json(order);
});

router.post("/", requireWorkflowRole("sales"), async (req: AuthRequest, res: Response) => {
  try {
    const ledgerFields = getLedgerDerivedOrderFields(req.body || {});
    if (ledgerFields.length) {
      return res.status(400).json({ message: `Cannot set derived order financial fields: ${describeLedgerDerivedOrderFields(ledgerFields)}.` });
    }
    const payload = sanitizeOrderPayload(req.body || {});
    if (!payload.customerId) {
      return res.status(400).json({ message: "customerId is required" });
    }

    const order = await Order.create({
      ...payload,
      supplierCost: calculateOrderSupplierCost(payload.items),
      ownerId: req.userId,
      orderNumber: `ORD-${Date.now()}`,
      reservationRef: await nextReservationReference(),
    });

    res.status(201).json(order);
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "Order number already exists" });
    }
    res.status(500).json({ message: error?.message || "Unable to create order" });
  }
});

router.patch("/:id", requireWorkflowRole("sales"), async (req: AuthRequest, res: Response) => {
  const ledgerFields = getLedgerDerivedOrderFields(req.body || {});
  if (ledgerFields.length) {
    return res.status(400).json({ message: `Cannot set derived order financial fields: ${describeLedgerDerivedOrderFields(ledgerFields)}.` });
  }
  const order = await findAccessibleOrder(req.params.id, String(req.userId));
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }
  if (isAccountingLocked(order.accountingStatus)) {
    return res.status(409).json({ message: "Order financials are locked after accounting handoff; reopen the sale through an amendment workflow" });
  }

  const beforeSnapshot = {
    customerTotal: order.customerTotal,
    supplierCost: order.supplierCost,
    grossMargin: order.grossMargin,
    currency: order.currency,
    items: order.items.map((item) => ({ description: item.description, quantity: item.quantity, salePrice: item.salePrice, supplierCost: item.supplierCost })),
  };

  const payload = sanitizeOrderPayload(req.body || {}, true);
  if (Array.isArray(req.body?.items)) {
    const linkedFulfillments = await OrderFulfillment.find({
      orderId: order._id,
      orderItemId: { $exists: true },
    }).select("orderItemId");
    const incomingItemIds = new Set(payload.items.map((item) => String(item._id || "")));
    const orphanedLink = linkedFulfillments.find((fulfillment) => !incomingItemIds.has(String(fulfillment.orderItemId)));
    if (orphanedLink) {
      return res.status(409).json({ message: "Unlink supplier fulfillments before removing their order services" });
    }
  }

  const normalizedItems = Array.isArray(req.body?.items)
    ? payload.items.map((item) => {
        const existing = order.items.find((entry) => item._id && String(entry._id) === String(item._id));
        if (!existing) {
          const { _id: _ignoredItemId, ...newItem } = item;
          return newItem;
        }
        return {
          ...item,
          _id: existing._id,
          supplierCost: existing.estimatedSupplierCost === undefined ? (item.supplierCost ?? existing.supplierCost) : existing.supplierCost,
          estimatedSupplierCost: existing.estimatedSupplierCost,
        };
      })
    : order.items;

  Object.assign(order, {
    customerId: req.body.customerId ?? order.customerId,
    branchId: req.body.branchId ?? order.branchId,
    currency: req.body.currency ? String(req.body.currency).toUpperCase() : order.currency,
    status: ORDER_STATUSES.includes(req.body.status) ? req.body.status : order.status,
    salesChannel: req.body.salesChannel ?? order.salesChannel,
    saleSubtotal: asNumber(req.body.saleSubtotal ?? order.saleSubtotal),
    taxes: asNumber(req.body.taxes ?? order.taxes),
    serviceFees: asNumber(req.body.serviceFees ?? order.serviceFees),
    markup: asNumber(req.body.markup ?? order.markup),
    discounts: asNumber(req.body.discounts ?? order.discounts),
    supplierTaxes: asNumber(req.body.supplierTaxes ?? order.supplierTaxes),
    paymentFees: asNumber(req.body.paymentFees ?? order.paymentFees),
    source: req.body.source ?? order.source,
    travelDate: req.body.travelDate ? new Date(req.body.travelDate) : order.travelDate,
    items: normalizedItems,
  });
  if (Array.isArray(req.body?.items)) {
    order.supplierCost = calculateOrderSupplierCost(normalizedItems);
  }

  await order.save();
  if (req.body?.items !== undefined || ["saleSubtotal", "taxes", "serviceFees", "markup", "discounts", "supplierTaxes", "paymentFees"].some((key) => req.body?.[key] !== undefined)) {
    await writeAuditEvent({
      req,
      action: "order.financials_updated",
      message: `Updated financial details for order ${order.orderNumber}`,
      category: "finance",
      target: { id: order._id, type: "order", label: order.orderNumber },
      meta: {
        before: beforeSnapshot,
        after: {
          customerTotal: order.customerTotal,
          supplierCost: order.supplierCost,
          grossMargin: order.grossMargin,
          currency: order.currency,
          items: order.items.map((item) => ({ description: item.description, quantity: item.quantity, salePrice: item.salePrice, supplierCost: item.supplierCost })),
        },
      },
    });
  }
  res.json(order);
});

router.post("/:id/items", requireWorkflowRole("sales"), async (req: AuthRequest, res: Response) => {
  const order = await findAccessibleOrder(req.params.id, String(req.userId));
  if (!order) {
    return res.status(404).json({ message: "Order not found" });
  }
  if (isAccountingLocked(order.accountingStatus)) {
    return res.status(409).json({ message: "Order services are locked after accounting handoff" });
  }

  const item = {
    productType: ORDER_ITEM_PRODUCT_TYPES.includes(req.body?.productType) ? req.body.productType : "other",
    description: String(req.body?.description || "Order item").trim(),
    quantity: Math.max(1, Number(req.body?.quantity ?? 1)),
    salePrice: asNumber(req.body?.salePrice),
    supplierCost: asNumber(req.body?.supplierCost),
    tax: asNumber(req.body?.tax),
    commission: asNumber(req.body?.commission),
    status: ORDER_STATUSES.includes(req.body?.status) ? req.body.status : "draft",
    serviceStart: req.body?.serviceStart ? new Date(req.body.serviceStart) : undefined,
    serviceEnd: req.body?.serviceEnd ? new Date(req.body.serviceEnd) : undefined,
    supplierReference: String(req.body?.supplierReference || ""),
    metadata: req.body?.metadata ?? {},
  };

  order.items.push(item as any);
  order.supplierCost = calculateOrderSupplierCost(order.items);
  await order.save();
  res.status(201).json(order);
});

export default router;
