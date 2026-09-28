import mongoose, { Document } from "mongoose";

export type DailyTaskRecurrence = {
  pattern: "daily" | "weekdays" | "weekly" | "custom";
  daysOfWeek?: number[];
};

export interface IDailyTaskTemplate extends Document {
  title: string;
  description?: string;
  recurrence: DailyTaskRecurrence;
  shift: string;
  defaultAssigneeMode: "coverage_owner" | "fixed" | "unassigned";
  active: boolean;
  defaultAssigneeIds: mongoose.Types.ObjectId[];
  channel?: string;
  dutyLabel?: string;
  taskWindow?: string;
  scheduleWindow?: string;
  createdBy?: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const recurrenceSchema = new mongoose.Schema<DailyTaskRecurrence>(
  {
    pattern: {
      type: String,
      enum: ["daily", "weekdays", "weekly", "custom"],
      required: true,
      default: "daily",
    },
    daysOfWeek: [{ type: Number, min: 0, max: 6 }],
  },
  { _id: false }
);

const dailyTaskTemplateSchema = new mongoose.Schema<IDailyTaskTemplate>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    recurrence: { type: recurrenceSchema, required: true },
    shift: { type: String, required: true, trim: true },
    defaultAssigneeMode: {
      type: String,
      enum: ["coverage_owner", "fixed", "unassigned"],
      required: true,
      default: "unassigned",
    },
    active: { type: Boolean, default: true, index: true },
    defaultAssigneeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    channel: { type: String, default: "", trim: true },
    dutyLabel: { type: String, default: "", trim: true },
    taskWindow: { type: String, default: "", trim: true },
    scheduleWindow: { type: String, default: "", trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true, collection: "daily_task_templates" }
);

dailyTaskTemplateSchema.index({ active: 1, shift: 1 });

export const DailyTaskTemplate = mongoose.model<IDailyTaskTemplate>(
  "DailyTaskTemplate",
  dailyTaskTemplateSchema
);
