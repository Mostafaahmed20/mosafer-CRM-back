import { Card } from "../models/Card.js";
import { List } from "../models/List.js";
import { Board } from "../models/Board.js";
import { Notification } from "../models/Notification.js";
import { sendEmail, buildDueReminderEmail } from "../lib/email.js";
import { emitNotifications } from "../lib/notify.js";
import { logger } from "../lib/logger.js";

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export type ReminderRunResult = {
  sent24h: number;
  sent1h: number;
  sentDue: number;
  scanned24h: number;
  scanned1h: number;
  scannedDue: number;
};

export async function runDueDateReminderJobOnce(): Promise<ReminderRunResult> {
  logger.info({ event: "jobs.due_reminders.start" }, "Due reminder job started");
  const now = new Date();
  const intervalMs = CHECK_INTERVAL_MS;

  const window24Start = new Date(now.getTime() + 24 * 60 * 60 * 1000 - intervalMs);
  const window24End = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const window1Start = new Date(now.getTime() + 60 * 60 * 1000 - intervalMs);
  const window1End = new Date(now.getTime() + 60 * 60 * 1000);

  const [cards24h, cards1h, cardsDue] = await Promise.all([
    Card.find({
      kind: { $ne: "daily_task" },
      dueDate: { $gte: window24Start, $lte: window24End },
      dueComplete: { $ne: true },
      dueReminder24hSent: { $ne: true },
      archived: { $ne: true },
    })
      .populate("members", "username email")
      .populate("creator", "username email")
      .populate("list", "title board"),
    Card.find({
      kind: { $ne: "daily_task" },
      dueDate: { $gte: window1Start, $lte: window1End },
      dueComplete: { $ne: true },
      dueReminder1hSent: { $ne: true },
      archived: { $ne: true },
    })
      .populate("members", "username email")
      .populate("creator", "username email")
      .populate("list", "title board"),
    Card.find({
      kind: { $ne: "daily_task" },
      dueDate: { $lte: now },
      dueComplete: { $ne: true },
      dueReminderDueSent: { $ne: true },
      archived: { $ne: true },
    })
      .populate("members", "username email")
      .populate("creator", "username email")
      .populate("list", "title board"),
  ]);

  const sendReminder = async (
    card: any,
    stage: "24h" | "1h" | "due",
    messagePrefix: string
  ) => {
    const list = card.list as any;
    const boardId = list?.board?.toString();
    const listTitle = list?.title || "a list";
    const boardDoc = boardId
      ? await Board.findById(boardId).populate("members.user", "username email")
      : null;
    const boardTitle = boardDoc?.title;

    const cardMembers = (card.members as any[]) || [];
    const boardMembers = boardDoc?.members?.map((m: any) => m.user) || [];
    const recipients = cardMembers.length > 0 ? cardMembers : boardMembers;
    if (recipients.length === 0) return 0;

    const dueDate = card.dueDate ? new Date(card.dueDate) : null;
    const dueText = dueDate ? dueDate.toLocaleString() : "soon";

    let sentCount = 0;
    for (const member of recipients) {
      if (!member?.email) continue;
      const message = `${messagePrefix} (due ${dueText}) in ${listTitle}.`;

      await Notification.create({
        recipient: member._id,
        sender: card.creator,
        type: "due_date",
        card: card._id,
        board: boardId,
        message,
        read: false,
      });

      try {
        const email = buildDueReminderEmail({
          cardTitle: card.title,
          listTitle,
          boardTitle,
          dueText,
          actorName: card.creator?.username,
          boardId,
        });
        await sendEmail({
          to: member.email,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      } catch (emailError) {
        logger.error({ err: emailError }, "Email send failed for due reminder");
      }

      sentCount += 1;
    }

    // Push realtime notifications
    emitNotifications(
      recipients.map((member: any) => ({
        recipient: member._id?.toString?.() || member.toString?.() || "",
        message: `${messagePrefix} (due ${dueText}) in ${listTitle}.`,
        type: "due_date",
        card: card._id,
        board: boardId,
      }))
    );

    return sentCount;
  };

  let sent24h = 0;
  let sent1h = 0;
  let sentDue = 0;

  for (const card of cards24h) {
    const sentCount = await sendReminder(
      card,
      "24h",
      `Card "${card.title}" is due in 24 hours`
    );
    if (sentCount > 0) {
      card.dueReminder24hSent = true;
      card.dueReminder24hSentAt = new Date();
      await card.save();
    }
    sent24h += sentCount;
  }

  for (const card of cards1h) {
    const sentCount = await sendReminder(
      card,
      "1h",
      `Card "${card.title}" is due in 1 hour`
    );
    if (sentCount > 0) {
      card.dueReminder1hSent = true;
      card.dueReminder1hSentAt = new Date();
      await card.save();
    }
    sent1h += sentCount;
  }

  for (const card of cardsDue) {
    const sentCount = await sendReminder(
      card,
      "due",
      `Card "${card.title}" is due now`
    );
    if (sentCount > 0) {
      card.dueReminderDueSent = true;
      card.dueReminderDueSentAt = new Date();
      await card.save();
    }
    sentDue += sentCount;
  }

  const result = {
    sent24h,
    sent1h,
    sentDue,
    scanned24h: cards24h.length,
    scanned1h: cards1h.length,
    scannedDue: cardsDue.length,
  };
  logger.info({ event: "jobs.due_reminders.finish", ...result }, "Due reminder job finished");
  return result;
}

export function startDueDateReminderJob() {
  const runner = async () => {
    try {
      await runDueDateReminderJobOnce();
    } catch (error) {
      logger.error({ err: error }, "Due date reminder job error");
    }
  };

  runner();
  setInterval(runner, CHECK_INTERVAL_MS);
}
