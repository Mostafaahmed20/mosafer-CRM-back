import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import type { CorsOptions } from "cors";
import { connectDB } from "./db.js";
import { setupSocket, setSocketInstance } from "./socket.js";
import userRoutes from "./routes/users.js";
import boardRoutes from "./routes/boards.js";
import listRoutes from "./routes/lists.js";
import cardRoutes from "./routes/cards.js";
import notificationRoutes from "./routes/notifications.js";
import activityRoutes from "./routes/activity.js";
import debugRoutes from "./routes/debug.js";
import boardMessageRoutes from "./routes/boardMessages.js";
import healthRoutes from "./routes/health.js";
import { startDueDateReminderJob } from "./jobs/dueDateReminders.js";
import { startBookingOpsAutomationJob } from "./jobs/bookingOpsAutomation.js";
import { startSlaMonitorJob } from "./jobs/slaMonitor.js";
import { startHandoverReminderJob } from "./jobs/handoverReminders.js";
import { startBullMqJobs } from "./queues/startBullMqJobs.js";
import { env } from "./config/env.js";
import { setBullMqError, setBullMqRuntime, setJobMode } from "./queues/runtime.js";
import { logger } from "./lib/logger.js";
import {
  apiErrorHandler,
  notFoundApiHandler,
  requestLogger,
} from "./middleware/requestLogging.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  await connectDB();
  const startTimerJobs = () => {
    startDueDateReminderJob();
    startBookingOpsAutomationJob();
    startSlaMonitorJob();
    startHandoverReminderJob();
    setBullMqRuntime(null);
    setJobMode("timer");
    logger.info("[Jobs] Timer mode active");
  };

  if (env.USE_BULLMQ_JOBS) {
    try {
      await startBullMqJobs();
      setBullMqError(null);
      setJobMode("bullmq");
      logger.info("[Jobs] BullMQ mode active");
    } catch (error: any) {
      const reason = String(error?.message || error || "BullMQ startup failed");
      setBullMqError(reason);
      setBullMqRuntime(null);
      logger.error(`[Jobs] BullMQ startup failed, falling back to timer jobs: ${reason}`);
      startTimerJobs();
    }
  } else {
    setBullMqError(null);
    startTimerJobs();
  }

  const app = express();
  const server = createServer(app);
  app.set("trust proxy", 1);
  app.use(requestLogger);

  // Setup Socket.IO
  const io = setupSocket(server);
  setSocketInstance(io);
  logger.info("Socket.IO initialized");

  // Middleware
  const corsOptions: CorsOptions = {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (env.CORS_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS blocked"));
    },
    credentials: true,
  };
  app.use(cors(corsOptions));
  app.use(express.json());

  // API Routes
  app.use("/api/health", healthRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/boards", boardRoutes);
  app.use("/api/boards/:boardId/lists", listRoutes);
  app.use("/api/boards/:boardId/lists/:listId/cards", cardRoutes);
  app.use("/api/boards/:boardId/activity", activityRoutes);
  app.use("/api/boards/:boardId/messages", boardMessageRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/debug", debugRoutes);
  app.use("/api", notFoundApiHandler);
  app.use(apiErrorHandler);

  // Serve uploaded files
  const uploadsPath = path.resolve(__dirname, "..", "uploads");
  app.use("/uploads", express.static(uploadsPath));

  // Serve static files in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.use(express.static(staticPath));

  // SPA fallback - serve index.html for all non-API routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = env.PORT;

  server.listen(port, () => {
    logger.info(`Server running on http://localhost:${port}`);
    logger.info(
      {
        mongodb: "connected",
        jobsMode: env.USE_BULLMQ_JOBS ? "bullmq" : "timer",
        emailEnabled: env.EMAIL_ENABLED,
      },
      "Backend dependencies status"
    );
  });
}

startServer().catch((error) => {
  logger.fatal({ err: error }, "Failed to start server");
  process.exit(1);
});

