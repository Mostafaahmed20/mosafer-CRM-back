import mongoose, { Document } from "mongoose";

export interface IBoardMessage extends Document {
  board: mongoose.Types.ObjectId;
  author: mongoose.Types.ObjectId;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

const boardMessageSchema = new mongoose.Schema<IBoardMessage>(
  {
    board: { type: mongoose.Schema.Types.ObjectId, ref: "Board", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
  },
  { timestamps: true }
);

boardMessageSchema.index({ board: 1, createdAt: -1 });

export const BoardMessage = mongoose.model<IBoardMessage>("BoardMessage", boardMessageSchema);
