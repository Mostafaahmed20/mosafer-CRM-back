import { Router, Response } from "express";
import mongoose from "mongoose";
import { Card } from "../models/Card.js";
import { List } from "../models/List.js";
import { Board } from "../models/Board.js";
import { authMiddleware, AuthRequest, requireVerifiedEmail } from "../middleware/auth.js";
import { requireGlobalAdmin } from "../middleware/globalAdmin.js";

const router = Router();

router.use(authMiddleware, requireVerifiedEmail, requireGlobalAdmin);

const TERMINAL_STATUSES = new Set(["Completed", "Closed", "Cancelled"]);

interface AdminTicketsRequest extends AuthRequest {
  query: {
    page?: string;
    limit?: string;
    q?: string;
    status?: string;
    priority?: string;
    group?: string;
    boardId?: string;
    listId?: string;
    agentId?: string;
    includeArchived?: string;
    includeClosed?: string;
    sortBy?: string;
    sortDir?: string;
  };
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidObjectId(id?: string): boolean {
  return Boolean(id && mongoose.Types.ObjectId.isValid(id));
}

function normalizeSort(sortBy?: string, sortDir?: string) {
  const allowedSortBy = new Set([
    "updatedAt",
    "createdAt",
    "dueDate",
    "arrivalDate",
    "priority",
    "status",
  ]);
  const field = allowedSortBy.has(String(sortBy)) ? String(sortBy) : "updatedAt";
  const dir = String(sortDir).toLowerCase() === "asc" ? 1 : -1;
  return { [field]: dir as 1 | -1, _id: -1 as const };
}

async function getCardContext(cardId: string) {
  const card = await Card.findById(cardId)
    .populate("creator", "username email")
    .populate("agent", "username email")
    .populate("members", "username email")
    .populate("comments.author", "username email");

  if (!card) return null;

  const list = await List.findById(card.list).select("_id title board archived");
  const board = list ? await Board.findById(list.board).select("_id title owner members") : null;

  return {
    card,
    list: list
      ? {
          _id: String(list._id),
          title: list.title,
          board: String(list.board),
          archived: Boolean(list.archived),
        }
      : null,
    board: board
      ? {
          _id: String(board._id),
          title: board.title,
        }
      : null,
  };
}

// GET /api/admin/tickets - Global admin inbox across all boards
router.get("/", async (req: AdminTicketsRequest, res: Response) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 100000);
    const limit = parsePositiveInt(req.query.limit, 50, 200);
    const skip = (page - 1) * limit;
    const includeArchived = parseBool(req.query.includeArchived, false);
    const includeClosed = parseBool(req.query.includeClosed, true);
    const sort = normalizeSort(req.query.sortBy, req.query.sortDir);

    const match: Record<string, any> = {};

    if (!includeArchived) {
      match.archived = { $ne: true };
    }
    if (!includeClosed) {
      match.status = { $nin: Array.from(TERMINAL_STATUSES) };
    }

    if (req.query.status?.trim()) {
      match.status = req.query.status.trim();
    }
    if (req.query.priority?.trim()) {
      match.priority = req.query.priority.trim();
    }
    if (req.query.group?.trim()) {
      match.group = req.query.group.trim();
    }
    if (req.query.agentId?.trim()) {
      const agentId = req.query.agentId.trim();
      if (!isValidObjectId(agentId)) {
        return res.status(400).json({ message: "Invalid agentId" });
      }
      match.agent = new mongoose.Types.ObjectId(agentId);
    }
    if (req.query.listId?.trim()) {
      const listId = req.query.listId.trim();
      if (!isValidObjectId(listId)) {
        return res.status(400).json({ message: "Invalid listId" });
      }
      match.list = new mongoose.Types.ObjectId(listId);
    } else if (req.query.boardId?.trim()) {
      const boardId = req.query.boardId.trim();
      if (!isValidObjectId(boardId)) {
        return res.status(400).json({ message: "Invalid boardId" });
      }
      const boardLists = await List.find({
        board: new mongoose.Types.ObjectId(boardId),
      }).select("_id");
      match.list = { $in: boardLists.map((l) => l._id) };
    }

    if (req.query.q?.trim()) {
      const q = req.query.q.trim();
      const regex = new RegExp(escapeRegex(q), "i");
      match.$or = [
        { title: regex },
        { subject: regex },
        { requester: regex },
        { bookingRef: regex },
        { agencyName: regex },
        { hotelName: regex },
        { supplierName: regex },
        { description: regex },
      ];
    }

    const [total, cards] = await Promise.all([
      Card.countDocuments(match),
      Card.find(match)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate("creator", "username email")
        .populate("agent", "username email")
        .populate("members", "username email"),
    ]);

    const listIds = Array.from(new Set(cards.map((c: any) => String(c.list)).filter(Boolean)));
    const lists = listIds.length
      ? await List.find({ _id: { $in: listIds } }).select("_id title board archived")
      : [];
    const listMap = new Map(lists.map((list) => [String(list._id), list]));

    const boardIds = Array.from(new Set(lists.map((l: any) => String(l.board)).filter(Boolean)));
    const boards = boardIds.length
      ? await Board.find({ _id: { $in: boardIds } }).select("_id title")
      : [];
    const boardMap = new Map(boards.map((board) => [String(board._id), board]));

    const items = cards.map((card: any) => {
      const list = listMap.get(String(card.list));
      const board = list ? boardMap.get(String(list.board)) : null;
      return {
        ...card.toJSON(),
        board: board
          ? {
              _id: String(board._id),
              title: board.title,
            }
          : null,
        listMeta: list
          ? {
              _id: String(list._id),
              title: list.title,
              board: String(list.board),
              archived: Boolean(list.archived),
            }
          : null,
      };
    });

    res.json({
      scope: "global-admin",
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext: skip + items.length < total,
      },
      filters: {
        includeArchived,
        includeClosed,
      },
    });
  } catch (error) {
    console.error("Admin tickets list error:", error);
    res.status(500).json({ message: "Failed to load admin tickets" });
  }
});

// GET /api/admin/tickets/:cardId - Global admin access to a single ticket with board/list context
router.get("/:cardId", async (req: AdminTicketsRequest, res: Response) => {
  try {
    const { cardId } = req.params;
    if (!isValidObjectId(cardId)) {
      return res.status(400).json({ message: "Invalid cardId" });
    }

    const result = await getCardContext(cardId);
    if (!result) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    res.json(result);
  } catch (error) {
    console.error("Admin ticket detail error:", error);
    res.status(500).json({ message: "Failed to load admin ticket" });
  }
});

export default router;
