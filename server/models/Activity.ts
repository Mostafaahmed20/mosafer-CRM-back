import mongoose, { Document } from "mongoose";

export interface IActivity extends Document {
  board: mongoose.Types.ObjectId;
  list?: mongoose.Types.ObjectId;
  card?: mongoose.Types.ObjectId;
  actor: mongoose.Types.ObjectId;
  type: string;
  message: string;
  meta?: Record<string, unknown>;
}

const activitySchema = new mongoose.Schema<IActivity>(
  {
    board: { type: mongoose.Schema.Types.ObjectId, ref: "Board", required: true },
    list: { type: mongoose.Schema.Types.ObjectId, ref: "List" },
    card: { type: mongoose.Schema.Types.ObjectId, ref: "Card" },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true },
    message: { type: String, required: true },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

export const Activity = mongoose.model<IActivity>("Activity", activitySchema);
