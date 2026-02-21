import mongoose, { Document } from "mongoose";

export interface INotification extends Document {
  recipient: mongoose.Types.ObjectId;
  sender: mongoose.Types.ObjectId;
  type:
    | "comment"
    | "mention"
    | "card_assigned"
    | "board_invite"
    | "card_moved"
    | "due_date"
    | "activity";
  card?: mongoose.Types.ObjectId;
  board?: mongoose.Types.ObjectId;
  message: string;
  commentText?: string;
  read: boolean;
  createdAt: Date;
}

const notificationSchema = new mongoose.Schema<INotification>(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: ["comment", "mention", "card_assigned", "board_invite", "card_moved", "due_date", "activity"],
      required: true,
    },
    card: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Card",
    },
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Board",
    },
    message: {
      type: String,
      required: true,
    },
    commentText: {
      type: String,
    },
    read: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Index for faster queries
notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>(
  "Notification",
  notificationSchema
);
