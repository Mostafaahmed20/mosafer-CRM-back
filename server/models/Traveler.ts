import mongoose, { Document } from "mongoose";

export interface ITraveler extends Document {
  ownerId: mongoose.Types.ObjectId;
  firstName: string;
  lastName: string;
  displayNameArabic?: string;
  email?: string;
  phone?: string;
  nationality?: string;
  dateOfBirth?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const travelerSchema = new mongoose.Schema<ITraveler>(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    displayNameArabic: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    phone: { type: String, default: "", trim: true },
    nationality: { type: String, default: "", trim: true },
    dateOfBirth: { type: Date },
  },
  { timestamps: true }
);

export const Traveler = mongoose.model<ITraveler>("Traveler", travelerSchema);
