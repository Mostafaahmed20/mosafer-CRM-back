import { Card } from "../models/Card.js";
import { Board } from "../models/Board.js";
import { Notification } from "../models/Notification.js";
import { emitNotifications } from "../lib/notify.js";
import { logger } from "../lib/logger.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const ACTIVE_STATUSES = [
  "New",
  "In Progress",
  "Pending Supplier",
  "Pending Client",
  // Legacy statuses for existing tickets
  "Requested",
  "Quoted",
  "Optioned",
  "Confirmed",
  "Reconfirmed",
  "In-house",
];
const CONFIRMATION_RELEVANT_STATUSES = [
  "In Progress",
  "Pending Supplier",
  // Legacy statuses for existing tickets
  "Optioned",
  "Confirmed",
  "Reconfirmed",
];

type Recipient = { _id: string; username?: string; email?: string };

export type BookingOpsRunResult = {
  reminders3d: number;
  reminders1d: number;
  escalations: number;
};

function uniqById(items: Recipient[]): Recipient[] {
  const map = new Map<string, Recipient>();
  items.forEach((item) => {
    if (item?._id) map.set(item._id.toString(), item);
  });
  return Array.from(map.values());
}

async function resolveRecipients(card: any): Promise<Recipient[]> {
  const recipients: Recipient[] = [];

  if (card.agent?._id) {
    recipients.push({
      _id: card.agent._id.toString(),
      username: card.agent.username,
      email: card.agent.email,
    });
  }

  if (Array.isArray(card.members)) {
    for (const member of card.members) {
      if (member?._id) {
        recipients.push({
          _id: member._id.toString(),
          username: member.username,
          email: member.email,
        });
      }
    }
  }

  const list: any = card.list;
  const boardId = list?.board?.toString?.();
  if (!boardId) {
    return uniqById(recipients);
  }

  const board = await Board.findById(boardId).populate("members.user", "username email");
  if (!board) {
    return uniqById(recipients);
  }

  if (recipients.length === 0) {
    for (const m of board.members as any[]) {
      if (m.role === "admin" && m.user?._id) {
        recipients.push({
          _id: m.user._id.toString(),
          username: m.user.username,
          email: m.user.email,
        });
      }
    }
  }

  return uniqById(recipients);
}

async function createNotifications(
  card: any,
  recipients: Recipient[],
  message: string
): Promise<number> {
  if (recipients.length === 0) return 0;

  const list: any = card.list;
  const boardId = list?.board?.toString?.();
  const senderId = card.creator?._id?.toString?.() || card.creator?.toString?.();
  if (!senderId) return 0;

  await Notification.insertMany(
    recipients.map((r) => ({
      recipient: r._id,
      sender: senderId,
      type: "due_date",
      card: card._id,
      board: boardId,
      message,
      read: false,
    }))
  );

  emitNotifications(
    recipients.map((r) => ({
      recipient: r._id,
      message,
      type: "due_date",
      card: card._id,
      board: boardId,
    }))
  );

  return recipients.length;
}

export async function runBookingOpsAutomationOnce(): Promise<BookingOpsRunResult> {
  logger.info({ event: "jobs.booking_ops.start" }, "Booking ops automation job started");
  const now = new Date();
  const intervalMs = CHECK_INTERVAL_MS;

  const in3dStart = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000 - intervalMs);
  const in3dEnd = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const in1dStart = new Date(now.getTime() + 24 * 60 * 60 * 1000 - intervalMs);
  const in1dEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const baseFilter = {
    kind: { $ne: "daily_task" },
    archived: { $ne: true },
    status: { $in: ACTIVE_STATUSES },
  };

  const [cards3d, cards1d, escalationCards] = await Promise.all([
    Card.find({
      ...baseFilter,
      arrivalReminder3dSent: { $ne: true },
      $or: [{ arrivalDate: { $gte: in3dStart, $lte: in3dEnd } }, { checkInDate: { $gte: in3dStart, $lte: in3dEnd } }],
    })
      .populate("creator", "username email")
      .populate("agent", "username email")
      .populate("members", "username email")
      .populate("list", "title board"),
    Card.find({
      ...baseFilter,
      arrivalReminder1dSent: { $ne: true },
      $or: [{ arrivalDate: { $gte: in1dStart, $lte: in1dEnd } }, { checkInDate: { $gte: in1dStart, $lte: in1dEnd } }],
    })
      .populate("creator", "username email")
      .populate("agent", "username email")
      .populate("members", "username email")
      .populate("list", "title board"),
    Card.find({
      kind: { $ne: "daily_task" },
      archived: { $ne: true },
      status: { $in: CONFIRMATION_RELEVANT_STATUSES },
      confirmationEscalationSent: { $ne: true },
      $and: [
        { $or: [{ arrivalDate: { $lte: in1dEnd } }, { checkInDate: { $lte: in1dEnd } }] },
        { $or: [{ supplierConfirmationNumber: { $in: ["", null] } }, { hotelConfirmationNumber: { $in: ["", null] } }] },
      ],
    })
      .populate("creator", "username email")
      .populate("agent", "username email")
      .populate("members", "username email")
      .populate("list", "title board"),
  ]);

  let reminders3d = 0;
  let reminders1d = 0;
  let escalations = 0;

  for (const card of cards3d) {
    const arrival = card.arrivalDate || card.checkInDate;
    const dateText = arrival ? new Date(arrival).toLocaleDateString() : "soon";
    const recipients = await resolveRecipients(card);
    const sent = await createNotifications(
      card,
      recipients,
      `Arrival reminder (T-3): "${card.title}" arrives on ${dateText}.`
    );
    if (sent > 0) {
      card.arrivalReminder3dSent = true;
      card.arrivalReminder3dSentAt = new Date();
      await card.save();
      reminders3d += sent;
    }
  }

  for (const card of cards1d) {
    const arrival = card.arrivalDate || card.checkInDate;
    const dateText = arrival ? new Date(arrival).toLocaleDateString() : "tomorrow";
    const recipients = await resolveRecipients(card);
    const sent = await createNotifications(
      card,
      recipients,
      `Arrival reminder (T-1): "${card.title}" arrives on ${dateText}.`
    );
    if (sent > 0) {
      card.arrivalReminder1dSent = true;
      card.arrivalReminder1dSentAt = new Date();
      await card.save();
      reminders1d += sent;
    }
  }

  for (const card of escalationCards) {
    const recipients = await resolveRecipients(card);
    const sent = await createNotifications(
      card,
      recipients,
      `Escalation: "${card.title}" is missing supplier/hotel confirmation close to arrival.`
    );
    if (sent > 0) {
      card.confirmationEscalationSent = true;
      card.confirmationEscalationSentAt = new Date();
      await card.save();
      escalations += sent;
    }
  }

  const result = { reminders3d, reminders1d, escalations };
  logger.info({ event: "jobs.booking_ops.finish", ...result }, "Booking ops automation job finished");
  return result;
}

export function startBookingOpsAutomationJob() {
  const runner = async () => {
    try {
      await runBookingOpsAutomationOnce();
    } catch (error) {
      logger.error({ err: error }, "Booking ops automation job error");
    }
  };

  runner();
  setInterval(runner, CHECK_INTERVAL_MS);
}
