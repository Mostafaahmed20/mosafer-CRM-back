import mongoose, { Document } from "mongoose";

export interface ICoverageSlot extends Document {
  businessDate: string;
  memberId: mongoose.Types.ObjectId;
  channel: string;
  taskWindow: string;
  scheduleWindow: string;
  additionalDuty?: string;
  notes?: string;
  createdBy?: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const coverageSlotSchema = new mongoose.Schema<ICoverageSlot>(
  {
    businessDate: { type: String, required: true, trim: true, index: true },
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    channel: { type: String, required: true, trim: true },
    taskWindow: { type: String, required: true, trim: true },
    scheduleWindow: { type: String, required: true, trim: true },
    additionalDuty: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true, collection: "coverage_slots" }
);

coverageSlotSchema.index({ businessDate: 1, memberId: 1, channel: 1 }, { unique: true });

export const CoverageSlot = mongoose.model<ICoverageSlot>("CoverageSlot", coverageSlotSchema);
