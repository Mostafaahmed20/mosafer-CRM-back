import { Card } from "../models/Card.js";
import { Notification } from "../models/Notification.js";
import { emitNotifications } from "../lib/notify.js";
import { sendEmail, buildHandoverReminderEmail } from "../lib/email.js";
import { logger } from "../lib/logger.js";
import { User } from "../models/User.js";
import mongoose from "mongoose";

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export type HandoverReminderRunResult = {
  scanned: number;
  sent: number;
};

export async function runHandoverReminderJobOnce(): Promise<HandoverReminderRunResult> {
  logger.info({ event: "jobs.handover_reminders.start" }, "Handover reminder job started");
  const now = new Date();
  const reminderCutoff = new Date(now.getTime() - CHECK_INTERVAL_MS);

  const cards = await Card.find({
    archived: { $ne: true },
    handoverPendingState: "Yes",
    handoverNextOwner: { $exists: true, $nin: [null, ""] },
    $or: [
      { handoverReminderSentAt: { $exists: false } },
      { handoverReminderSentAt: null },
      { handoverReminderSentAt: { $lte: reminderCutoff } },
    ],
  })
    .populate("creator", "username email")
    .populate("list", "title board");

  let sent = 0;
  for (const card of cards) {
    const nextOwnerId = String(card.handoverNextOwner || "").trim();
    if (!mongoose.Types.ObjectId.isValid(nextOwnerId)) continue;

    const owner = await User.findById(nextOwnerId).select("username email");
    if (!owner?._id || !owner?.email) continue;

    const list: any = card.list;
    const boardId = list?.board?.toString?.();
    const message = `Pending handover: "${card.title}" requires action (${card.handoverNextAction || "follow up pending"}).`;

    try {
      await Notification.create({
        recipient: owner._id,
        sender: card.creator as any,
        type: "activity",
        card: card._id,
        board: boardId,
        message,
        read: false,
      });

      const email = buildHandoverReminderEmail({
        cardTitle: card.title,
        boardId,
        nextAction: card.handoverNextAction || "",
        pendingDetails: card.handoverPending || "",
        blocker: card.handoverBlocker || "",
      });
      await sendEmail({
        to: owner.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });

      emitNotifications([
        {
          recipient: owner._id.toString(),
          message,
          type: "activity",
          card: card._id,
          board: boardId,
        },
      ]);

      card.handoverReminderSentAt = now;
      card.handoverReminderCount = Number(card.handoverReminderCount || 0) + 1;
      await card.save();
      sent += 1;
    } catch (error) {
      logger.error({ err: error, cardId: card._id.toString() }, "Failed to send handover reminder");
    }
  }

  const result = { scanned: cards.length, sent };
  logger.info({ event: "jobs.handover_reminders.finish", ...result }, "Handover reminder job finished");
  return result;
}

export function startHandoverReminderJob() {
  const runner = async () => {
    try {
      await runHandoverReminderJobOnce();
    } catch (error) {
      logger.error({ err: error }, "Handover reminder job error");
    }
  };
  runner();
  setInterval(runner, CHECK_INTERVAL_MS);
}
