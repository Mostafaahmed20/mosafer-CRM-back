import mongoose, { Document } from "mongoose";

export const ORDER_STATUSES = [
  "draft",
  "quoted",
  "awaiting_customer",
  "reserved",
  "partially_paid",
  "confirmed",
  "ticketed_vouchered",
  "in_travel",
  "completed",
  "cancelled",
  "refunded",
] as const;

export const ORDER_ITEM_PRODUCT_TYPES = [
  "flight",
  "hotel",
  "package",
  "transfer",
  "insurance",
  "activity",
  "other",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderItemProductType = (typeof ORDER_ITEM_PRODUCT_TYPES)[number];
export const ORDER_ACCOUNTING_STATUSES = ["not_ready", "sent", "received", "closed"] as const;
export type OrderAccountingStatus = (typeof ORDER_ACCOUNTING_STATUSES)[number];

export function deriveOrderStatusAfterPayment(currentStatus: OrderStatus, amountPaid: number): OrderStatus {
  const eligibleStatuses: OrderStatus[] = ["draft", "quoted", "awaiting_customer"];
  if (Number(amountPaid || 0) > 0 && eligibleStatuses.includes(currentStatus)) {
    return "partially_paid";
  }
  return currentStatus;
}

export function deriveOrderStatusAfterSupplierBooking(currentStatus: OrderStatus, bookingStatus: string): OrderStatus {
  const normalizedStatus = String(bookingStatus).toLowerCase();
  const eligibleStatuses: OrderStatus[] = ["draft", "quoted", "awaiting_customer", "partially_paid"];

  if (normalizedStatus === "booked" && eligibleStatuses.includes(currentStatus)) {
    return "reserved";
  }

  return currentStatus;
}

export interface IOrderStatusHistoryItem {
  status: OrderStatus;
  reason?: string;
  changedBy?: string;
  changedAt: Date;
}

export interface IOrderItem extends Document {
  orderId?: mongoose.Types.ObjectId;
  productType: OrderItemProductType;
  description: string;
  quantity: number;
  salePrice: number;
  supplierCost: number;
  estimatedSupplierCost?: number;
  tax: number;
  commission: number;
  status: string;
  serviceStart?: Date;
  serviceEnd?: Date;
  supplierReference?: string;
  metadata?: Record<string, unknown>;
}

export interface IOrder extends Document {
  orderNumber: string;
  reservationRef?: string;
  customerId: mongoose.Types.ObjectId | string;
  branchId?: mongoose.Types.ObjectId | string;
  ownerId: mongoose.Types.ObjectId | string;
  currency: string;
  status: OrderStatus;
  accountingStatus: OrderAccountingStatus;
  accountingReference?: string;
  accountingNotes?: string;
  accountingHandoffAt?: Date;
  accountingHandoffBy?: mongoose.Types.ObjectId | string;
  accountingReceivedAt?: Date;
  accountingReceivedBy?: mongoose.Types.ObjectId | string;
  accountingClosedAt?: Date;
  accountingClosedBy?: mongoose.Types.ObjectId | string;
  accountingSnapshot?: {
    customerTotal: number;
    supplierCost: number;
    grossMargin: number;
    amountPaid: number;
    balance: number;
    currency: string;
    capturedAt: Date;
  };
  salesChannel?: string;
  saleSubtotal: number;
  taxes: number;
  serviceFees: number;
  markup: number;
  discounts: number;
  customerTotal: number;
  supplierCost: number;
  supplierTaxes: number;
  paymentFees: number;
  totalCost: number;
  grossMargin: number;
  amountPaid: number;
  balance: number;
  source?: string;
  sourceCardId?: mongoose.Types.ObjectId | string;
  sourceQuotationId?: mongoose.Types.ObjectId | string;
  sourceBoardId?: mongoose.Types.ObjectId | string;
  sourceListId?: mongoose.Types.ObjectId | string;
  travelDate?: Date;
  statusHistory: IOrderStatusHistoryItem[];
  items: IOrderItem[];
  createdAt?: Date;
  updatedAt?: Date;
}

export function calculateOrderMetrics(input: {
  saleSubtotal: number;
  taxes: number;
  serviceFees: number;
  markup: number;
  discounts: number;
  supplierCost: number;
  supplierTaxes: number;
  paymentFees: number;
  amountPaid: number;
}) {
  const saleSubtotal = Number(input.saleSubtotal || 0);
  const taxes = Number(input.taxes || 0);
  const serviceFees = Number(input.serviceFees || 0);
  const markup = Number(input.markup || 0);
  const discounts = Number(input.discounts || 0);
  const supplierCost = Number(input.supplierCost || 0);
  const supplierTaxes = Number(input.supplierTaxes || 0);
  const paymentFees = Number(input.paymentFees || 0);
  const amountPaid = Number(input.amountPaid || 0);

  const customerTotal = saleSubtotal - taxes - serviceFees - markup - discounts;
  const totalCost = supplierCost + supplierTaxes + paymentFees;
  const grossMargin = customerTotal - totalCost;
  const balance = customerTotal - amountPaid;

  return {
    customerTotal,
    totalCost,
    grossMargin,
    balance,
  };
}

export function calculateOrderSupplierCost(items: Array<{ quantity?: number; supplierCost?: number }> = []) {
  const total = items.reduce((sum, item) => {
    const rawQuantity = Number(item.quantity || 1);
    const quantity = Number.isFinite(rawQuantity) ? Math.max(1, rawQuantity) : 1;
    const unitCost = Number(item.supplierCost || 0);
    return sum + (Number.isFinite(unitCost) ? unitCost : 0) * quantity;
  }, 0);
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

type SupplierCostOrder = {
  supplierCost: number;
  items: Array<{
    _id: unknown;
    quantity?: number;
    supplierCost: number;
    estimatedSupplierCost?: number;
  }>;
};

export function setOrderItemActualSupplierCost(
  order: SupplierCostOrder,
  orderItemId: string,
  actualSupplierCost: number | undefined
): boolean {
  const item = order.items.find((entry) => String(entry._id) === orderItemId);
  if (!item) return false;
  if (actualSupplierCost !== undefined && (!Number.isFinite(actualSupplierCost) || actualSupplierCost < 0)) return false;

  const quantity = Math.max(1, Number(item.quantity || 1));
  const previousUnitCost = Number(item.supplierCost || 0);
  let nextUnitCost: number;
  if (actualSupplierCost === undefined) {
    nextUnitCost = Number(item.estimatedSupplierCost ?? previousUnitCost);
    delete item.estimatedSupplierCost;
  } else {
    if (item.estimatedSupplierCost === undefined) {
      item.estimatedSupplierCost = previousUnitCost;
    }
    // Invoice amounts are line totals; order item supplierCost is a per-unit rate.
    nextUnitCost = actualSupplierCost / quantity;
  }

  item.supplierCost = nextUnitCost;
  order.supplierCost = Number(order.supplierCost || 0) + (nextUnitCost - previousUnitCost) * quantity;
  return true;
}

const statusHistorySchema = new mongoose.Schema<IOrderStatusHistoryItem>(
  {
    status: { type: String, enum: ORDER_STATUSES, required: true },
    reason: { type: String, default: "" },
    changedBy: { type: String, default: "" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const orderItemSchema = new mongoose.Schema<IOrderItem>(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", index: true },
    productType: { type: String, enum: ORDER_ITEM_PRODUCT_TYPES, required: true },
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1, min: 1 },
    salePrice: { type: Number, default: 0, min: 0 },
    supplierCost: { type: Number, default: 0, min: 0 },
    estimatedSupplierCost: { type: Number, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    commission: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      default: "draft",
      enum: ORDER_STATUSES,
    },
    serviceStart: { type: Date },
    serviceEnd: { type: Date },
    supplierReference: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

const orderSchema = new mongoose.Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true, trim: true },
    reservationRef: { type: String, trim: true, default: undefined },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerProfile", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    currency: { type: String, default: "USD", uppercase: true, trim: true },
    status: { type: String, enum: ORDER_STATUSES, default: "draft" },
    accountingStatus: { type: String, enum: ORDER_ACCOUNTING_STATUSES, default: "not_ready", index: true },
    accountingReference: { type: String, default: "", trim: true },
    accountingNotes: { type: String, default: "" },
    accountingHandoffAt: { type: Date },
    accountingHandoffBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    accountingReceivedAt: { type: Date },
    accountingReceivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    accountingClosedAt: { type: Date },
    accountingClosedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    accountingSnapshot: {
      customerTotal: { type: Number },
      supplierCost: { type: Number },
      grossMargin: { type: Number },
      amountPaid: { type: Number },
      balance: { type: Number },
      currency: { type: String, uppercase: true },
      capturedAt: { type: Date },
    },
    salesChannel: { type: String, default: "direct" },
    saleSubtotal: { type: Number, default: 0 },
    taxes: { type: Number, default: 0 },
    serviceFees: { type: Number, default: 0 },
    markup: { type: Number, default: 0 },
    discounts: { type: Number, default: 0 },
    customerTotal: { type: Number, default: 0 },
    supplierCost: { type: Number, default: 0 },
    supplierTaxes: { type: Number, default: 0 },
    paymentFees: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },
    grossMargin: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    source: { type: String, default: "manual" },
    sourceCardId: { type: mongoose.Schema.Types.ObjectId, ref: "Card", unique: true, sparse: true },
    sourceQuotationId: { type: mongoose.Schema.Types.ObjectId, ref: "Quotation" },
    sourceBoardId: { type: mongoose.Schema.Types.ObjectId, ref: "Board" },
    sourceListId: { type: mongoose.Schema.Types.ObjectId, ref: "List" },
    travelDate: { type: Date },
    statusHistory: { type: [statusHistorySchema], default: [] },
    items: { type: [orderItemSchema], default: [] },
  },
  { timestamps: true }
);

orderSchema.pre("validate", function computeTotals(next) {
  const totals = calculateOrderMetrics({
    saleSubtotal: this.saleSubtotal,
    taxes: this.taxes,
    serviceFees: this.serviceFees,
    markup: this.markup,
    discounts: this.discounts,
    supplierCost: this.supplierCost,
    supplierTaxes: this.supplierTaxes,
    paymentFees: this.paymentFees,
    amountPaid: this.amountPaid,
  });

  this.customerTotal = totals.customerTotal;
  this.totalCost = totals.totalCost;
  this.grossMargin = totals.grossMargin;
  this.balance = totals.balance;

  if (!this.orderNumber) {
    this.orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  next();
});

orderSchema.pre("save", function appendStatusHistory(next) {
  if (!this.isModified("status")) {
    return next();
  }

  const existingStatus = this.statusHistory?.[this.statusHistory.length - 1]?.status;
  if (!existingStatus || existingStatus !== this.status) {
    this.statusHistory = [
      ...(this.statusHistory || []),
      {
        status: this.status,
        reason: "status updated",
        changedAt: new Date(),
      },
    ];
  }

  next();
});

orderSchema.index({ reservationRef: 1 }, { unique: true, sparse: true });

export const Order = mongoose.model<IOrder>("Order", orderSchema);
