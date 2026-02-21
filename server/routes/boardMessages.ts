import { Router, Response } from "express";
import { authMiddleware, requireVerifiedEmail } from "../middleware/auth.js";
import { boardAuth, BoardAuthRequest } from "../middleware/boardAuth.js";
import { BoardMessage } from "../models/BoardMessage.js";
import { getSocketInstance } from "../socket.js";
import { Board } from "../models/Board.js";
import { Notification } from "../models/Notification.js";
import { emitNotifications } from "../lib/notify.js";

const router = Router({ mergeParams: true });

router.use(authMiddleware, requireVerifiedEmail);

// GET /api/boards/:boardId/messages - list recent messages
router.get("/", boardAuth(), async (req: BoardAuthRequest, res: Response) => {
  try {
    const { boardId } = req.params;
    const limitRaw = Number(req.query.limit || 50);
    const limit = Math.min(Math.max(limitRaw, 1), 200);
    const before = req.query.before ? new Date(String(req.query.before)) : null;

    const query: Record<string, any> = { board: boardId };
    if (before && !Number.isNaN(before.getTime())) {
      query.createdAt = { $lt: before };
    }

    const messages = await BoardMessage.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("author", "username email");

    res.json(messages.reverse());
  } catch (error) {
    console.error("Get board messages error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/boards/:boardId/messages - create message
router.post("/", boardAuth("guest"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const { boardId } = req.params;
    const body = String(req.body?.body || "").trim();

    if (!body) {
      return res.status(400).json({ message: "Message body is required" });
    }

    const message = await BoardMessage.create({
      board: boardId,
      author: req.userId,
      body,
    });

    const populated = await message.populate("author", "username email");

    // Mention notifications (board chat)
    try {
      const board = await Board.findById(boardId).populate("members.user", "username email");
      if (board) {
        const members = board.members || [];
        const usernameMap: Record<string, string> = {};
        members.forEach((m: any) => {
          const u = m.user;
          if (u?.username) {
            usernameMap[u.username.toLowerCase()] = u._id.toString();
          }
        });

        const mentionIds = new Set<string>();
        const tokens = body.split(/\s+/);
        tokens.forEach((t) => {
          if (!t.startsWith("@") || t.length < 2) return;
          const raw = t.slice(1).replace(/[.,!?;:)\]]+$/, "");
          const username = raw.toLowerCase();
          const uid = usernameMap[username];
          if (uid && uid !== req.userId) mentionIds.add(uid);
        });

        if (mentionIds.size > 0) {
          const notifications = Array.from(mentionIds).map((recipientId) => ({
            recipient: recipientId,
            sender: req.userId,
            type: "mention" as const,
            board: board._id,
            message: `${(populated as any).author?.username || "Someone"} mentioned you in board chat`,
            commentText: body,
            read: false,
          }));

          await Notification.insertMany(notifications);
          emitNotifications(
            notifications.map((n) => ({
              recipient: n.recipient.toString(),
              message: n.message,
              type: n.type,
              board: n.board,
              commentText: n.commentText,
            }))
          );
        }
      }
    } catch (notifyError) {
      console.error("Board chat mention notification error:", notifyError);
    }

    try {
      const io = getSocketInstance();
      io.to(`board:${boardId}`).emit("board:message:new", {
        message: populated,
        userId: req.userId,
      });
    } catch (socketError) {
      console.error("Socket broadcast error:", socketError);
    }

    res.status(201).json(populated);
  } catch (error) {
    console.error("Create board message error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
