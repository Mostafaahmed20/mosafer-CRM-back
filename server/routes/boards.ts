import { Router, Response } from "express";
import mongoose from "mongoose";
import { Board, BOARD_ROLES } from "../models/Board.js";
import { List } from "../models/List.js";
import { Card } from "../models/Card.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { AuthRequest, authMiddleware, requireVerifiedEmail } from "../middleware/auth.js";
import { sendEmail, buildBoardInviteEmail } from "../lib/email.js";
import { emitNotifications } from "../lib/notify.js";
import { writeAuditEvent } from "../lib/audit.js";
import {
  BOARD_ROLE_HIERARCHY as ROLE_HIERARCHY,
  getBoardRole as getUserBoardRole,
  isBoardMember,
  isGlobalAdmin,
} from "../lib/accessControl.js";

const router = Router();

router.use(authMiddleware, requireVerifiedEmail);

// GET /api/boards - Get all boards for current user
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    console.log(`📋 Fetching boards for user: ${req.userId}`);

    const globalAdmin = isGlobalAdmin(req.user);

    // Query for all boards for global admins, otherwise scope to owner/member.
    const boards = await Board.find(globalAdmin ? {} : {
      $or: [
        { owner: req.userId },
        { "members.user": req.userId }
      ],
    })
      .populate("owner", "username email")
      .sort({ updatedAt: -1 });

    console.log(`📋 Found ${boards.length} boards for user ${req.userId}`);

    // Migrate boards with old format and populate
    for (const board of boards) {
      try {
        const members = board.members as any[];
        console.log(`   Checking board "${board.title}": ${members.length} members, first member format:`, members[0]);

        if (members.length > 0 && members[0].user === undefined) {
          // Old format - migrate
          console.log(`   📦 Migrating board "${board.title}" from old format`);
          const newMembers = members.map((memberId) => ({
            user: memberId,
            role: memberId.toString() === board.owner._id.toString() ? "admin" : "member"
          }));
          (board as any).members = newMembers;
          await board.save();
        }

        // Populate after migration
        await board.populate("members.user", "username email");
        console.log(`   ✅ Populated members for board "${board.title}"`);
      } catch (boardError) {
        console.error(`   ❌ Error processing board "${board.title}":`, boardError);
        throw boardError;
      }
    }

    // Attach list counts
    const boardsWithLists = await Promise.all(
      boards.map(async (board) => {
        const lists = await List.find({
          board: board._id,
          archived: { $ne: true },
        });
        const boardObj = board.toJSON();
        return { ...boardObj, lists };
      })
    );

    console.log(`✅ Returning ${boardsWithLists.length} boards to client`);
    res.json(boardsWithLists);
  } catch (error: any) {
    console.error("❌ Get boards error:", error);
    console.error("   Error stack:", error.stack);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/boards/:id - Get board by ID
router.get("/:id", async (req: AuthRequest, res: Response) => {
  try {
    let board = await Board.findById(req.params.id)
      .populate("owner", "username email");

    if (!board) {
      return res.status(404).json({ message: "Board not found" });
    }

    if (!isGlobalAdmin(req.user) && !isBoardMember(board, req.userId!)) {
      return res.status(403).json({ message: "You are not allowed to access this board" });
    }

    // Handle migration from old format to new format
    const members = board.members as any[];
    if (members.length > 0 && members[0].user === undefined) {
      // Old format detected - migrate to new format
      console.log(`🔄 Auto-migrating board "${board.title}" to new member format`);
      const newMembers = members.map((memberId) => ({
        user: memberId,
        role: memberId.toString() === board.owner._id.toString() ? "admin" : "member"
      }));
      (board as any).members = newMembers;
      await board.save();
    }

    // Populate members.user after potential migration
    await board.populate("members.user", "username email");

    res.json(board);
  } catch (error) {
    console.error("Get board error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/boards/:boardId/archived-cards - List archived cards for board members
router.get("/:boardId/archived-cards", async (req: AuthRequest, res: Response) => {
  try {
    const board = await Board.findById(req.params.boardId);
    if (!board) {
      return res.status(404).json({ message: "Board not found" });
    }

    const role = isGlobalAdmin(req.user) ? "admin" : getUserBoardRole(board, req.userId!);
    if (!role) {
      return res.status(403).json({ message: "You are not a member of this board" });
    }

    const lists = await List.find({ board: req.params.boardId }).select("_id title");
    const listIds = lists.map((l) => l._id);
    const listTitleById = new Map(lists.map((l) => [l._id.toString(), l.title]));

    const archivedCards = await Card.find({
      list: { $in: listIds },
      archived: true,
    })
      .populate("creator", "username email")
      .populate("agent", "username email")
      .populate("members", "username email")
      .sort({ updatedAt: -1, createdAt: -1 });

    const payload = archivedCards.map((card) => {
      const cardObj = card.toJSON() as any;
      return {
        ...cardObj,
        listTitle: listTitleById.get(card.list.toString()) || "Unknown list",
      };
    });

    res.json(payload);
  } catch (error) {
    console.error("Get archived cards error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/boards/:boardId/archived-cards/:cardId/restore - Restore archived card
router.patch("/:boardId/archived-cards/:cardId/restore", async (req: AuthRequest, res: Response) => {
  try {
    const board = await Board.findById(req.params.boardId);
    if (!board) {
      return res.status(404).json({ message: "Board not found" });
    }

    const role = isGlobalAdmin(req.user) ? "admin" : getUserBoardRole(board, req.userId!);
    if (!role || ROLE_HIERARCHY[role] < ROLE_HIERARCHY.member) {
      return res.status(403).json({ message: "Member role or higher is required" });
    }

    const card = await Card.findById(req.params.cardId);
    if (!card) {
      return res.status(404).json({ message: "Card not found" });
    }

    const list = await List.findById(card.list).select("board");
    if (!list || list.board.toString() !== req.params.boardId) {
      return res.status(404).json({ message: "Card not found in this board" });
    }

    card.archived = false;
    await card.save();

    await card.populate("creator", "username email");
    await card.populate("agent", "username email");
    await card.populate("members", "username email");
    await card.populate("comments.author", "username email");
    await writeAuditEvent({
      req,
      action: "card.unarchived",
      message: `Restored card "${card.title}" from archive`,
      category: "card",
      channel: "cards",
      board: { id: req.params.boardId, title: board.title },
      list: { id: card.list },
      card: { id: card._id, title: card.title },
      target: { id: card._id, type: "card", label: card.title },
    });

    res.json(card);
  } catch (error) {
    console.error("Restore archived card error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/boards/:boardId/archived-cards/:cardId - Permanently delete archived card (admin only)
router.delete("/:boardId/archived-cards/:cardId", async (req: AuthRequest, res: Response) => {
  try {
    const board = await Board.findById(req.params.boardId);
    if (!board) {
      return res.status(404).json({ message: "Board not found" });
    }

    const role = isGlobalAdmin(req.user) ? "admin" : getUserBoardRole(board, req.userId!);
    if (role !== "admin") {
      return res.status(403).json({ message: "Only admins can permanently delete archived cards" });
    }

    const card = await Card.findById(req.params.cardId);
    if (!card) {
      return res.status(404).json({ message: "Card not found" });
    }

    const list = await List.findById(card.list).select("board");
    if (!list || list.board.toString() !== req.params.boardId) {
      return res.status(404).json({ message: "Card not found in this board" });
    }

    await Card.findByIdAndDelete(req.params.cardId);
    await writeAuditEvent({
      req,
      action: "card.archived_deleted",
      message: `Permanently deleted archived card "${card.title}"`,
      category: "card",
      channel: "cards",
      board: { id: req.params.boardId, title: board.title },
      list: { id: card.list },
      card: { id: card._id, title: card.title },
      target: { id: card._id, type: "card", label: card.title },
    });
    res.json({ message: "Archived card permanently deleted" });
  } catch (error) {
    console.error("Delete archived card error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/boards - Create a board
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const { title, description, background } = req.body;

    if (!title) {
      return res.status(400).json({ message: "Title is required" });
    }

    const board = new Board({
      title,
      description: description || "",
      background: background || "blue",
      owner: req.userId,
      members: [{ user: req.userId, role: "admin" }],
    });

    await board.save();
    await board.populate("owner", "username email");
    await board.populate("members.user", "username email");

    res.status(201).json({ ...board.toJSON(), lists: [] });
  } catch (error) {
    console.error("Create board error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/boards/:id - Update a board (admin only)
router.patch("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const board = await Board.findById(req.params.id);
    if (!board) {
      return res.status(404).json({ message: "Board not found" });
    }

    const role = isGlobalAdmin(req.user) ? "admin" : getUserBoardRole(board, req.userId!);
    if (role !== "admin") {
      return res
        .status(403)
        .json({ message: "Only admins can update board settings" });
    }

    const { title, description, background } = req.body;
    const previous = {
      title: board.title,
      description: board.description,
      background: board.background,
    };
    if (title !== undefined) board.title = title;
    if (description !== undefined) board.description = description;
    if (background !== undefined) board.background = background;

    await board.save();
    await board.populate("owner", "username email");
    await board.populate("members.user", "username email");
    await writeAuditEvent({
      req,
      action: "board.settings_updated",
      message: `Updated settings for board "${board.title}"`,
      category: "board",
      channel: "board_settings",
      board: { id: board._id, title: board.title },
      target: { id: board._id, type: "board", label: board.title },
      meta: {
        fields: Object.keys(req.body || {}),
        previous,
        next: {
          title: board.title,
          description: board.description,
          background: board.background,
        },
      },
    });

    res.json(board);
  } catch (error) {
    console.error("Update board error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/boards/:id - Delete a board (admin only)
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const board = await Board.findById(req.params.id);
    if (!board) {
      return res.status(404).json({ message: "Board not found" });
    }

    const role = isGlobalAdmin(req.user) ? "admin" : getUserBoardRole(board, req.userId!);
    if (role !== "admin") {
      return res
        .status(403)
        .json({ message: "Only admins can delete this board" });
    }

    await Board.findByIdAndDelete(req.params.id);

    // Clean up lists and cards
    const lists = await List.find({ board: req.params.id });
    const listIds = lists.map((l) => l._id);
    await Card.deleteMany({ list: { $in: listIds } });
    await List.deleteMany({ board: req.params.id });

    res.json({ message: "Board deleted" });
  } catch (error) {
    console.error("Delete board error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/boards/:boardId/members - Add member to board (admin only)
router.post("/:boardId/members", async (req: AuthRequest, res: Response) => {
  try {
    const { email, role = "member" } = req.body;

    if (!BOARD_ROLES.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    const board = await Board.findById(req.params.boardId);
    if (!board) {
      return res.status(404).json({ message: "Board not found" });
    }

    // Only admins can add members
    const requesterRole = isGlobalAdmin(req.user) ? "admin" : getUserBoardRole(board, req.userId!);
    if (requesterRole !== "admin") {
      return res
        .status(403)
        .json({ message: "Only admins can add members" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const alreadyMember = board.members.some(
      (m) => m.user.toString() === user._id!.toString()
    );
    if (alreadyMember) {
      return res.status(400).json({ message: "User is already a member" });
    }

    board.members.push({
      user: user._id as mongoose.Types.ObjectId,
      role,
    });
    await board.save();
    await board.populate("owner", "username email");
    await board.populate("members.user", "username email");
    await writeAuditEvent({
      req,
      action: "board.member_added",
      message: `Added ${user.username || user.email} to "${board.title}" as ${role}`,
      category: "board_member",
      channel: "board_members",
      board: { id: board._id, title: board.title },
      target: {
        id: user._id,
        type: "user",
        label: user.username || user.email || String(user._id),
      },
      meta: { role, email: user.email },
    });

    console.log(`✅ Added user ${user.email} (${user._id}) as ${role} to board "${board.title}" (${board._id})`);
    console.log(`   Board now has ${board.members.length} members:`, board.members.map((m: any) => ({ userId: m.user._id, role: m.role })));

    res.json(board);
  } catch (error) {
    console.error("Add member error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/boards/:boardId/members/:userId - Update member role (admin only)
router.patch(
  "/:boardId/members/:userId",
  async (req: AuthRequest, res: Response) => {
    try {
      const { role } = req.body;

      if (!role || !BOARD_ROLES.includes(role)) {
        return res.status(400).json({ message: "Invalid role" });
      }

      const board = await Board.findById(req.params.boardId);
      if (!board) {
        return res.status(404).json({ message: "Board not found" });
      }

      const requesterRole = isGlobalAdmin(req.user) ? "admin" : getUserBoardRole(board, req.userId!);
      if (requesterRole !== "admin") {
        return res
          .status(403)
          .json({ message: "Only admins can change roles" });
      }

      const targetMember = board.members.find(
        (m) => m.user.toString() === req.params.userId
      );
      if (!targetMember) {
        return res.status(404).json({ message: "Member not found" });
      }
      const previousRole = targetMember.role;

      // Prevent demoting the last admin
      if (targetMember.role === "admin" && role !== "admin") {
        const adminCount = board.members.filter(
          (m) => m.role === "admin"
        ).length;
        if (adminCount <= 1) {
          return res.status(400).json({
            message: "Cannot change role of the last admin",
          });
        }
      }

      targetMember.role = role;
      await board.save();
      await board.populate("owner", "username email");
      await board.populate("members.user", "username email");
      const targetUser = await User.findById(req.params.userId).select("username email");
      await writeAuditEvent({
        req,
        action: "board.member_role_changed",
        message: `Changed member role in "${board.title}" from ${previousRole} to ${role}`,
        category: "board_member",
        channel: "board_members",
        board: { id: board._id, title: board.title },
        target: {
          id: req.params.userId,
          type: "user",
          label: targetUser?.username || targetUser?.email || req.params.userId,
        },
        meta: {
          fromRole: previousRole,
          toRole: role,
        },
      });

      res.json(board);
    } catch (error) {
      console.error("Update member role error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// DELETE /api/boards/:boardId/members/:userId - Remove member (admin or self-leave)
router.delete(
  "/:boardId/members/:userId",
  async (req: AuthRequest, res: Response) => {
    try {
      const board = await Board.findById(req.params.boardId);
      if (!board) {
        return res.status(404).json({ message: "Board not found" });
      }

      const isSelf = req.params.userId === req.userId;

      if (!isSelf) {
        const requesterRole = isGlobalAdmin(req.user) ? "admin" : getUserBoardRole(board, req.userId!);
        if (requesterRole !== "admin") {
          return res
            .status(403)
            .json({ message: "Only admins can remove members" });
        }
      }

      const targetMember = board.members.find(
        (m) => m.user.toString() === req.params.userId
      );
      if (!targetMember) {
        return res.status(404).json({ message: "Member not found" });
      }
      const removedRole = targetMember.role;
      const removedUser = await User.findById(req.params.userId).select("username email");

      // Prevent removing the last admin
      if (targetMember.role === "admin") {
        const adminCount = board.members.filter(
          (m) => m.role === "admin"
        ).length;
        if (adminCount <= 1) {
          return res.status(400).json({
            message: "Cannot remove the last admin",
          });
        }
      }

      board.members = board.members.filter(
        (m) => m.user.toString() !== req.params.userId
      ) as any;
      await board.save();
      await board.populate("owner", "username email");
      await board.populate("members.user", "username email");
      await writeAuditEvent({
        req,
        action: "board.member_removed",
        message: `Removed ${removedUser?.username || removedUser?.email || req.params.userId} from "${board.title}"`,
        category: "board_member",
        channel: "board_members",
        board: { id: board._id, title: board.title },
        target: {
          id: req.params.userId,
          type: "user",
          label: removedUser?.username || removedUser?.email || req.params.userId,
        },
        meta: { role: removedRole, selfRemoval: isSelf },
      });

      res.json(board);
    } catch (error) {
      console.error("Remove member error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

export default router;
