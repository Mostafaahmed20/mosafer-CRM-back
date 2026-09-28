import { Router, Response } from "express";
import { Notification } from "../models/Notification.js";
import { AuthRequest, authMiddleware, requireVerifiedEmail } from "../middleware/auth.js";
import { mapDailyOpsNotification } from "../lib/dailyOps.js";

const router = Router();

router.use(authMiddleware, requireVerifiedEmail);

// GET /api/notifications - Get user's notifications
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const notifications = await Notification.find({ recipient: req.userId })
      .populate("sender", "username email")
      .populate("card", "title kind")
      .populate("board", "title")
      .sort({ createdAt: -1 })
      .limit(20);

    res.json(notifications.map(mapDailyOpsNotification));
  } catch (error) {
    console.error("Get notifications error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/notifications/unread-count - Get unread count
router.get("/unread-count", async (req: AuthRequest, res: Response) => {
  try {
    const count = await Notification.countDocuments({
      recipient: req.userId,
      read: false,
    });

    res.json({ count });
  } catch (error) {
    console.error("Get unread count error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/notifications/:id/read - Mark notification as read
router.patch("/:id/read", async (req: AuthRequest, res: Response) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.userId },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    res.json(notification);
  } catch (error) {
    console.error("Mark notification read error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/notifications/mark-all-read - Mark all as read
router.patch("/mark-all-read", async (req: AuthRequest, res: Response) => {
  try {
    await Notification.updateMany(
      { recipient: req.userId, read: false },
      { read: true }
    );

    res.json({ message: "All notifications marked as read" });
  } catch (error) {
    console.error("Mark all read error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/notifications/:id - Delete notification
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    await Notification.findOneAndDelete({
      _id: req.params.id,
      recipient: req.userId,
    });

    res.json({ message: "Notification deleted" });
  } catch (error) {
    console.error("Delete notification error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
