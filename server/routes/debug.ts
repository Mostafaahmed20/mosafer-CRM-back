import { Router, Response } from "express";
import { authMiddleware, AuthRequest, requireVerifiedEmail } from "../middleware/auth.js";
import { runDueDateReminderJobOnce } from "../jobs/dueDateReminders.js";

const router = Router();

router.use(authMiddleware, requireVerifiedEmail);

// POST /api/debug/run-reminders - trigger reminder job immediately
router.post("/run-reminders", async (_req: AuthRequest, res: Response) => {
  try {
    const result = await runDueDateReminderJobOnce();
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error("Debug run reminders error:", error);
    res.status(500).json({ ok: false, message: "Failed to run reminders" });
  }
});

export default router;
