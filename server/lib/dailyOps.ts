import mongoose from "mongoose";
import { Card } from "../models/Card.js";
import { CoverageSlot, type ICoverageSlot } from "../models/CoverageSlot.js";
import { DailyTaskTemplate, type IDailyTaskTemplate } from "../models/DailyTaskTemplate.js";
import { Board } from "../models/Board.js";
import { List } from "../models/List.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { emitNotifications } from "./notify.js";
import { recordActivity } from "./activity.js";

export const DAILY_OPS_WORKSPACE_ID = "daily-ops";
const DAILY_OPS_BOARD_TITLE = "Daily Ops";
const DAILY_OPS_BOARD_MARKER = "[system:daily-ops]";
const DAILY_OPS_LIST_TITLE = "Daily Tasks";

export type DailyTaskOrigin = "primary" | "additional" | "manual" | "template";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: Array<string | undefined | null>) {
  return Array.from(new Set(values.map((value) => asString(value)).filter(Boolean)));
}

function buildSyntheticBoardRef() {
  return { _id: DAILY_OPS_WORKSPACE_ID, title: DAILY_OPS_BOARD_TITLE };
}

function normalizeUserRef(user: any) {
  if (!user) return null;
  const id = String(user._id || user.id || "").trim();
  if (!id) return null;
  return {
    _id: id,
    username: asString(user.username) || "Unknown",
    email: asString(user.email),
  };
}

function ensureDateString(input?: string | Date) {
  if (!input) return "";
  if (input instanceof Date) return input.toISOString().slice(0, 10);
  return asString(input).slice(0, 10);
}

export function parseBusinessDate(value?: string) {
  const input = asString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const date = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function formatBusinessDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function mapCoverageSlot(slot: any) {
  return {
    _id: String(slot._id),
    businessDate: ensureDateString(slot.businessDate),
    memberId: String(slot.memberId?._id || slot.memberId || ""),
    channel: asString(slot.channel),
    taskWindow: asString(slot.taskWindow),
    additionalDuty: asString(slot.additionalDuty) || undefined,
    scheduleWindow: asString(slot.scheduleWindow),
    notes: asString(slot.notes),
    createdAt: slot.createdAt ? new Date(slot.createdAt).toISOString() : new Date().toISOString(),
    updatedAt: slot.updatedAt ? new Date(slot.updatedAt).toISOString() : new Date().toISOString(),
  };
}

function mapTaskComment(comment: any) {
  return {
    _id: String(comment._id),
    text: asString(comment.text),
    author: normalizeUserRef(comment.author),
    parentCommentId: comment.parentCommentId ? String(comment.parentCommentId) : undefined,
    createdAt: comment.createdAt ? new Date(comment.createdAt).toISOString() : new Date().toISOString(),
    updatedAt: comment.updatedAt ? new Date(comment.updatedAt).toISOString() : undefined,
    deletedAt: comment.deletedAt ? new Date(comment.deletedAt).toISOString() : undefined,
  };
}

function mapTaskAttachment(attachment: any) {
  return {
    _id: String(attachment._id),
    name: asString(attachment.name),
    url: asString(attachment.url),
    addedBy: normalizeUserRef(attachment.uploadedBy),
    createdAt: attachment.createdAt ? new Date(attachment.createdAt).toISOString() : new Date().toISOString(),
  };
}

function mapTaskOrigin(origin?: string): DailyTaskOrigin {
  if (origin === "coverage_primary") return "primary";
  if (origin === "coverage_additional") return "additional";
  if (origin === "template") return "template";
  return "manual";
}

function getTaskAssigneeIds(task: any) {
  return ((task?.members || []) as any[])
    .map((member: any) => normalizeUserRef(member)?._id || String(member || ""))
    .filter(Boolean);
}

export function mapDailyTask(task: any) {
  const members = Array.isArray(task.members) ? task.members : [];
  const assigneeIds = members
    .map((member: any) => normalizeUserRef(member)?._id || String(member || ""))
    .filter(Boolean);

  return {
    _id: String(task._id),
    businessDate: ensureDateString(task.businessDate),
    coverageSlotId: task.coverageSlotId ? String(task.coverageSlotId) : undefined,
    templateId: task.recurrenceTemplateId ? String(task.recurrenceTemplateId) : undefined,
    memberId: assigneeIds[0] || "",
    assigneeIds,
    assignees: members.map((member: any) => normalizeUserRef(member)).filter(Boolean),
    title: asString(task.title),
    description: asString(task.description),
    channel: asString(task.channel) || undefined,
    dutyLabel: asString(task.dutyLabel) || undefined,
    taskWindow: asString(task.taskWindow),
    scheduleWindow: asString(task.scheduleWindow),
    shift: asString(task.shift) || undefined,
    status: asString(task.status) || "todo",
    progressPercent: Number(task.progressPercent || 0),
    origin: mapTaskOrigin(asString(task.dailyTaskOrigin)),
    pendingReason: asString(task.pendingReason) || undefined,
    completionNote: asString(task.completionNote) || undefined,
    carryForwardShift: asString(task.carryForwardShift) || undefined,
    carryForwardReason: asString(task.carryForwardReason) || undefined,
    comments: Array.isArray(task.comments) ? task.comments.map(mapTaskComment) : [],
    attachments: Array.isArray(task.attachments) ? task.attachments.map(mapTaskAttachment) : [],
    createdAt: task.createdAt ? new Date(task.createdAt).toISOString() : new Date().toISOString(),
    updatedAt: task.updatedAt ? new Date(task.updatedAt).toISOString() : new Date().toISOString(),
  };
}

export function buildDailyOpsTaskSummary(tasks: any[], userId?: string) {
  const scopedTasks = userId
    ? tasks.filter((task) => getTaskAssigneeIds(task).includes(String(userId)))
    : tasks;

  const summary = {
    total: scopedTasks.length,
    todo: 0,
    inProgress: 0,
    pending: 0,
    completed: 0,
    carriedForward: 0,
    handoverPending: 0,
    completionRate: 0,
  };

  for (const task of scopedTasks) {
    const status = asString(task?.status) || "todo";
    if (status === "done") summary.completed += 1;
    else if (status === "pending") summary.pending += 1;
    else if (status === "carried_forward") summary.carriedForward += 1;
    else if (status === "in_progress") summary.inProgress += 1;
    else summary.todo += 1;

    if (
      asString(task?.handoverPendingState) === "Yes" ||
      asString(task?.handoverStatus) === "Pending for next shift"
    ) {
      summary.handoverPending += 1;
    }
  }

  summary.completionRate =
    summary.total > 0 ? Number(((summary.completed / summary.total) * 100).toFixed(2)) : 0;

  return summary;
}

export async function ensureDailyOpsWorkspace(ownerId: string) {
  let board = await Board.findOne({ description: DAILY_OPS_BOARD_MARKER });
  if (!board) {
    board = await Board.create({
      title: DAILY_OPS_BOARD_TITLE,
      description: DAILY_OPS_BOARD_MARKER,
      background: "slate",
      owner: ownerId,
      members: [{ user: ownerId, role: "admin" }],
      labels: [],
    });
  }

  let list = await List.findOne({ board: board._id, title: DAILY_OPS_LIST_TITLE });
  if (!list) {
    list = await List.create({
      title: DAILY_OPS_LIST_TITLE,
      board: board._id,
      position: 0,
      archived: false,
    });
  }

  return { board, list };
}

export async function listDailyOpsMembers() {
  const users = await User.find({}).select("username email role createdAt updatedAt").sort({ username: 1 });
  return users.map((user) => ({
    _id: String(user._id),
    username: user.username,
    email: user.email,
    role: user.role,
    createdAt: (user as any).createdAt,
    updatedAt: (user as any).updatedAt,
  }));
}

function derivePrimaryTaskTitle(slot: ICoverageSlot) {
  const channel = asString(slot.channel).toLowerCase();
  if (channel === "mail") return "Handle Mail queue";
  if (channel === "whatsapp") return "Handle WhatsApp queue";
  return `Handle ${asString(slot.channel) || "assigned"} queue`;
}

function deriveAdditionalTaskTitle(label: string) {
  return `${label} duty`;
}

async function createOrUpdateCoverageTask({
  slot,
  origin,
  creatorId,
  workspaceListId,
}: {
  slot: ICoverageSlot;
  origin: "coverage_primary" | "coverage_additional";
  creatorId: string;
  workspaceListId: mongoose.Types.ObjectId | string;
}) {
  const title =
    origin === "coverage_primary"
      ? derivePrimaryTaskTitle(slot)
      : deriveAdditionalTaskTitle(asString(slot.additionalDuty) || "Additional");
  const dutyLabel = origin === "coverage_primary" ? asString(slot.channel) : asString(slot.additionalDuty);
  const existing = await Card.findOne({
    kind: "daily_task",
    coverageSlotId: slot._id,
    businessDate: slot.businessDate,
    dailyTaskOrigin: origin,
  });

  const baseUpdate = {
    title,
    description: asString(slot.notes),
    businessDate: slot.businessDate,
    coverageSlotId: slot._id,
    taskWindow: asString(slot.taskWindow),
    scheduleWindow: asString(slot.scheduleWindow),
    channel: asString(slot.channel),
    dutyLabel,
    members: [slot.memberId],
    agent: slot.memberId,
    list: workspaceListId,
    creator: creatorId,
    type: "Daily task",
    source: "Daily Ops",
    group: "Daily Ops",
    priority: "Medium",
    kind: "daily_task",
    dailyTaskOrigin: origin,
  };

  if (existing) {
    Object.assign(existing, baseUpdate);
    await existing.save();
    return { task: existing, created: false };
  }

  const task = await Card.create({
    ...baseUpdate,
    status: "todo",
    progressPercent: 0,
    dueComplete: false,
  });
  return { task, created: true };
}

export async function syncCoverageSlotTasks(slot: ICoverageSlot, actorId: string) {
  const { list } = await ensureDailyOpsWorkspace(actorId);
  const results = [];
  results.push(
    await createOrUpdateCoverageTask({
      slot,
      origin: "coverage_primary",
      creatorId: actorId,
      workspaceListId: list._id,
    })
  );

  if (asString(slot.additionalDuty)) {
    results.push(
      await createOrUpdateCoverageTask({
        slot,
        origin: "coverage_additional",
        creatorId: actorId,
        workspaceListId: list._id,
      })
    );
  } else {
    await Card.deleteMany({
      kind: "daily_task",
      coverageSlotId: slot._id,
      dailyTaskOrigin: "coverage_additional",
    });
  }

  return results;
}

function matchesRecurrence(template: IDailyTaskTemplate, businessDate: string) {
  const date = parseBusinessDate(businessDate);
  if (!date) return false;
  const day = date.getUTCDay();
  const pattern = template.recurrence?.pattern || "daily";
  if (pattern === "daily") return true;
  if (pattern === "weekdays") return day >= 1 && day <= 5;
  if (pattern === "weekly") {
    const days = template.recurrence?.daysOfWeek || [day];
    return days.includes(day);
  }
  const customDays = template.recurrence?.daysOfWeek || [];
  return customDays.includes(day);
}

async function resolveTemplateAssigneeIds(template: IDailyTaskTemplate, businessDate: string) {
  if (template.defaultAssigneeMode === "fixed") {
    return template.defaultAssigneeIds.map((id) => String(id));
  }
  if (template.defaultAssigneeMode !== "coverage_owner") {
    return [];
  }

  const slotFilter: Record<string, unknown> = { businessDate };
  if (asString(template.channel)) {
    slotFilter.channel = template.channel;
  }
  const slots = await CoverageSlot.find(slotFilter).select("memberId");
  return uniqueStrings(slots.map((slot) => String(slot.memberId)));
}

export async function generateDailyTasksForDate(businessDate: string, actorId?: string) {
  const fallbackOwner =
    actorId ||
    String(
      (
        await User.findOne({ role: "admin" }).select("_id").sort({ createdAt: 1 })
      )?._id ||
        (await User.findOne({}).select("_id").sort({ createdAt: 1 }))?._id ||
        ""
    );
  if (!fallbackOwner) {
    return { created: 0, updated: 0 };
  }

  const { list, board } = await ensureDailyOpsWorkspace(fallbackOwner);
  const slots = await CoverageSlot.find({ businessDate });
  const templates = await DailyTaskTemplate.find({ active: true });

  let created = 0;
  let updated = 0;

  for (const slot of slots) {
    const results = await syncCoverageSlotTasks(slot, fallbackOwner);
    results.forEach((result) => {
      if (result.created) created += 1;
      else updated += 1;
    });
  }

  for (const template of templates) {
    if (!matchesRecurrence(template, businessDate)) continue;
    const assigneeIds = await resolveTemplateAssigneeIds(template, businessDate);
    const existing = await Card.findOne({
      kind: "daily_task",
      recurrenceTemplateId: template._id,
      businessDate,
      shift: template.shift,
    });

    const baseUpdate = {
      kind: "daily_task",
      recurrenceTemplateId: template._id,
      businessDate,
      shift: asString(template.shift),
      title: asString(template.title),
      description: asString(template.description),
      taskWindow: asString(template.taskWindow),
      scheduleWindow: asString(template.scheduleWindow),
      channel: asString(template.channel),
      dutyLabel: asString(template.dutyLabel),
      dailyTaskOrigin: "template",
      members: assigneeIds,
      agent: assigneeIds[0] || undefined,
      list: list._id,
      creator: fallbackOwner,
      type: "Daily task",
      source: "Daily Ops",
      group: "Daily Ops",
      priority: "Medium",
    };

    if (existing) {
      Object.assign(existing, baseUpdate);
      await existing.save();
      updated += 1;
      continue;
    }

    const task = await Card.create({
      ...baseUpdate,
      status: "todo",
      progressPercent: 0,
      dueComplete: false,
    });
    created += 1;

    const recipients = uniqueStrings([...assigneeIds, fallbackOwner]);
    if (recipients.length > 0) {
      const sender = normalizeUserRef(await User.findById(fallbackOwner).select("username email")) || {
        _id: fallbackOwner,
      };
      const notifications = await Notification.insertMany(
        recipients.map((recipientId) => ({
          recipient: recipientId,
          sender: fallbackOwner,
          type: "card_assigned",
          card: task._id,
          board: board._id,
          message: `New daily task assigned: ${task.title}`,
          read: false,
        }))
      );
      emitNotifications(
        notifications.map((notification: any) => ({
          _id: notification._id?.toString?.(),
          recipient: String(notification.recipient),
          sender,
          message: notification.message,
          type: notification.type,
          card: { _id: String(task._id), title: task.title },
          board: buildSyntheticBoardRef(),
          createdAt: notification.createdAt?.toISOString?.() || new Date().toISOString(),
        }))
      );
    }
  }

  return { created, updated };
}

export async function getDailyTaskById(taskId: string) {
  return Card.findOne({ _id: taskId, kind: "daily_task" })
    .populate("creator", "username email")
    .populate("agent", "username email")
    .populate("members", "username email")
    .populate("comments.author", "username email")
    .populate("attachments.uploadedBy", "username email")
    .populate("dailyTaskHandovers.nextOwner", "username email");
}

export function canUserManageDailyTask(task: any, userId: string, isAdmin: boolean) {
  if (isAdmin) return true;
  return getTaskAssigneeIds(task).includes(String(userId));
}

async function listDailyOpsWorkspaceRecipientIds() {
  const users = await User.find({ emailVerified: true }).select("_id");
  return users.map((user) => String(user._id));
}

export async function getDailyOpsNotificationRecipientIds(task: any, extras?: {
  includeNextOwnerId?: string;
  includeReplyAuthorId?: string;
  includeWorkspaceMembers?: boolean;
}) {
  const adminIds = (
    await User.find({ role: "admin" }).select("_id")
  ).map((user) => String(user._id));
  const workspaceMemberIds = extras?.includeWorkspaceMembers
    ? await listDailyOpsWorkspaceRecipientIds()
    : [];

  return uniqueStrings([
    ...getTaskAssigneeIds(task),
    String(task.creator?._id || task.creator || ""),
    ...adminIds,
    ...workspaceMemberIds,
    extras?.includeNextOwnerId,
    extras?.includeReplyAuthorId,
  ]);
}

export async function createDailyTaskNotifications({
  task,
  senderId,
  recipientIds,
  message,
  type,
  commentText,
}: {
  task: any;
  senderId: string;
  recipientIds: string[];
  message: string;
  type: "comment" | "card_assigned" | "activity";
  commentText?: string;
}) {
  if (recipientIds.length === 0) return [];
  const { board } = await ensureDailyOpsWorkspace(senderId);
  const sender = normalizeUserRef(await User.findById(senderId).select("username email")) || { _id: senderId };
  const notifications = await Notification.insertMany(
    recipientIds.map((recipientId) => ({
      recipient: recipientId,
      sender: senderId,
      type,
      card: task._id,
      board: board._id,
      message,
      commentText,
      read: false,
    }))
  );

  emitNotifications(
    notifications.map((notification: any) => ({
      _id: notification._id?.toString?.(),
      recipient: String(notification.recipient),
      sender,
      message,
      type,
      commentText,
      card: { _id: String(task._id), title: task.title },
      board: buildSyntheticBoardRef(),
      createdAt: notification.createdAt?.toISOString?.() || new Date().toISOString(),
    }))
  );

  return notifications;
}

export async function recordDailyOpsActivity({
  actorId,
  task,
  type,
  message,
  meta,
}: {
  actorId: string;
  task: any;
  type: string;
  message: string;
  meta?: Record<string, unknown>;
}) {
  const { board, list } = await ensureDailyOpsWorkspace(actorId);
  return recordActivity({
    boardId: String(board._id),
    actorId,
    type,
    message,
    listId: String(task.list || list._id),
    cardId: String(task._id),
    meta,
  });
}

export function mapDailyOpsNotification(notification: any) {
  const card = notification?.card;
  if (!card || card.kind !== "daily_task") return notification;

  const mapped = notification.toObject ? notification.toObject() : { ...notification };
  mapped.card = {
    _id: String(card._id),
    title: asString(card.title),
  };
  mapped.board = buildSyntheticBoardRef();
  return mapped;
}
