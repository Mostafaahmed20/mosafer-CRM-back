import mongoose, { Document } from "mongoose";

export type OrderAmendmentStatus = "requested" | "approved" | "rejected" | "completed";

export interface IOrderAmendment extends Document {
  orderId: mongoose.Types.ObjectId;
  reason: string;
  status: OrderAmendmentStatus;
  requestedBy: mongoose.Types.ObjectId;
  requestedAt: Date;
  decisionBy?: mongoose.Types.ObjectId;
  decisionAt?: Date;
  decisionNotes?: string;
  beforeSnapshot?: Record<string, unknown>;
  afterSnapshot?: Record<string, unknown>;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const orderAmendmentSchema = new mongoose.Schema<IOrderAmendment>({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  status: { type: String, enum: ["requested", "approved", "rejected", "completed"], default: "requested", index: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  requestedAt: { type: Date, default: Date.now },
  decisionBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  decisionAt: { type: Date },
  decisionNotes: { type: String, default: "", maxlength: 1000 },
  beforeSnapshot: { type: mongoose.Schema.Types.Mixed },
  afterSnapshot: { type: mongoose.Schema.Types.Mixed },
  completedAt: { type: Date },
}, { timestamps: true });

orderAmendmentSchema.index({ orderId: 1, createdAt: -1 });

export const OrderAmendment = mongoose.model<IOrderAmendment>("OrderAmendment", orderAmendmentSchema);
