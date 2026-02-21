import mongoose, { Document } from "mongoose";

export interface IList extends Document {
  title: string;
  board: mongoose.Types.ObjectId;
  position: number;
  archived: boolean;
}

const listSchema = new mongoose.Schema<IList>(
  {
    title: { type: String, required: true },
    board: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Board",
      required: true,
    },
    position: { type: Number, default: 0 },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const List = mongoose.model<IList>("List", listSchema);
