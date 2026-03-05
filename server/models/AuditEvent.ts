import mongoose, { Document } from "mongoose";
import { env } from "../config/env.js";

type AuditRef = {
  _id: mongoose.Types.ObjectId;
  title?: string;
  username?: string;
  email?: string;
};

type AuditTarget = {
  _id?: mongoose.Types.ObjectId;
  type?: string;
  label?: string;
};

export interface IAuditEvent extends Document {
  action: string;
  message: string;
  category?: string;
  channel?: string;
  actor?: AuditRef;
  board?: AuditRef;
  card?: AuditRef;
  list?: AuditRef;
  target?: AuditTarget;
  requestId?: string;
  ip?: string;
  meta?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

const auditRefSchema = new mongoose.Schema<AuditRef>(
  {
    _id: { type: mongoose.Schema.Types.ObjectId, required: true },
    title: { type: String, default: "" },
    username: { type: String, default: "" },
    email: { type: String, default: "" },
  },
  { _id: false }
);

const auditTargetSchema = new mongoose.Schema<AuditTarget>(
  {
    _id: { type: mongoose.Schema.Types.ObjectId },
    type: { type: String, default: "" },
    label: { type: String, default: "" },
  },
  { _id: false }
);

const auditEventSchema = new mongoose.Schema<IAuditEvent>(
  {
    action: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    category: { type: String, default: "", trim: true },
    channel: { type: String, default: "", trim: true },
    actor: { type: auditRefSchema, required: false },
    board: { type: auditRefSchema, required: false },
    card: { type: auditRefSchema, required: false },
    list: { type: auditRefSchema, required: false },
    target: { type: auditTargetSchema, required: false },
    requestId: { type: String, default: "", trim: true },
    ip: { type: String, default: "", trim: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

// Core filter/sort indexes used by audit workspace.
auditEventSchema.index({ createdAt: -1 });
auditEventSchema.index({ action: 1 });
auditEventSchema.index({ "actor._id": 1 });
auditEventSchema.index({ "board._id": 1 });
auditEventSchema.index({ "card._id": 1 });
auditEventSchema.index({ channel: 1 });
auditEventSchema.index({ createdAt: -1, "board._id": 1, action: 1 });

// Auto-expire old events to enforce retention in production and development.
auditEventSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: Math.max(1, env.AUDIT_RETENTION_DAYS) * 24 * 60 * 60,
  }
);

export const AuditEvent = mongoose.model<IAuditEvent>("AuditEvent", auditEventSchema);
