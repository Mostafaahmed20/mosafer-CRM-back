import { Router, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import {
  getBullMqError,
  getBullMqRuntime,
  getJobMode,
} from "../queues/runtime.js";

const router = Router();

router.get("/", async (_req, res: Response) => {
  try {
    const dbReady = mongoose.connection.readyState === 1;
    const jobMode = getJobMode();
    const bullmqError = getBullMqError();
    const emailConfigured = env.EMAIL_ENABLED;
    let redisStatus: "up" | "down" | "disabled" | "unknown" = env.USE_BULLMQ_JOBS
      ? "unknown"
      : "disabled";

    let queues: Record<string, unknown> | null = null;
    if (jobMode === "bullmq") {
      const runtime = getBullMqRuntime();
      if (runtime) {
        const [dueCounts, bookingCounts, slaCounts, handoverCounts] = await Promise.all([
          runtime.dueQueue.getJobCounts("active", "waiting", "completed", "failed", "delayed"),
          runtime.bookingQueue.getJobCounts("active", "waiting", "completed", "failed", "delayed"),
          runtime.slaQueue.getJobCounts("active", "waiting", "completed", "failed", "delayed"),
          runtime.handoverQueue.getJobCounts("active", "waiting", "completed", "failed", "delayed"),
        ]);
        queues = {
          dueReminders: dueCounts,
          bookingOps: bookingCounts,
          slaMonitor: slaCounts,
          handoverReminders: handoverCounts,
        };
        try {
          const redisClient = await runtime.dueQueue.client;
          const pong = await redisClient.ping();
          redisStatus = pong === "PONG" ? "up" : "down";
        } catch (_error) {
          redisStatus = "down";
        }
      }
    }

    const jobsHealthy =
      !env.USE_BULLMQ_JOBS || (jobMode === "bullmq" && !bullmqError && redisStatus === "up");
    const ok = dbReady && jobsHealthy;
    const payload = {
      ok,
      db: dbReady ? "up" : "down",
      redis: redisStatus,
      email: emailConfigured ? "configured" : "not_configured",
      jobs: {
        configured: env.USE_BULLMQ_JOBS ? "bullmq" : "timer",
        active: jobMode,
        error: bullmqError,
        queues,
      },
    };
    res.status(ok ? 200 : 503).json(payload);
  } catch (error) {
    res.status(500).json({ ok: false, message: "Health check failed" });
  }
});

export default router;
