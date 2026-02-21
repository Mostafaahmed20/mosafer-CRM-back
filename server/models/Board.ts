import mongoose, { Document } from "mongoose";

export const BOARD_ROLES = ["admin", "member", "observer", "guest"] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

export interface IBoardMember {
  user: mongoose.Types.ObjectId;
  role: BoardRole;
}

export interface IBoard extends Document {
  title: string;
  description: string;
  background: string;
  owner: mongoose.Types.ObjectId;
  members: IBoardMember[];
  labels: { color: string; text: string }[];
}

const boardSchema = new mongoose.Schema<IBoard>(
  {
    title: { type: String, required: true },
    description: { type: String, default: "" },
    background: { type: String, default: "blue" },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    members: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        role: {
          type: String,
          enum: BOARD_ROLES,
          default: "member",
        },
      },
    ],
    labels: [
      {
        color: { type: String },
        text: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true }
);

export const Board = mongoose.model<IBoard>("Board", boardSchema);
