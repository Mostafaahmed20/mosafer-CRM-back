import { Card } from "../models/Card.js";
import { Notification } from "../models/Notification.js";
import { emitNotifications } from "../lib/notify.js";
import { logger } from "../lib/logger.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export type FollowUpReminderRunResult = { scanned: number; sent: number };

export async function runFollowUpReminderJobOnce(): Promise<FollowUpReminderRunResult> {
  const now = new Date();
  const dueCards = await Card.find({
    kind: { $ne: "daily_task" },
    archived: { $ne: true },
    salesStage: { $nin: ["Won", "Lost"] },
    followUpAt: { $type: "date", $lte: now },
    followUpCompleted: { $ne: true },
    $or: [{ followUpReminderSentAt: { $exists: false } }, { followUpReminderSentAt: null }],
  }).select("_id title followUpAt followUpNote agent creator list");

  let sent = 0;
  for (const card of dueCards) {
    if (!card.agent || !card.creator) continue;
    // Atomically claim this reminder so multiple app instances cannot notify twice.
    const claimed = await Card.findOneAndUpdate(
      {
        _id: card._id,
        followUpAt: card.followUpAt,
        followUpCompleted: { $ne: true },
        salesStage: { $nin: ["Won", "Lost"] },
        $or: [{ followUpReminderSentAt: { $exists: false } }, { followUpReminderSentAt: null }],
      },
      { $set: { followUpReminderSentAt: now } },
      { new: true }
    ).populate("list", "board");
    if (!claimed) continue;

    const boardId = String((claimed.list as any)?.board || "") || undefined;
    const message = `Follow-up due: "${claimed.title}"${claimed.followUpNote ? ` — ${claimed.followUpNote}` : ""}`;
    try {
      await Notification.create({
        recipient: card.agent,
        sender: card.creator,
        type: "activity",
        card: card._id,
        board: boardId,
        message,
        read: false,
      });
      emitNotifications([{
        recipient: String(card.agent),
        message,
        type: "activity",
        card: card._id,
        board: boardId,
      }]);
      sent += 1;
    } catch (error) {
      await Card.updateOne({ _id: card._id, followUpReminderSentAt: now }, { $set: { followUpReminderSentAt: null } });
      logger.error({ err: error, cardId: String(card._id) }, "Failed to send follow-up reminder");
    }
  }

  const result = { scanned: dueCards.length, sent };
  logger.info({ event: "jobs.follow_up_reminders.finish", ...result }, "Follow-up reminder job finished");
  return result;
}

export function startFollowUpReminderJob() {
  const runner = async () => {
    try {
      await runFollowUpReminderJobOnce();
    } catch (error) {
      logger.error({ err: error }, "Follow-up reminder job error");
    }
  };
  void runner();
  setInterval(runner, CHECK_INTERVAL_MS);
}
