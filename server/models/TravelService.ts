import mongoose, { Document } from "mongoose";

export const TRAVEL_SERVICE_TYPES = [
  "Flight", "Hotel", "Transfer", "Tour", "Activity", "Transportation",
  "Visa", "Insurance", "Guide", "Cruise", "Other",
] as const;
export type TravelServiceType = (typeof TRAVEL_SERVICE_TYPES)[number];

export interface ITravelService extends Document {
  card: mongoose.Types.ObjectId;
  type: TravelServiceType;
  title: string;
  supplierName?: string;
  pricingSource?: string;
  supplierReference?: string;
  currency: string;
  netCost: number;
  sellingPrice: number;
  profit: number;
  marginPercent: number;
  status: "Requested" | "Quoted" | "Optioned" | "Confirmed" | "Cancelled";
  details: Record<string, unknown>;
  notes?: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const travelServiceSchema = new mongoose.Schema<ITravelService>(
  {
    card: { type: mongoose.Schema.Types.ObjectId, ref: "Card", required: true, index: true },
    type: { type: String, enum: TRAVEL_SERVICE_TYPES, required: true },
    title: { type: String, required: true, trim: true },
    supplierName: { type: String, default: "", trim: true },
    pricingSource: { type: String, default: "", trim: true },
    supplierReference: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", uppercase: true, trim: true },
    netCost: { type: Number, default: 0, min: 0 },
    sellingPrice: { type: Number, default: 0, min: 0 },
    profit: { type: Number, default: 0 },
    marginPercent: { type: Number, default: 0 },
    status: { type: String, enum: ["Requested", "Quoted", "Optioned", "Confirmed", "Cancelled"], default: "Requested" },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    notes: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

travelServiceSchema.pre("validate", function calculateFinancials(next) {
  const net = Number(this.netCost || 0);
  const sale = Number(this.sellingPrice || 0);
  this.profit = sale - net;
  this.marginPercent = sale > 0 ? Number(((this.profit / sale) * 100).toFixed(4)) : 0;
  next();
});

travelServiceSchema.index({ card: 1, type: 1 });
export const TravelService = mongoose.model<ITravelService>("TravelService", travelServiceSchema);
