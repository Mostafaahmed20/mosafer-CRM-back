import mongoose, { Document } from "mongoose";

export type OrderPaymentStatus = "pending" | "posted" | "failed" | "refunded" | "cancelled";

export interface IOrderAttachment {
  name: string;
  url: string;
  type: string;
  size: number;
  cloudinaryPublicId?: string;
  cloudinaryResourceType?: string;
  uploadedBy?: mongoose.Types.ObjectId | string;
  uploadedAt: Date;
}

export interface IOrderPayment extends Document {
  orderId: mongoose.Types.ObjectId | string;
  paymentMethod?: string;
  paymentReference?: string;
  idempotencyKey?: string;
  dedupeReference?: string;
  amount: number;
  currency: string;
  status: OrderPaymentStatus;
  paidAt?: Date;
  refundedAt?: Date;
  notes?: string;
  attachments: IOrderAttachment[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IOrderPaymentTotals {
  paid: number;
  refunded: number;
  pending: number;
  net: number;
}

export interface IOrderSettlementSummary {
  customerTotal: number;
  paid: number;
  refunded: number;
  pending: number;
  balanceDue: number;
  status: "unpaid" | "partially_paid" | "paid" | "overdue";
  isFullySettled: boolean;
}

export function calculateOrderPaymentTotals(payments: Array<{ amount: number; status?: string }> = []): IOrderPaymentTotals {
  const totals = payments.reduce(
    (acc, payment) => {
      const amount = Number(payment.amount || 0);
      const status = String(payment.status || "pending").toLowerCase();

      if (status === "posted") {
        acc.paid += amount;
      } else if (status === "refunded") {
        acc.refunded += amount;
      } else if (status === "pending") {
        acc.pending += amount;
      }

      return acc;
    },
    { paid: 0, refunded: 0, pending: 0 }
  );

  return {
    ...totals,
    net: totals.paid - totals.refunded,
  };
}

export function calculateOrderSettlement(input: { customerTotal: number; paid: number; refunded?: number; pending?: number }): IOrderSettlementSummary {
  const customerTotal = Number(input.customerTotal || 0);
  const paid = Number(input.paid || 0);
  const refunded = Number(input.refunded || 0);
  const pending = Number(input.pending || 0);
  const realized = paid - refunded;
  const balanceDue = Math.max(customerTotal - (realized + pending), 0);

  let status: IOrderSettlementSummary["status"] = "unpaid";
  if (balanceDue <= 0) status = "paid";
  else if (realized > 0 || pending > 0) status = "partially_paid";

  return {
    customerTotal,
    paid,
    refunded,
    pending,
    balanceDue,
    status,
    isFullySettled: balanceDue <= 0,
  };
}

const orderPaymentSchema = new mongoose.Schema<IOrderPayment>(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    paymentMethod: { type: String, default: "manual" },
    paymentReference: { type: String, default: "" },
    idempotencyKey: { type: String, trim: true },
    dedupeReference: { type: String, lowercase: true, trim: true, select: false },
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", uppercase: true },
    status: {
      type: String,
      enum: ["pending", "posted", "failed", "refunded", "cancelled"],
      default: "pending",
    },
    paidAt: { type: Date },
    refundedAt: { type: Date },
    notes: { type: String, default: "" },
    attachments: {
      type: [{
        name: { type: String, required: true },
        url: { type: String, required: true },
        type: { type: String, default: "application/octet-stream" },
        size: { type: Number, default: 0 },
        cloudinaryPublicId: { type: String, default: "" },
        cloudinaryResourceType: { type: String, default: "" },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        uploadedAt: { type: Date, default: Date.now },
      }],
      default: [],
    },
  },
  { timestamps: true }
);

orderPaymentSchema.index({ orderId: 1, idempotencyKey: 1 }, {
  unique: true,
  partialFilterExpression: { idempotencyKey: { $type: "string" } },
});
orderPaymentSchema.index({ orderId: 1, dedupeReference: 1 }, {
  unique: true,
  partialFilterExpression: { dedupeReference: { $type: "string" } },
});

export const OrderPayment = mongoose.model<IOrderPayment>("OrderPayment", orderPaymentSchema);
