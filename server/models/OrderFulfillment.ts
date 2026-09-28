import mongoose, { Document, type FilterQuery } from "mongoose";

export type OrderFulfillmentStatus = "pending" | "booked" | "in_progress" | "completed" | "cancelled";
export const ACTIVE_ORDER_FULFILLMENT_STATUSES: OrderFulfillmentStatus[] = ["pending", "booked", "in_progress", "completed"];

export interface IOrderFulfillmentTask {
  taskId?: string;
  title: string;
  description?: string;
  assignee?: string;
  dueAt?: Date;
  status: "pending" | "in_progress" | "done" | "blocked";
}

export interface IOrderFulfillmentHistoryItem {
  field: string;
  from: string;
  to: string;
  changedBy: string;
  changedAt: Date;
}

export interface IOrderSupplierPayment {
  amount: number;
  idempotencyKey?: string;
  paymentReference?: string;
  paymentMethod: string;
  paidAt: Date;
  recordedBy: string;
}

export type SupplierInvoiceSettlementStatus = "unpaid" | "partially_paid" | "paid" | "overpaid" | "overdue";

export function calculateSupplierInvoiceSettlement(
  invoiceAmount: number,
  payments: Array<Pick<IOrderSupplierPayment, "amount">> = [],
  dueAt?: Date,
  now = new Date()
) {
  const toCents = (amount: number) => Math.round(Number(amount || 0) * 100);
  const invoiceCents = toCents(invoiceAmount);
  const paidCents = payments.reduce((total, payment) => total + toCents(payment.amount), 0);
  const outstandingCents = invoiceCents - paidCents;
  const isPastDue = Boolean(dueAt && now.getTime() >= Date.UTC(
    dueAt.getUTCFullYear(),
    dueAt.getUTCMonth(),
    dueAt.getUTCDate() + 1
  ));
  const status: SupplierInvoiceSettlementStatus = paidCents > invoiceCents
    ? "overpaid"
    : invoiceCents === 0 || outstandingCents === 0
      ? "paid"
      : isPastDue
        ? "overdue"
      : paidCents === 0
      ? "unpaid"
      : "partially_paid";

  return {
    paid: paidCents / 100,
    outstanding: outstandingCents / 100,
    status,
  };
}

export function canCancelSupplierFulfillment(
  invoiceAmount: number | undefined,
  invoiceReference: string | undefined,
  payments: ReadonlyArray<Pick<IOrderSupplierPayment, "amount">>
): boolean {
  return invoiceAmount === undefined && !invoiceReference?.trim() && payments.length === 0;
}

export function findSupplierPaymentByIdempotencyKey(
  payments: ReadonlyArray<IOrderSupplierPayment>,
  idempotencyKey: string
): IOrderSupplierPayment | undefined {
  const normalizedKey = idempotencyKey.trim();
  if (!normalizedKey) return undefined;
  return payments.find((payment) => payment.idempotencyKey === normalizedKey);
}

export interface IOrderFulfillment extends Document {
  orderId: mongoose.Types.ObjectId | string;
  orderItemId?: mongoose.Types.ObjectId | string;
  supplierId?: mongoose.Types.ObjectId | string;
  supplierName?: string;
  supplierReference?: string;
  supplierReferenceKey?: string;
  supplierInvoiceReference?: string;
  supplierInvoiceAmount?: number;
  supplierInvoiceDueAt?: Date;
  supplierPayments: IOrderSupplierPayment[];
  serviceType?: string;
  status: OrderFulfillmentStatus;
  bookedAt?: Date;
  completedAt?: Date;
  notes?: string;
  tasks: IOrderFulfillmentTask[];
  history: IOrderFulfillmentHistoryItem[];
  createdAt?: Date;
  updatedAt?: Date;
}

export function buildSupplierReferenceKey(supplierName: string, supplierReference: string): string | undefined {
  const normalizedSupplierName = supplierName.trim().toLowerCase();
  const normalizedReference = supplierReference.trim().toLowerCase();
  if (!normalizedSupplierName || !normalizedReference) return undefined;
  return JSON.stringify([normalizedSupplierName, normalizedReference]);
}

export function buildSupplierReferenceDuplicateFilter(
  orderId: mongoose.Types.ObjectId | string,
  supplierName: string,
  supplierReference: string,
  excludeId?: mongoose.Types.ObjectId | string
): FilterQuery<IOrderFulfillment> | null {
  const normalizedReference = supplierReference.trim();
  if (!normalizedReference) return null;

  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter: FilterQuery<IOrderFulfillment> = {
    orderId,
    status: { $ne: "cancelled" },
    supplierReference: new RegExp(`^${escapeRegExp(normalizedReference)}$`, "i"),
  };

  const normalizedSupplierName = supplierName.trim();
  if (normalizedSupplierName) {
    filter.supplierName = new RegExp(`^${escapeRegExp(normalizedSupplierName)}$`, "i");
  }
  if (excludeId) {
    filter._id = { $ne: excludeId };
  }

  return filter;
}

export function buildFulfillmentHistory(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
  changedBy: string,
  changedAt = new Date()
): IOrderFulfillmentHistoryItem[] {
  const fields = [
    "orderItemId",
    "supplierName",
    "supplierReference",
    "supplierInvoiceReference",
    "supplierInvoiceAmount",
    "supplierInvoiceDueAt",
    "serviceType",
    "status",
    "notes",
  ];

  const changes = fields.flatMap((field) => {
    if (updates[field] === undefined) return [];

    const from = String(current[field] ?? "");
    const to = String(updates[field] ?? "");
    if (from === to) return [];

    return [{ field, from, to, changedBy, changedAt }];
  });

  if (Array.isArray(updates.tasks)) {
    const previousTasks = Array.isArray(current.tasks) ? current.tasks as Array<Record<string, unknown>> : [];
    const updatedTasks = updates.tasks as Array<Record<string, unknown>>;
    updatedTasks.forEach((task, index) => {
      const previous = previousTasks[index];
      const from = String(previous?.status ?? "");
      const to = String(task.status ?? "");
      if (from === to) return;

      changes.push({
        field: `task: ${String(task.title || previous?.title || `#${index + 1}`)}`,
        from,
        to,
        changedBy,
        changedAt,
      });
    });
  }

  return changes;
}

export function calculateFulfillmentProgress(tasks: IOrderFulfillmentTask[] = []) {
  if (!tasks.length) return 0;

  const completed = tasks.filter((task) => task.status === "done").length;
  return Math.round((completed / tasks.length) * 100);
}

const orderFulfillmentTaskSchema = new mongoose.Schema<IOrderFulfillmentTask>(
  {
    taskId: { type: String, default: "" },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    assignee: { type: String, default: "" },
    dueAt: { type: Date },
    status: { type: String, enum: ["pending", "in_progress", "done", "blocked"], default: "pending" },
  },
  { _id: false }
);

const orderFulfillmentHistorySchema = new mongoose.Schema<IOrderFulfillmentHistoryItem>(
  {
    field: { type: String, required: true },
    from: { type: String, default: "" },
    to: { type: String, default: "" },
    changedBy: { type: String, default: "" },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const orderSupplierPaymentSchema = new mongoose.Schema<IOrderSupplierPayment>(
  {
    amount: { type: Number, required: true, min: 0.01 },
    idempotencyKey: { type: String, default: "" },
    paymentReference: { type: String, default: "" },
    paymentMethod: { type: String, required: true, trim: true },
    paidAt: { type: Date, default: Date.now },
    recordedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

const orderFulfillmentSchema = new mongoose.Schema<IOrderFulfillment>(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    orderItemId: { type: mongoose.Schema.Types.ObjectId },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier" },
    supplierName: { type: String, default: "" },
    supplierReference: { type: String, default: "" },
    supplierReferenceKey: { type: String, default: undefined, select: false },
    supplierInvoiceReference: { type: String, default: "" },
    supplierInvoiceAmount: { type: Number, min: 0 },
    supplierInvoiceDueAt: { type: Date },
    supplierPayments: { type: [orderSupplierPaymentSchema], default: [] },
    serviceType: { type: String, default: "other" },
    status: { type: String, enum: ["pending", "booked", "in_progress", "completed", "cancelled"], default: "pending" },
    bookedAt: { type: Date },
    completedAt: { type: Date },
    notes: { type: String, default: "" },
    tasks: { type: [orderFulfillmentTaskSchema], default: [] },
    history: { type: [orderFulfillmentHistorySchema], default: [] },
  },
  { timestamps: true }
);

orderFulfillmentSchema.pre("validate", function setSupplierReferenceKey(next) {
  this.supplierReferenceKey = buildSupplierReferenceKey(this.supplierName || "", this.supplierReference || "");
  next();
});

orderFulfillmentSchema.index(
  { orderId: 1, supplierReferenceKey: 1 },
  {
    unique: true,
    name: "uniq_active_order_supplier_reference",
    partialFilterExpression: {
      supplierReferenceKey: { $type: "string" },
      status: { $in: ACTIVE_ORDER_FULFILLMENT_STATUSES },
    },
  }
);

orderFulfillmentSchema.index(
  { orderId: 1, orderItemId: 1 },
  {
    unique: true,
    name: "uniq_active_order_item_fulfillment",
    partialFilterExpression: {
      orderItemId: { $type: "objectId" },
      $or: [
        { status: { $in: ACTIVE_ORDER_FULFILLMENT_STATUSES } },
        { supplierInvoiceAmount: { $exists: true } },
        { "supplierPayments.0": { $exists: true } },
      ],
    },
  }
);

export const OrderFulfillment = mongoose.model<IOrderFulfillment>("OrderFulfillment", orderFulfillmentSchema);
