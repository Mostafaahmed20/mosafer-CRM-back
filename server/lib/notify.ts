import { getSocketInstance } from "../socket.js";

export function emitNotifications(
  notifications: Array<{
    recipient: string;
    message: string;
    type: string;
    card?: any;
    board?: any;
    commentText?: string;
  }>
) {
  try {
    const io = getSocketInstance();
    notifications.forEach((n) => {
      io.to(`user:${n.recipient}`).emit("notification:new", n);
    });
  } catch (err) {
    console.error("emitNotifications error:", err);
  }
}
