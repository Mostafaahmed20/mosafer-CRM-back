import mongoose, { Document } from "mongoose";

export interface IQuotationLine {
  serviceType: "Flight" | "Hotel" | "Tour" | "Transfer" | "Other";
  description: string;
  supplierName?: string;
  quantity: number;
  netRate: number;
  sellingRate: number;
}

export interface IQuotation extends Document {
  card: mongoose.Types.ObjectId;
  version: number;
  status: "Draft" | "Sent" | "Accepted" | "Rejected" | "Expired";
  currency: string;
  lines: IQuotationLine[];
  notes?: string;
  createdBy: mongoose.Types.ObjectId;
  sentAt?: Date;
  acceptedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const quotationSchema = new mongoose.Schema<IQuotation>(
  {
    card: { type: mongoose.Schema.Types.ObjectId, ref: "Card", required: true, index: true },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ["Draft", "Sent", "Accepted", "Rejected", "Expired"], default: "Draft" },
    currency: { type: String, default: "USD", uppercase: true, trim: true },
    lines: [{
      serviceType: { type: String, enum: ["Flight", "Hotel", "Tour", "Transfer", "Other"], required: true },
      description: { type: String, default: "" },
      supplierName: { type: String, default: "", trim: true },
      quantity: { type: Number, default: 1, min: 1 },
      netRate: { type: Number, default: 0, min: 0 },
      sellingRate: { type: Number, default: 0, min: 0 },
    }],
    notes: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sentAt: { type: Date },
    acceptedAt: { type: Date },
  },
  { timestamps: true }
);

quotationSchema.index({ card: 1, version: 1 }, { unique: true });

export const Quotation = mongoose.model<IQuotation>("Quotation", quotationSchema);
