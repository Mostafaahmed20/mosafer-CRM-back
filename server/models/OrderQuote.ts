import mongoose, { Document } from "mongoose";

export type OrderQuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "expired";

export interface IOrderQuoteLine {
  description: string;
  quantity: number;
  netRate: number;
  sellingRate: number;
  serviceType?: string;
}

export interface IOrderQuote extends Document {
  orderId: mongoose.Types.ObjectId | string;
  version: number;
  status: OrderQuoteStatus;
  currency: string;
  lines: IOrderQuoteLine[];
  notes?: string;
  createdBy?: mongoose.Types.ObjectId | string;
  sentAt?: Date;
  acceptedAt?: Date;
  lockedTotal?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export function calculateQuoteTotal(lines: IOrderQuoteLine[] = []) {
  return lines.reduce((total, line) => {
    const quantity = Number(line.quantity || 0);
    const sellingRate = Number(line.sellingRate || 0);
    return total + quantity * sellingRate;
  }, 0);
}

export function applyQuoteAcceptance(quotes: Array<{ status?: string; lines?: IOrderQuoteLine[]; acceptedAt?: Date | string | null; lockedTotal?: number }> = []) {
  if (!Array.isArray(quotes) || quotes.length === 0) return [];

  return quotes.map((quote, index) => {
    const lines = Array.isArray(quote.lines) ? quote.lines : [];
    const total = calculateQuoteTotal(lines);
    const status = String(quote.status || "draft").toLowerCase();

    if (status === "accepted" || index === quotes.length - 1) {
      return {
        ...quote,
        status: "accepted",
        acceptedAt: quote.acceptedAt ? new Date(quote.acceptedAt) : new Date(),
        lockedTotal: quote.lockedTotal ?? total,
      };
    }

    return {
      ...quote,
      status,
      acceptedAt: quote.acceptedAt ? new Date(quote.acceptedAt) : undefined,
      lockedTotal: typeof quote.lockedTotal === "number" ? quote.lockedTotal : total,
    };
  });
}

const orderQuoteLineSchema = new mongoose.Schema<IOrderQuoteLine>(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1, min: 1 },
    netRate: { type: Number, default: 0, min: 0 },
    sellingRate: { type: Number, default: 0, min: 0 },
    serviceType: { type: String, default: "other" },
  },
  { _id: false }
);

const orderQuoteSchema = new mongoose.Schema<IOrderQuote>(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    version: { type: Number, default: 1, min: 1 },
    status: { type: String, enum: ["draft", "sent", "accepted", "rejected", "expired"], default: "draft" },
    currency: { type: String, default: "USD", uppercase: true, trim: true },
    lines: { type: [orderQuoteLineSchema], default: [] },
    notes: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    sentAt: { type: Date },
    acceptedAt: { type: Date },
    lockedTotal: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

orderQuoteSchema.index({ orderId: 1, version: 1 }, { unique: true });

export const OrderQuote = mongoose.model<IOrderQuote>("OrderQuote", orderQuoteSchema);
