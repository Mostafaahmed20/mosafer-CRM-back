import mongoose from "mongoose";
import type { Request } from "express";
import type { AuthRequest } from "../middleware/auth.js";
import { AuditEvent } from "../models/AuditEvent.js";

type RefInput = {
  _id?: unknown;
  id?: unknown;
  title?: unknown;
  username?: unknown;
  email?: unknown;
};

type TargetInput = {
  _id?: unknown;
  id?: unknown;
  type?: unknown;
  label?: unknown;
};

type WriteAuditEventParams = {
  req: Request | AuthRequest;
  action: string;
  message: string;
  category?: string;
  channel?: string;
  actor?: RefInput;
  board?: RefInput;
  card?: RefInput;
  list?: RefInput;
  target?: TargetInput;
  meta?: Record<string, unknown>;
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toObjectId(value: unknown): mongoose.Types.ObjectId | undefined {
  if (!value) return undefined;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const raw = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(raw)) return undefined;
  return new mongoose.Types.ObjectId(raw);
}

function normalizeRef(ref?: RefInput) {
  if (!ref) return undefined;
  const _id = toObjectId(ref._id ?? ref.id);
  if (!_id) return undefined;
  const out = {
    _id,
    title: normalizeString(ref.title),
    username: normalizeString(ref.username),
    email: normalizeString(ref.email),
  };
  return out;
}

function normalizeTarget(target?: TargetInput) {
  if (!target) return undefined;
  const _id = toObjectId(target._id ?? target.id);
  const type = normalizeString(target.type);
  const label = normalizeString(target.label);
  if (!_id && !type && !label) return undefined;
  return {
    _id,
    type,
    label,
  };
}

function resolveIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() || "";
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return String(forwarded[0]).split(",")[0]?.trim() || "";
  }
  return normalizeString((req as any).ip);
}

export async function writeAuditEvent({
  req,
  action,
  message,
  category,
  channel,
  actor,
  board,
  card,
  list,
  target,
  meta,
}: WriteAuditEventParams) {
  const authReq = req as AuthRequest;

  const actorRef =
    normalizeRef(actor) ||
    normalizeRef({
      id: authReq.user?.id || authReq.userId,
      username: authReq.user?.username,
      email: authReq.user?.email,
    });

  const event = new AuditEvent({
    action: normalizeString(action),
    message: normalizeString(message),
    category: normalizeString(category),
    channel: normalizeString(channel),
    actor: actorRef,
    board: normalizeRef(board),
    card: normalizeRef(card),
    list: normalizeRef(list),
    target: normalizeTarget(target),
    requestId: normalizeString((req as any).id),
    ip: resolveIp(req),
    meta,
  });

  await event.save();
  return event;
}
