import mongoose, { Document } from "mongoose";

export interface ICustomerTraveler extends Document {
  customerId: mongoose.Types.ObjectId;
  travelerId: mongoose.Types.ObjectId;
  relationship?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const customerTravelerSchema = new mongoose.Schema<ICustomerTraveler>(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerProfile", required: true, index: true },
    travelerId: { type: mongoose.Schema.Types.ObjectId, ref: "Traveler", required: true, index: true },
    relationship: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

customerTravelerSchema.index({ customerId: 1, travelerId: 1 }, { unique: true });

export const CustomerTraveler = mongoose.model<ICustomerTraveler>("CustomerTraveler", customerTravelerSchema);
