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

const ALLOWED_SORT_BY = [
  "updatedAt",
  "createdAt",
  "priority",
  "status",
  "group",
  "board",
  "list",
] as const;

type AllowedSortBy = (typeof ALLOWED_SORT_BY)[number];
type AllowedSortDir = "asc" | "desc";

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

function parseSort(
  sortBy?: string,
  sortDir?: string
): { sortBy: AllowedSortBy; sortDir: AllowedSortDir } | null {
  const normalizedBy = String(sortBy || "").trim();
  const normalizedDir = String(sortDir || "").trim().toLowerCase();

  const by = normalizedBy
    ? ((ALLOWED_SORT_BY as readonly string[]).includes(normalizedBy)
        ? (normalizedBy as AllowedSortBy)
        : null)
    : ("updatedAt" as AllowedSortBy);
  if (!by) return null;

  const dir =
    normalizedDir === ""
      ? ("desc" as AllowedSortDir)
      : normalizedDir === "asc" || normalizedDir === "desc"
        ? (normalizedDir as AllowedSortDir)
        : null;
  if (!dir) return null;

  return { sortBy: by, sortDir: dir };
}

function toMongoSort(sortBy: AllowedSortBy, sortDir: AllowedSortDir): Record<string, 1 | -1> {
  const dir = sortDir === "asc" ? 1 : -1;
  if (sortBy === "board") return { "boardDoc.title": dir, _id: -1 };
  if (sortBy === "list") return { "listDoc.title": dir, _id: -1 };
  return { [sortBy]: dir, _id: -1 };
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
    card: {
      _id: String(card._id),
      title: card.title,
      subject: card.subject,
      description: card.description,
      status: card.status,
      priority: card.priority,
      group: card.group,
      agent: (card as any).agent?._id
        ? {
            _id: String((card as any).agent._id),
            username: (card as any).agent.username,
          }
        : null,
      bookingRef: card.bookingRef,
      requester: card.requester,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    },
    list: list
      ? {
          _id: String(list._id),
          title: list.title,
          board: String(list.board),
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
    const limit = parsePositiveInt(req.query.limit, 25, 200);
    const skip = (page - 1) * limit;
    const includeArchived = parseBool(req.query.includeArchived, false);
    const includeClosed = parseBool(req.query.includeClosed, true);
    const sortInput = parseSort(req.query.sortBy, req.query.sortDir);
    if (!sortInput) {
      return res.status(400).json({
        message:
          'Invalid sort input. sortBy must be one of "updatedAt|createdAt|priority|status|group|board|list" and sortDir must be "asc|desc"',
      });
    }
    const sort = toMongoSort(sortInput.sortBy, sortInput.sortDir);

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

    const [total, itemsRaw] = await Promise.all([
      Card.countDocuments(match),
      Card.aggregate<any>([
        { $match: match },
        {
          $lookup: {
            from: "lists",
            localField: "list",
            foreignField: "_id",
            as: "listDoc",
          },
        },
        { $unwind: { path: "$listDoc", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "boards",
            localField: "listDoc.board",
            foreignField: "_id",
            as: "boardDoc",
          },
        },
        { $unwind: { path: "$boardDoc", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "users",
            localField: "agent",
            foreignField: "_id",
            as: "agentDoc",
          },
        },
        { $unwind: { path: "$agentDoc", preserveNullAndEmptyArrays: true } },
        { $sort: sort },
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            card: {
              _id: "$_id",
              title: "$title",
              subject: "$subject",
              description: "$description",
              status: "$status",
              priority: "$priority",
              group: "$group",
              agent: {
                $cond: [
                  { $ifNull: ["$agentDoc._id", false] },
                  { _id: "$agentDoc._id", username: "$agentDoc.username" },
                  null,
                ],
              },
              bookingRef: "$bookingRef",
              requester: "$requester",
              createdAt: "$createdAt",
              updatedAt: "$updatedAt",
            },
            board: {
              _id: "$boardDoc._id",
              title: "$boardDoc.title",
            },
            listMeta: {
              _id: "$listDoc._id",
              title: "$listDoc.title",
              board: "$listDoc.board",
              archived: { $ifNull: ["$listDoc.archived", false] },
              position: { $ifNull: ["$listDoc.position", 0] },
            },
          },
        },
      ]),
    ]);

    const items = itemsRaw.map((item) => ({
      card: item.card
        ? {
            ...item.card,
            _id: item.card._id ? String(item.card._id) : undefined,
            agent: item.card.agent
              ? {
                  _id: String(item.card.agent._id),
                  username: item.card.agent.username,
                }
              : null,
          }
        : null,
      board: item.board?._id
        ? {
            _id: String(item.board._id),
            title: item.board.title,
          }
        : null,
      listMeta: item.listMeta?._id
        ? {
            _id: String(item.listMeta._id),
            title: item.listMeta.title,
            board: String(item.listMeta.board),
            archived: Boolean(item.listMeta.archived),
            position: Number(item.listMeta.position || 0),
          }
        : null,
    }));

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
        sortBy: sortInput.sortBy,
        sortDir: sortInput.sortDir,
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
