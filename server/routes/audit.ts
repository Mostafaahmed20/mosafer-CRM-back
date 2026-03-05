import { Router, Response } from "express";
import mongoose from "mongoose";
import { AuditEvent } from "../models/AuditEvent.js";
import { AuthRequest, authMiddleware, requireVerifiedEmail } from "../middleware/auth.js";
import { requireGlobalAdmin } from "../middleware/globalAdmin.js";

const router = Router();

router.use(authMiddleware, requireVerifiedEmail, requireGlobalAdmin);

type AuditSort = "newest" | "oldest";

interface AuditListRequest extends AuthRequest {
  query: {
    page?: string;
    limit?: string;
    q?: string;
    action?: string;
    boardId?: string;
    actorId?: string;
    channel?: string;
    cardId?: string;
    dateFrom?: string;
    dateTo?: string;
    sort?: AuditSort;
  };
}

interface AuditFiltersRequest extends AuthRequest {
  query: {
    dateFrom?: string;
    dateTo?: string;
  };
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSort(value: string | undefined): AuditSort {
  return value === "oldest" ? "oldest" : "newest";
}

function toObjectId(id?: string): mongoose.Types.ObjectId | null {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

function buildDateRangeMatch(dateFrom?: string, dateTo?: string) {
  const from = parseDate(dateFrom);
  const to = parseDate(dateTo);
  if ((dateFrom && !from) || (dateTo && !to)) return { error: "Invalid dateFrom/dateTo" };
  if (from && to && from.getTime() > to.getTime()) {
    return { error: "dateFrom must be before dateTo" };
  }

  const createdAt: Record<string, Date> = {};
  if (from) createdAt.$gte = from;
  if (to) createdAt.$lte = to;

  if (Object.keys(createdAt).length === 0) return { match: {} };
  return { match: { createdAt } };
}

// GET /api/audit
router.get("/", async (req: AuditListRequest, res: Response) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 100000);
    const limit = parsePositiveInt(req.query.limit, 25, 200);
    const skip = (page - 1) * limit;
    const sortMode = parseSort(req.query.sort);
    const sortDir = sortMode === "oldest" ? 1 : -1;
    const match: Record<string, any> = {};

    const dateMatch = buildDateRangeMatch(req.query.dateFrom, req.query.dateTo);
    if ("error" in dateMatch) {
      return res.status(400).json({ message: dateMatch.error });
    }
    Object.assign(match, dateMatch.match);

    if (req.query.action?.trim()) {
      match.action = req.query.action.trim();
    }

    if (req.query.channel?.trim()) {
      match.channel = req.query.channel.trim();
    }

    if (req.query.boardId?.trim()) {
      const boardId = toObjectId(req.query.boardId.trim());
      if (!boardId) return res.status(400).json({ message: "Invalid boardId" });
      match["board._id"] = boardId;
    }

    if (req.query.actorId?.trim()) {
      const actorId = toObjectId(req.query.actorId.trim());
      if (!actorId) return res.status(400).json({ message: "Invalid actorId" });
      match["actor._id"] = actorId;
    }

    if (req.query.cardId?.trim()) {
      const cardId = toObjectId(req.query.cardId.trim());
      if (!cardId) return res.status(400).json({ message: "Invalid cardId" });
      match["card._id"] = cardId;
    }

    if (req.query.q?.trim()) {
      const regex = new RegExp(escapeRegex(req.query.q.trim()), "i");
      match.$or = [
        { action: regex },
        { message: regex },
        { category: regex },
        { channel: regex },
        { "actor.username": regex },
        { "actor.email": regex },
        { "board.title": regex },
        { "card.title": regex },
        { "list.title": regex },
        { "target.label": regex },
      ];
    }

    const [total, items] = await Promise.all([
      AuditEvent.countDocuments(match),
      AuditEvent.find(match)
        .sort({ createdAt: sortDir, _id: sortDir })
        .skip(skip)
        .limit(limit),
    ]);

    res.json({
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext: skip + items.length < total,
      },
    });
  } catch (error) {
    console.error("Get audit events error:", error);
    res.status(500).json({ message: "Failed to load audit events" });
  }
});

// GET /api/audit/filters
router.get("/filters", async (req: AuditFiltersRequest, res: Response) => {
  try {
    const dateMatch = buildDateRangeMatch(req.query.dateFrom, req.query.dateTo);
    if ("error" in dateMatch) {
      return res.status(400).json({ message: dateMatch.error });
    }
    const baseMatch = dateMatch.match || {};

    const [actionsRaw, channelsRaw, boardsRaw, usersRaw] = await Promise.all([
      AuditEvent.distinct("action", baseMatch),
      AuditEvent.distinct("channel", baseMatch),
      AuditEvent.aggregate<{ _id: mongoose.Types.ObjectId; title: string }>([
        { $match: { ...baseMatch, "board._id": { $exists: true } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$board._id", title: { $first: "$board.title" } } },
        { $sort: { title: 1 } },
      ]),
      AuditEvent.aggregate<{ _id: mongoose.Types.ObjectId; username: string; email: string }>([
        { $match: { ...baseMatch, "actor._id": { $exists: true } } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$actor._id",
            username: { $first: "$actor.username" },
            email: { $first: "$actor.email" },
          },
        },
        { $sort: { username: 1, email: 1 } },
      ]),
    ]);

    const actions = actionsRaw
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    const channels = channelsRaw
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    const boards = boardsRaw
      .filter((row) => row?._id)
      .map((row) => ({
        _id: String(row._id),
        title: String(row.title || ""),
      }));

    const users = usersRaw
      .filter((row) => row?._id)
      .map((row) => ({
        _id: String(row._id),
        username: String(row.username || ""),
        email: String(row.email || ""),
      }));

    res.json({
      actions,
      channels,
      boards,
      users,
    });
  } catch (error) {
    console.error("Get audit filters error:", error);
    res.status(500).json({ message: "Failed to load audit filters" });
  }
});

export default router;
