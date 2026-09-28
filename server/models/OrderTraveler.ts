import mongoose, { Document } from "mongoose";

export interface IOrderTraveler extends Document {
  orderId: mongoose.Types.ObjectId | string;
  travelerId?: mongoose.Types.ObjectId | string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  passportNumber?: string;
  nationality?: string;
  dateOfBirth?: Date;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const orderTravelerSchema = new mongoose.Schema<IOrderTraveler>(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    travelerId: { type: mongoose.Schema.Types.ObjectId, ref: "Traveler", default: undefined, index: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    phone: { type: String, default: "", trim: true },
    passportNumber: { type: String, default: "", trim: true },
    nationality: { type: String, default: "", trim: true },
    dateOfBirth: { type: Date },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

export const OrderTraveler = mongoose.model<IOrderTraveler>("OrderTraveler", orderTravelerSchema);
