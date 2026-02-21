import { Activity } from "../models/Activity.js";
import { Board } from "../models/Board.js";
import { Notification } from "../models/Notification.js";
import { getSocketInstance } from "../socket.js";
import { emitNotifications } from "./notify.js";

type RecordActivityParams = {
  boardId: string;
  actorId: string;
  type: string;
  message: string;
  listId?: string;
  cardId?: string;
  meta?: Record<string, unknown>;
  notifyMembers?: boolean;
};

export async function recordActivity({
  boardId,
  actorId,
  type,
  message,
  listId,
  cardId,
  meta,
  notifyMembers = false,
}: RecordActivityParams) {
  const activity = new Activity({
    board: boardId,
    list: listId,
    card: cardId,
    actor: actorId,
    type,
    message,
    meta,
  });

  await activity.save();
  await activity.populate("actor", "username email");

  if (notifyMembers) {
    try {
      const board = await Board.findById(boardId).populate("members.user", "username email");
      if (board) {
        const actor = activity.actor as any;
        const actorName = actor?.username || "Someone";
        const messageWithActor = `${actorName} ${message}`;

        const recipients = board.members
          .map((m: any) => m.user)
          .filter((u: any) => u && u._id.toString() !== actorId);

        if (recipients.length > 0) {
          const notifications = recipients.map((u: any) => ({
            recipient: u._id,
            sender: actorId,
            type: "activity" as const,
            card: cardId,
            board: boardId,
            message: messageWithActor,
            read: false,
          }));
          await Notification.insertMany(notifications);
          emitNotifications(
            notifications.map((n) => ({
              recipient: n.recipient?.toString?.() || n.recipient,
              message: n.message,
              type: n.type,
              card: n.card,
              board: n.board,
            }))
          );
        }
      }
    } catch (notifyError) {
      console.error("Activity notification error:", notifyError);
    }
  }

  try {
    const io = getSocketInstance();
    io.to(`board:${boardId}`).emit("activity:created", { activity });
  } catch (socketError) {
    console.error("Socket broadcast error (activity):", socketError);
  }

  return activity;
}
