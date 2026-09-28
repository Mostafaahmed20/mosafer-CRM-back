import mongoose, { Document } from "mongoose";

export const CUSTOMER_DECISION_ROLES = [
  "Group Admin",
  "CEO",
  "Manager",
  "Decision Maker",
  "Owner",
  "Operations",
  "Finance",
  "Sales",
  "Procurement",
  "Reservations",
  "Travel Consultant",
  "Admin",
  "Other",
] as const;

export type CustomerDecisionRole = (typeof CUSTOMER_DECISION_ROLES)[number];

export interface ICustomerProfile extends Document {
  owner: mongoose.Types.ObjectId;
  agencyName: string;
  // `agencyName` is retained for existing records; new UI and API use customerName.
  customerName?: string;
  phone?: string;
  country?: string;
  language?: string;
  bookingValue?: string;
  location: string;
  email: string;
  decisionRole: CustomerDecisionRole;
}

const customerProfileSchema = new mongoose.Schema<ICustomerProfile>(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    agencyName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    customerName: { type: String, default: "", trim: true, index: true },
    phone: { type: String, default: "", trim: true },
    country: { type: String, default: "", trim: true },
    language: { type: String, default: "", trim: true },
    bookingValue: { type: String, default: "", trim: true },
    location: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    decisionRole: {
      type: String,
      enum: CUSTOMER_DECISION_ROLES,
      required: true,
    },
  },
  { timestamps: true }
);

customerProfileSchema.index({ owner: 1, createdAt: -1 });
customerProfileSchema.index({ owner: 1, email: 1 }, { unique: true });
customerProfileSchema.index({ owner: 1, agencyName: 1 }, { unique: true });

export const CustomerProfile = mongoose.model<ICustomerProfile>(
  "CustomerProfile",
  customerProfileSchema
);
