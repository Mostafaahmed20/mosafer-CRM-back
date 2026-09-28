import { Router, Response } from "express";
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { Card } from "../models/Card.js";
import { User } from "../models/User.js";
import { CoverageSlot } from "../models/CoverageSlot.js";
import { authMiddleware, type AuthRequest, requireVerifiedEmail } from "../middleware/auth.js";
import { isGlobalAdmin } from "../lib/accessControl.js";
import { buildPasswordResetEmail, sendEmail } from "../lib/email.js";
import { env } from "../config/env.js";
import { writeAuditEvent } from "../lib/audit.js";
import {
  buildDailyOpsTaskSummary,
  canUserManageDailyTask,
  createDailyTaskNotifications,
  ensureDailyOpsWorkspace,
  formatBusinessDate,
  generateDailyTasksForDate,
  getDailyOpsNotificationRecipientIds,
  getDailyTaskById,
  listDailyOpsMembers,
  mapCoverageSlot,
  mapDailyTask,
  parseBusinessDate,
  recordDailyOpsActivity,
  syncCoverageSlotTasks,
} from "../lib/dailyOps.js";
import { UPLOADS_DIR } from "../lib/uploads.js";
import {
  deleteCloudinaryAttachment,
  isCloudinaryConfigured,
  safeUnlink,
  uploadAttachmentToCloudinary,
} from "../lib/cloudinary.js";

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = Router();

router.use(authMiddleware, requireVerifiedEmail);

function requireAdmin(req: AuthRequest, res: Response) {
  if (!isGlobalAdmin(req.user)) {
    res.status(403).json({ message: "Admin role required" });
    return false;
  }
  return true;
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeString(item)).filter(Boolean);
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function createRawToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getAssigneeIds(body: any) {
  const memberId = normalizeString(body?.memberId);
  const assigneeIds = normalizeStringArray(body?.assigneeIds);
  return unique(memberId ? [memberId, ...assigneeIds] : assigneeIds);
}

function validateBusinessDate(input?: string) {
  const value = normalizeString(input);
  return parseBusinessDate(value) ? value : null;
}

async function loadTaskOr404(taskId: string, res: Response) {
  const task = await getDailyTaskById(taskId);
  if (!task) {
    res.status(404).json({ message: "Daily task not found" });
    return null;
  }
  return task;
}

async function reloadTask(taskId: string) {
  return (await getDailyTaskById(taskId)) as any;
}

async function auditDailyOpsAction({
  req,
  task,
  action,
  message,
  category,
  channel,
  meta,
  targetType,
  targetLabel,
}: {
  req: AuthRequest;
  task?: any;
  action: string;
  message: string;
  category: string;
  channel: string;
  meta?: Record<string, unknown>;
  targetType: string;
  targetLabel: string;
}) {
  const { board, list } = await ensureDailyOpsWorkspace(req.userId as string);
  await writeAuditEvent({
    req,
    action,
    message,
    category,
    channel,
    board: { id: board._id, title: board.title },
    list: { id: list._id, title: list.title },
    card: task ? { id: task._id, title: task.title } : undefined,
    target: task
      ? { id: task._id, type: targetType, label: targetLabel }
      : { type: targetType, label: targetLabel },
    meta,
  });
}

router.get("/dashboard", async (req: AuthRequest, res: Response) => {
  try {
    const businessDate = validateBusinessDate(normalizeString(req.query.date)) || formatBusinessDate();
    await generateDailyTasksForDate(businessDate, req.userId);

    const [members, slots, tasks] = await Promise.all([
      listDailyOpsMembers(),
      CoverageSlot.find({ businessDate }).sort({ channel: 1, scheduleWindow: 1 }),
      Card.find({ kind: "daily_task", businessDate })
        .populate("creator", "username email")
        .populate("agent", "username email")
        .populate("members", "username email")
        .populate("comments.author", "username email")
        .populate("attachments.uploadedBy", "username email")
        .sort({ status: 1, title: 1 }),
    ]);
    const mappedTasks = tasks.map(mapDailyTask);

    res.json({
      businessDate,
      members,
      summary: buildDailyOpsTaskSummary(tasks),
      mySummary: buildDailyOpsTaskSummary(tasks, req.userId as string),
      coverageSlots: slots.map(mapCoverageSlot),
      tasks: mappedTasks,
    });
  } catch (error) {
    console.error("Get daily ops dashboard error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/members", async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const username = normalizeString(req.body?.username);
    const email = normalizeString(req.body?.email).toLowerCase();
    if (!username || !email) {
      return res.status(400).json({ message: "Username and email are required" });
    }

    const existing = await User.findOne({ email }).select("username email role createdAt updatedAt");
    if (existing) {
      return res.status(200).json({
        _id: existing._id,
        username: existing.username,
        email: existing.email,
        role: existing.role,
        createdAt: (existing as any).createdAt,
        updatedAt: (existing as any).updatedAt,
      });
    }

    const resetToken = createRawToken();
    const user = await User.create({
      username,
      email,
      password: createRawToken(),
      authProvider: "local",
      emailVerified: true,
      role: "user",
      workflowRoles: ["sales"],
      resetPasswordToken: hashToken(resetToken),
      resetPasswordExpires: new Date(Date.now() + 60 * 60 * 1000),
    });

    let invitation = {
      delivered: false,
      resetUrl: `${env.APP_BASE_URL}/reset-password?token=${encodeURIComponent(resetToken)}`,
    };
    try {
      const emailPayload = buildPasswordResetEmail({ username: user.username, token: resetToken });
      await sendEmail({
        to: user.email,
        subject: emailPayload.subject,
        html: emailPayload.html,
        text: emailPayload.text,
      });
      invitation = { ...invitation, delivered: true };
    } catch (emailError) {
      console.error("Daily ops invite email error:", emailError);
    }

    await auditDailyOpsAction({
      req,
      action: "daily_ops.member.created",
      message: `Created daily ops member "${user.username}"`,
      category: "daily-ops",
      channel: "members",
      meta: { email: user.email, invitationDelivered: invitation.delivered },
      targetType: "user",
      targetLabel: user.username,
    });

    res.status(201).json({
      _id: user._id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: (user as any).createdAt,
      updatedAt: (user as any).updatedAt,
      invitation,
    });
  } catch (error) {
    console.error("Create daily ops member error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/coverage-slots", async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const businessDate = validateBusinessDate(req.body?.businessDate);
    const memberId = normalizeString(req.body?.memberId);
    const channel = normalizeString(req.body?.channel);
    const taskWindow = normalizeString(req.body?.taskWindow);
    const scheduleWindow = normalizeString(req.body?.scheduleWindow);
    const additionalDuty = normalizeString(req.body?.additionalDuty);
    const notes = normalizeString(req.body?.notes);

    if (!businessDate || !memberId || !channel || !taskWindow || !scheduleWindow) {
      return res.status(400).json({
        message: "businessDate, memberId, channel, taskWindow, and scheduleWindow are required",
      });
    }

    const slot = await CoverageSlot.create({
      businessDate,
      memberId,
      channel,
      taskWindow,
      scheduleWindow,
      additionalDuty,
      notes,
      createdBy: req.userId,
      updatedBy: req.userId,
    });

    const syncResults = await syncCoverageSlotTasks(slot, req.userId as string);
    const tasks = await Card.find({
      _id: { $in: syncResults.map((result) => result.task._id) },
    }).populate("members", "username email");

    for (const task of tasks) {
      const recipientIds = (
        await getDailyOpsNotificationRecipientIds(task, { includeWorkspaceMembers: true })
      ).filter((recipientId) => recipientId !== req.userId);
      await createDailyTaskNotifications({
        task,
        senderId: req.userId as string,
        recipientIds,
        message: `New coverage assigned: ${task.title}`,
        type: "card_assigned",
      });
      await recordDailyOpsActivity({
        actorId: req.userId as string,
        task,
        type: "daily_task.assigned",
        message: `Assigned "${task.title}" for ${businessDate}`,
        meta: { coverageSlotId: String(slot._id), origin: task.dailyTaskOrigin },
      });
    }

    await auditDailyOpsAction({
      req,
      action: "daily_ops.coverage_slot.created",
      message: `Created coverage slot "${channel}" on ${businessDate}`,
      category: "daily-ops",
      channel: "coverage",
      meta: { slotId: String(slot._id), memberId, channel },
      targetType: "coverage_slot",
      targetLabel: `${channel} ${businessDate}`,
    });

    res.status(201).json(mapCoverageSlot(slot));
  } catch (error: any) {
    if (String(error?.code) === "11000") {
      return res.status(409).json({ message: "Coverage slot already exists for that member and channel" });
    }
    console.error("Create coverage slot error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.patch("/coverage-slots/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const slot = await CoverageSlot.findById(req.params.id);
    if (!slot) {
      return res.status(404).json({ message: "Coverage slot not found" });
    }

    if (req.body?.businessDate !== undefined) {
      const nextBusinessDate = validateBusinessDate(req.body.businessDate);
      if (!nextBusinessDate) {
        return res.status(400).json({ message: "Invalid businessDate" });
      }
      slot.businessDate = nextBusinessDate;
    }
    if (req.body?.memberId !== undefined) slot.memberId = req.body.memberId;
    if (req.body?.channel !== undefined) slot.channel = normalizeString(req.body.channel);
    if (req.body?.taskWindow !== undefined) slot.taskWindow = normalizeString(req.body.taskWindow);
    if (req.body?.scheduleWindow !== undefined) slot.scheduleWindow = normalizeString(req.body.scheduleWindow);
    if (req.body?.additionalDuty !== undefined) slot.additionalDuty = normalizeString(req.body.additionalDuty);
    if (req.body?.notes !== undefined) slot.notes = normalizeString(req.body.notes);
    slot.updatedBy = req.userId as any;
    await slot.save();

    const syncResults = await syncCoverageSlotTasks(slot, req.userId as string);
    const tasks = await Card.find({
      _id: { $in: syncResults.map((result) => result.task._id) },
    }).populate("members", "username email");

    for (const task of tasks) {
      const recipientIds = (
        await getDailyOpsNotificationRecipientIds(task, { includeWorkspaceMembers: true })
      ).filter((recipientId) => recipientId !== req.userId);
      await createDailyTaskNotifications({
        task,
        senderId: req.userId as string,
        recipientIds,
        message: `Coverage updated: ${task.title}`,
        type: "card_assigned",
      });
      await recordDailyOpsActivity({
        actorId: req.userId as string,
        task,
        type: "daily_task.updated",
        message: `Updated coverage for "${task.title}" on ${slot.businessDate}`,
        meta: { coverageSlotId: String(slot._id), memberId: String(slot.memberId) },
      });
    }

    await auditDailyOpsAction({
      req,
      action: "daily_ops.coverage_slot.updated",
      message: `Updated coverage slot "${slot.channel}" on ${slot.businessDate}`,
      category: "daily-ops",
      channel: "coverage",
      meta: { slotId: String(slot._id) },
      targetType: "coverage_slot",
      targetLabel: `${slot.channel} ${slot.businessDate}`,
    });

    res.json(mapCoverageSlot(slot));
  } catch (error) {
    console.error("Update coverage slot error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/tasks/manual", async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const businessDate = validateBusinessDate(req.body?.businessDate);
    const title = normalizeString(req.body?.title);
    const description = normalizeString(req.body?.description);
    const taskWindow = normalizeString(req.body?.taskWindow);
    const scheduleWindow = normalizeString(req.body?.scheduleWindow);
    const shift = normalizeString(req.body?.shift);
    const assigneeIds = getAssigneeIds(req.body);

    if (!businessDate || !title || !taskWindow || !scheduleWindow || assigneeIds.length === 0) {
      return res.status(400).json({
        message: "businessDate, title, taskWindow, scheduleWindow, and at least one assignee are required",
      });
    }

    const { list } = await ensureDailyOpsWorkspace(req.userId as string);
    const task = await Card.create({
      kind: "daily_task",
      list: list._id,
      creator: req.userId,
      title,
      description,
      businessDate,
      taskWindow,
      scheduleWindow,
      shift,
      members: assigneeIds,
      agent: assigneeIds[0],
      status: "todo",
      progressPercent: 0,
      dueComplete: false,
      type: "Daily task",
      source: "Daily Ops",
      group: "Daily Ops",
      priority: "Medium",
      dailyTaskOrigin: "manual",
    });

    const hydratedTask = await reloadTask(String(task._id));
    const recipientIds = (
      await getDailyOpsNotificationRecipientIds(hydratedTask, { includeWorkspaceMembers: true })
    ).filter((recipientId) => recipientId !== req.userId);
    await createDailyTaskNotifications({
      task: hydratedTask,
      senderId: req.userId as string,
      recipientIds,
      message: `You were assigned a daily task: ${task.title}`,
      type: "card_assigned",
    });
    await recordDailyOpsActivity({
      actorId: req.userId as string,
      task: hydratedTask,
      type: "daily_task.created",
      message: `Created daily task "${task.title}"`,
      meta: { businessDate, shift, assigneeIds },
    });
    await auditDailyOpsAction({
      req,
      task,
      action: "daily_ops.task.created",
      message: `Created daily task "${task.title}"`,
      category: "daily-ops",
      channel: "tasks",
      meta: { businessDate, shift, assigneeIds },
      targetType: "daily_task",
      targetLabel: task.title,
    });

    res.status(201).json(mapDailyTask(hydratedTask));
  } catch (error) {
    console.error("Create manual daily task error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.patch("/tasks/:id", async (req: AuthRequest, res: Response) => {
  try {
    const task = await loadTaskOr404(req.params.id, res);
    if (!task) return;

    const isAdmin = isGlobalAdmin(req.user);
    if (!canUserManageDailyTask(task, req.userId as string, isAdmin)) {
      return res.status(403).json({ message: "You can only update tasks assigned to you" });
    }

    const assigneeIds = getAssigneeIds(req.body);
    if (!isAdmin && (req.body?.memberId !== undefined || req.body?.assigneeIds !== undefined)) {
      return res.status(403).json({ message: "Only admins can reassign tasks" });
    }

    if (req.body?.title !== undefined) task.title = normalizeString(req.body.title);
    if (req.body?.description !== undefined) task.description = normalizeString(req.body.description);
    if (req.body?.taskWindow !== undefined) task.taskWindow = normalizeString(req.body.taskWindow);
    if (req.body?.scheduleWindow !== undefined) task.scheduleWindow = normalizeString(req.body.scheduleWindow);
    if (req.body?.shift !== undefined) task.shift = normalizeString(req.body.shift);
    if (req.body?.memberId !== undefined || req.body?.assigneeIds !== undefined) {
      task.members = assigneeIds as any;
      task.agent = assigneeIds[0] as any;
    }

    const nextStatus = normalizeString(req.body?.status) || task.status;
    const nextPendingReason =
      req.body?.pendingReason !== undefined ? normalizeString(req.body.pendingReason) : normalizeString(task.pendingReason);
    const nextCompletionNote =
      req.body?.completionNote !== undefined ? normalizeString(req.body.completionNote) : normalizeString(task.completionNote);
    const nextCarryShift =
      req.body?.carryForwardShift !== undefined ? normalizeString(req.body.carryForwardShift) : normalizeString(task.carryForwardShift);
    const nextCarryReason =
      req.body?.carryForwardReason !== undefined ? normalizeString(req.body.carryForwardReason) : normalizeString(task.carryForwardReason);

    if (nextStatus === "pending" && !nextPendingReason) {
      return res.status(400).json({ message: "Pending reason is required" });
    }
    if (nextStatus === "done") {
      task.progressPercent = 100;
      task.dueComplete = true;
      task.completedAt = new Date();
    } else if (nextStatus === "carried_forward") {
      if (!nextCarryShift || !nextCarryReason) {
        return res.status(400).json({ message: "Next shift and reason are required" });
      }
      task.progressPercent = 100;
      task.dueComplete = false;
      task.completedAt = undefined as any;
    } else if (req.body?.progressPercent !== undefined) {
      task.progressPercent = Math.min(100, Math.max(0, Number(req.body.progressPercent || 0)));
      if (nextStatus !== "done") {
        task.dueComplete = false;
        task.completedAt = undefined as any;
      }
    } else if (nextStatus !== "done") {
      task.dueComplete = false;
      task.completedAt = undefined as any;
    }

    task.status = nextStatus;
    task.pendingReason = nextPendingReason;
    task.completionNote = nextCompletionNote;
    task.carryForwardShift = nextCarryShift;
    task.carryForwardReason = nextCarryReason;
    await task.save();

    const hydratedTask = await reloadTask(String(task._id));
    if (
      req.body?.status !== undefined ||
      req.body?.memberId !== undefined ||
      req.body?.assigneeIds !== undefined
    ) {
      const recipientIds = (
        await getDailyOpsNotificationRecipientIds(hydratedTask, { includeWorkspaceMembers: true })
      ).filter((recipientId) => recipientId !== req.userId);
      await createDailyTaskNotifications({
        task: hydratedTask,
        senderId: req.userId as string,
        recipientIds,
        message:
          req.body?.memberId !== undefined || req.body?.assigneeIds !== undefined
            ? `Daily task assignment updated: ${hydratedTask.title}`
            : `${hydratedTask.title} is now ${hydratedTask.status}`,
        type:
          req.body?.memberId !== undefined || req.body?.assigneeIds !== undefined
            ? "card_assigned"
            : "activity",
      });
    }

    await recordDailyOpsActivity({
      actorId: req.userId as string,
      task: hydratedTask,
      type: "daily_task.updated",
      message: `Updated daily task "${hydratedTask.title}"`,
      meta: { status: hydratedTask.status, progressPercent: hydratedTask.progressPercent },
    });
    await auditDailyOpsAction({
      req,
      task: hydratedTask,
      action: "daily_ops.task.updated",
      message: `Updated daily task "${hydratedTask.title}"`,
      category: "daily-ops",
      channel: "tasks",
      meta: { status: hydratedTask.status, progressPercent: hydratedTask.progressPercent },
      targetType: "daily_task",
      targetLabel: hydratedTask.title,
    });

    res.json(mapDailyTask(hydratedTask));
  } catch (error) {
    console.error("Update daily task error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/tasks/:id/complete", async (req: AuthRequest, res: Response) => {
  try {
    const task = await loadTaskOr404(req.params.id, res);
    if (!task) return;

    const isAdmin = isGlobalAdmin(req.user);
    if (!canUserManageDailyTask(task, req.userId as string, isAdmin)) {
      return res.status(403).json({ message: "You can only update tasks assigned to you" });
    }

    task.status = "done";
    task.progressPercent = 100;
    task.completionNote = normalizeString(req.body?.completionNote);
    task.pendingReason = "";
    task.dueComplete = true;
    task.completedAt = new Date();
    await task.save();

    const recipientIds = (
      await getDailyOpsNotificationRecipientIds(task, { includeWorkspaceMembers: true })
    ).filter((recipientId) => recipientId !== req.userId);
    await createDailyTaskNotifications({
      task,
      senderId: req.userId as string,
      recipientIds,
      message: `${task.title} was completed`,
      type: "activity",
    });
    await recordDailyOpsActivity({
      actorId: req.userId as string,
      task,
      type: "daily_task.completed",
      message: `Completed daily task "${task.title}"`,
      meta: { completionNote: task.completionNote },
    });
    await auditDailyOpsAction({
      req,
      task,
      action: "daily_ops.task.completed",
      message: `Completed daily task "${task.title}"`,
      category: "daily-ops",
      channel: "tasks",
      meta: { completionNote: task.completionNote },
      targetType: "daily_task",
      targetLabel: task.title,
    });

    res.json(mapDailyTask(await reloadTask(String(task._id))));
  } catch (error) {
    console.error("Complete daily task error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/tasks/:id/pending", async (req: AuthRequest, res: Response) => {
  try {
    const task = await loadTaskOr404(req.params.id, res);
    if (!task) return;

    const isAdmin = isGlobalAdmin(req.user);
    if (!canUserManageDailyTask(task, req.userId as string, isAdmin)) {
      return res.status(403).json({ message: "You can only update tasks assigned to you" });
    }

    const reason = normalizeString(req.body?.reason || req.body?.pendingReason);
    if (!reason) {
      return res.status(400).json({ message: "Pending reason is required" });
    }

    task.status = "pending";
    task.pendingReason = reason;
    task.progressPercent = Math.max(Number(task.progressPercent || 0), 55);
    task.dueComplete = false;
    task.completedAt = undefined as any;
    await task.save();

    const recipientIds = (
      await getDailyOpsNotificationRecipientIds(task, { includeWorkspaceMembers: true })
    ).filter((recipientId) => recipientId !== req.userId);
    await createDailyTaskNotifications({
      task,
      senderId: req.userId as string,
      recipientIds,
      message: `${task.title} is pending: ${reason}`,
      type: "activity",
    });
    await recordDailyOpsActivity({
      actorId: req.userId as string,
      task,
      type: "daily_task.pending",
      message: `Marked "${task.title}" as pending`,
      meta: { pendingReason: reason },
    });
    await auditDailyOpsAction({
      req,
      task,
      action: "daily_ops.task.pending",
      message: `Marked daily task "${task.title}" as pending`,
      category: "daily-ops",
      channel: "tasks",
      meta: { pendingReason: reason },
      targetType: "daily_task",
      targetLabel: task.title,
    });

    res.json(mapDailyTask(await reloadTask(String(task._id))));
  } catch (error) {
    console.error("Mark daily task pending error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/tasks/:id/carry-forward", async (req: AuthRequest, res: Response) => {
  try {
    const task = await loadTaskOr404(req.params.id, res);
    if (!task) return;

    const isAdmin = isGlobalAdmin(req.user);
    if (!canUserManageDailyTask(task, req.userId as string, isAdmin)) {
      return res.status(403).json({ message: "You can only update tasks assigned to you" });
    }

    const nextShift = normalizeString(req.body?.nextShift || req.body?.carryForwardShift);
    const reason = normalizeString(req.body?.reason || req.body?.carryForwardReason);
    const nextOwnerId = normalizeString(req.body?.nextOwnerId);
    const summary = normalizeString(req.body?.summary);
    if (!nextShift || !reason) {
      return res.status(400).json({ message: "Next shift and reason are required" });
    }

    task.status = "carried_forward";
    task.carryForwardShift = nextShift;
    task.carryForwardReason = reason;
    task.pendingReason = reason;
    task.progressPercent = 100;
    task.dueComplete = false;
    task.completedAt = undefined as any;
    task.dailyTaskHandovers = task.dailyTaskHandovers || [];
    task.dailyTaskHandovers.push({
      fromShift: normalizeString(task.shift),
      toShift: nextShift,
      reason,
      nextOwner: (nextOwnerId || undefined) as any,
      summary,
      createdBy: req.userId,
      createdAt: new Date(),
    } as any);
    task.handoverStatus = "Pending for next shift";
    task.handoverPendingState = "Yes";
    task.handoverPending = reason;
    task.handoverSummary = summary;
    task.handoverNextOwner = nextOwnerId;
    task.handoverUpdatedAt = new Date();
    task.handoverUpdatedBy = req.userId as any;
    await task.save();

    const recipientIds = (
      await getDailyOpsNotificationRecipientIds(task, {
        includeNextOwnerId: nextOwnerId,
        includeWorkspaceMembers: true,
      })
    ).filter((recipientId) => recipientId !== req.userId);
    await createDailyTaskNotifications({
      task,
      senderId: req.userId as string,
      recipientIds,
      message: `${task.title} was carried forward to ${nextShift}`,
      type: "activity",
    });
    await recordDailyOpsActivity({
      actorId: req.userId as string,
      task,
      type: "daily_task.carried_forward",
      message: `Carried forward "${task.title}" to ${nextShift}`,
      meta: { reason, nextOwnerId },
    });
    await auditDailyOpsAction({
      req,
      task,
      action: "daily_ops.task.carry_forward",
      message: `Carried forward daily task "${task.title}"`,
      category: "daily-ops",
      channel: "handover",
      meta: { nextShift, reason, nextOwnerId },
      targetType: "daily_task",
      targetLabel: task.title,
    });

    res.json(mapDailyTask(await reloadTask(String(task._id))));
  } catch (error) {
    console.error("Carry forward daily task error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/tasks/:id/comments", async (req: AuthRequest, res: Response) => {
  try {
    const task = await loadTaskOr404(req.params.id, res);
    if (!task) return;

    const isAdmin = isGlobalAdmin(req.user);
    if (!canUserManageDailyTask(task, req.userId as string, isAdmin)) {
      return res.status(403).json({ message: "You can only comment on tasks assigned to you" });
    }

    const text = normalizeString(req.body?.body || req.body?.text);
    if (!text) {
      return res.status(400).json({ message: "Comment body is required" });
    }

    const parentCommentId = normalizeString(req.body?.parentCommentId);
    const parentComment = parentCommentId ? (task.comments as any).id(parentCommentId) : null;

    task.comments.push({
      text,
      author: req.userId as any,
      parentCommentId: (parentComment?._id || undefined) as any,
      createdAt: new Date(),
    });
    await task.save();

    const hydratedTask = await reloadTask(String(task._id));
    const recipientIds = (
      await getDailyOpsNotificationRecipientIds(hydratedTask, {
        includeReplyAuthorId: parentComment?.author?.toString?.(),
      })
    ).filter((recipientId) => recipientId !== req.userId);
    await createDailyTaskNotifications({
      task: hydratedTask,
      senderId: req.userId as string,
      recipientIds,
      message: parentCommentId
        ? `${req.user?.username || "Someone"} replied on ${hydratedTask.title}`
        : `${req.user?.username || "Someone"} commented on ${hydratedTask.title}`,
      type: "comment",
      commentText: text,
    });
    await recordDailyOpsActivity({
      actorId: req.userId as string,
      task: hydratedTask,
      type: parentCommentId ? "daily_task.reply_added" : "daily_task.comment_added",
      message: `Commented on "${hydratedTask.title}"`,
      meta: { parentCommentId: parentCommentId || undefined },
    });
    await auditDailyOpsAction({
      req,
      task: hydratedTask,
      action: "daily_ops.comment.created",
      message: `Added a comment on "${hydratedTask.title}"`,
      category: "daily-ops",
      channel: "comments",
      meta: { parentCommentId: parentCommentId || undefined, commentLength: text.length },
      targetType: "comment",
      targetLabel: hydratedTask.title,
    });

    res.status(201).json(mapDailyTask(hydratedTask));
  } catch (error) {
    console.error("Create daily task comment error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.patch("/tasks/:id/comments/:commentId", async (req: AuthRequest, res: Response) => {
  try {
    const task = await loadTaskOr404(req.params.id, res);
    if (!task) return;

    const text = normalizeString(req.body?.body || req.body?.text);
    if (!text) {
      return res.status(400).json({ message: "Comment body is required" });
    }

    const comment = (task.comments as any).id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }
    if (String(comment.author) !== String(req.userId)) {
      return res.status(403).json({ message: "You can only edit your own comments" });
    }

    comment.text = text;
    comment.updatedAt = new Date();
    await task.save();

    const hydratedTask = await reloadTask(String(task._id));
    await auditDailyOpsAction({
      req,
      task: hydratedTask,
      action: "daily_ops.comment.updated",
      message: `Edited a comment on "${hydratedTask.title}"`,
      category: "daily-ops",
      channel: "comments",
      meta: { commentId: req.params.commentId, commentLength: text.length },
      targetType: "comment",
      targetLabel: hydratedTask.title,
    });

    res.json(mapDailyTask(hydratedTask));
  } catch (error) {
    console.error("Update daily task comment error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.delete("/tasks/:id/comments/:commentId", async (req: AuthRequest, res: Response) => {
  try {
    const task = await loadTaskOr404(req.params.id, res);
    if (!task) return;

    const comment = (task.comments as any).id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }
    if (String(comment.author) !== String(req.userId)) {
      return res.status(403).json({ message: "You can only delete your own comments" });
    }

    (task.comments as any).pull(req.params.commentId);
    await task.save();

    const hydratedTask = await reloadTask(String(task._id));
    await auditDailyOpsAction({
      req,
      task: hydratedTask,
      action: "daily_ops.comment.deleted",
      message: `Deleted a comment from "${hydratedTask.title}"`,
      category: "daily-ops",
      channel: "comments",
      meta: { commentId: req.params.commentId },
      targetType: "comment",
      targetLabel: hydratedTask.title,
    });

    res.json(mapDailyTask(hydratedTask));
  } catch (error) {
    console.error("Delete daily task comment error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/tasks/:id/attachments", upload.single("file"), async (req: AuthRequest, res: Response) => {
  try {
    const task = await loadTaskOr404(req.params.id, res);
    if (!task) {
      safeUnlink(req.file?.path);
      return;
    }

    const isAdmin = isGlobalAdmin(req.user);
    if (!canUserManageDailyTask(task, req.userId as string, isAdmin)) {
      safeUnlink(req.file?.path);
      return res.status(403).json({ message: "You can only attach files to tasks assigned to you" });
    }
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    let attachmentUrl = `/uploads/${req.file.filename}`;
    let cloudinaryPublicId = "";
    let cloudinaryResourceType = "";

    if (isCloudinaryConfigured) {
      const uploaded = await uploadAttachmentToCloudinary(req.file.path, req.file.originalname);
      attachmentUrl = uploaded.url;
      cloudinaryPublicId = uploaded.publicId;
      cloudinaryResourceType = uploaded.resourceType;
      safeUnlink(req.file.path);
    }

    task.attachments.push({
      name: req.file.originalname,
      url: attachmentUrl,
      type: req.file.mimetype,
      uploadedBy: req.userId as any,
      createdAt: new Date(),
      cloudinaryPublicId,
      cloudinaryResourceType,
    });
    await task.save();

    const hydratedTask = await reloadTask(String(task._id));
    await auditDailyOpsAction({
      req,
      task: hydratedTask,
      action: "daily_ops.attachment.created",
      message: `Added attachment "${req.file.originalname}" to "${hydratedTask.title}"`,
      category: "daily-ops",
      channel: "attachments",
      meta: { mimeType: req.file.mimetype, size: req.file.size },
      targetType: "attachment",
      targetLabel: req.file.originalname,
    });

    res.status(201).json(mapDailyTask(hydratedTask));
  } catch (error) {
    safeUnlink(req.file?.path);
    console.error("Create daily task attachment error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.delete("/tasks/:id/attachments/:attachmentId", async (req: AuthRequest, res: Response) => {
  try {
    const task = await loadTaskOr404(req.params.id, res);
    if (!task) return;

    const attachment = (task.attachments as any).id(req.params.attachmentId);
    if (!attachment) {
      return res.status(404).json({ message: "Attachment not found" });
    }
    if (String(attachment.uploadedBy || "") !== String(req.userId)) {
      return res.status(403).json({ message: "You can only delete your own attachments" });
    }

    const cloudinaryPublicId = normalizeString(attachment.cloudinaryPublicId);
    if (cloudinaryPublicId) {
      await deleteCloudinaryAttachment(
        cloudinaryPublicId,
        normalizeString(attachment.cloudinaryResourceType) || "image"
      );
    } else if (normalizeString(attachment.url).startsWith("/uploads/")) {
      const filePath = path.join(UPLOADS_DIR, path.basename(normalizeString(attachment.url)));
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    (task.attachments as any).pull(req.params.attachmentId);
    await task.save();

    const hydratedTask = await reloadTask(String(task._id));
    await auditDailyOpsAction({
      req,
      task: hydratedTask,
      action: "daily_ops.attachment.deleted",
      message: `Deleted an attachment from "${hydratedTask.title}"`,
      category: "daily-ops",
      channel: "attachments",
      meta: { attachmentId: req.params.attachmentId },
      targetType: "attachment",
      targetLabel: hydratedTask.title,
    });

    res.json(mapDailyTask(hydratedTask));
  } catch (error) {
    console.error("Delete daily task attachment error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
