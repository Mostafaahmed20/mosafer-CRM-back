import { Router, Response } from "express";
import { authMiddleware, requireVerifiedEmail } from "../middleware/auth.js";
import { boardAuth, BoardAuthRequest } from "../middleware/boardAuth.js";
import { Activity } from "../models/Activity.js";

const router = Router({ mergeParams: true });

router.use(authMiddleware, requireVerifiedEmail);

// GET /api/boards/:boardId/activity?listId=&cardId=&limit=
router.get("/", boardAuth(), async (req: BoardAuthRequest, res: Response) => {
  try {
    const { boardId } = req.params;
    const { listId, cardId } = req.query;
    const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 200);

    const filter: Record<string, unknown> = { board: boardId };
    if (listId) filter.list = listId;
    if (cardId) filter.card = cardId;

    const activity = await Activity.find(filter)
      .populate("actor", "username email")
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json(activity);
  } catch (error) {
    console.error("Get activity error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
