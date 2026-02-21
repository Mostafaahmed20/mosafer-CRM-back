import { Router, Response } from "express";
import { List } from "../models/List.js";
import { Card } from "../models/Card.js";
import { authMiddleware, requireVerifiedEmail } from "../middleware/auth.js";
import { boardAuth, BoardAuthRequest } from "../middleware/boardAuth.js";
import { getSocketInstance } from "../socket.js";
import { recordActivity } from "../lib/activity.js";

const router = Router({ mergeParams: true });

router.use(authMiddleware, requireVerifiedEmail);

// GET /api/boards/:boardId/lists - Get all lists for a board (with cards)
router.get("/", boardAuth(), async (req: BoardAuthRequest, res: Response) => {
  try {
    const boardId = req.params.boardId as string;
    const lists = await List.find({ board: boardId, archived: { $ne: true } })
      .sort({ position: 1 });

    // Populate cards for each list
    const listsWithCards = await Promise.all(
      lists.map(async (list) => {
        const cards = await Card.find({
          list: list._id,
          archived: { $ne: true },
        })
          .populate("creator", "username email")
          .populate("members", "username email")
          .populate("comments.author", "username email")
          .sort({ position: 1 });

        return { ...list.toJSON(), cards };
      })
    );

    res.json(listsWithCards);
  } catch (error) {
    console.error("Get lists error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/boards/:boardId/lists - Create a list
router.post("/", boardAuth("member"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const boardId = req.params.boardId as string;
    const { title, position } = req.body;

    if (!title) {
      return res.status(400).json({ message: "Title is required" });
    }

    const listPosition =
      position !== undefined
        ? position
        : await List.countDocuments({ board: boardId });

    const list = new List({
      title,
      board: boardId,
      position: listPosition,
    });

    await list.save();

    // Emit real-time update
    try {
      const io = getSocketInstance();
      io.to(`board:${boardId}`).emit("list:created", { list: { ...list.toJSON(), cards: [] }, userId: req.userId });
      console.log(`🔄 Broadcasted list creation to board:${boardId}`);
    } catch (socketError) {
      console.error("Socket broadcast error:", socketError);
    }

    await recordActivity({
      boardId,
      actorId: req.userId as string,
      type: "list_created",
      message: `Created list "${list.title}"`,
      listId: list._id.toString(),
      notifyMembers: true,
    });

    res.status(201).json({ ...list.toJSON(), cards: [] });
  } catch (error) {
    console.error("Create list error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/boards/:boardId/lists/:listId - Update a list
router.patch("/:listId", boardAuth("member"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const boardId = req.params.boardId as string;
    const list = await List.findByIdAndUpdate(req.params.listId, req.body, {
      new: true,
    });

    if (!list) {
      return res.status(404).json({ message: "List not found" });
    }

    // Emit real-time update
    try {
      const io = getSocketInstance();
      io.to(`board:${boardId}`).emit("list:updated", { list, userId: req.userId });
      console.log(`🔄 Broadcasted list update to board:${boardId}`);
    } catch (socketError) {
      console.error("Socket broadcast error:", socketError);
    }

    await recordActivity({
      boardId,
      actorId: req.userId as string,
      type: "list_updated",
      message: `Updated list "${list.title}"`,
      listId: list._id.toString(),
      notifyMembers: true,
    });

    res.json(list);
  } catch (error) {
    console.error("Update list error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/boards/:boardId/lists/:listId - Delete a list
router.delete("/:listId", boardAuth("member"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const boardId = req.params.boardId as string;
    const list = await List.findByIdAndDelete(req.params.listId);
    if (!list) {
      return res.status(404).json({ message: "List not found" });
    }

    // Delete all cards in the list
    await Card.deleteMany({ list: req.params.listId });

    // Emit real-time update
    try {
      const io = getSocketInstance();
      io.to(`board:${boardId}`).emit("list:deleted", { listId: req.params.listId, userId: req.userId });
      console.log(`🔄 Broadcasted list deletion to board:${boardId}`);
    } catch (socketError) {
      console.error("Socket broadcast error:", socketError);
    }

    await recordActivity({
      boardId,
      actorId: req.userId as string,
      type: "list_deleted",
      message: `Deleted list "${list.title}"`,
      listId: list._id.toString(),
      notifyMembers: true,
    });

    res.json({ message: "List deleted" });
  } catch (error) {
    console.error("Delete list error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/boards/:boardId/lists/reorder - Reorder lists
router.post("/reorder", boardAuth("member"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const boardId = req.params.boardId as string;
    const { lists } = req.body;

    if (!Array.isArray(lists)) {
      return res.status(400).json({ message: "Lists array is required" });
    }

    await Promise.all(
      lists.map((item: { _id: string; position: number }) =>
        List.findByIdAndUpdate(item._id, { position: item.position })
      )
    );

    // Emit real-time update
    try {
      const io = getSocketInstance();
      io.to(`board:${boardId}`).emit("lists:reordered", { lists, userId: req.userId });
      console.log(`🔄 Broadcasted lists reorder to board:${boardId}`);
    } catch (socketError) {
      console.error("Socket broadcast error:", socketError);
    }

    await recordActivity({
      boardId,
      actorId: req.userId as string,
      type: "lists_reordered",
      message: "Reordered lists",
      notifyMembers: true,
    });

    res.json({ message: "Lists reordered" });
  } catch (error) {
    console.error("Reorder lists error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
