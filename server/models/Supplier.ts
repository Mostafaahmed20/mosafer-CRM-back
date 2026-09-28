import mongoose, { Document } from "mongoose";

export const SUPPLIER_TYPES = ["DMC", "Hotel", "Flight supplier", "Online portal", "Tour operator", "Transfer company", "Local supplier", "Other"] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];

export interface ISupplier extends Document {
  owner: mongoose.Types.ObjectId;
  name: string;
  type: SupplierType;
  status: "Active" | "Inactive" | "Preferred";
  country?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  website?: string;
  currency?: string;
  paymentTerms?: string;
  contacts: { name: string; role?: string; email?: string; phone?: string }[];
  notes?: string;
}

const supplierSchema = new mongoose.Schema<ISupplier>({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  name: { type: String, required: true, trim: true, index: true },
  type: { type: String, enum: SUPPLIER_TYPES, required: true },
  status: { type: String, enum: ["Active", "Inactive", "Preferred"], default: "Active" },
  country: { type: String, default: "", trim: true },
  email: { type: String, default: "", trim: true, lowercase: true },
  phone: { type: String, default: "", trim: true },
  whatsapp: { type: String, default: "", trim: true },
  website: { type: String, default: "", trim: true },
  currency: { type: String, default: "USD", trim: true, uppercase: true },
  paymentTerms: { type: String, default: "", trim: true },
  contacts: [{ name: { type: String, required: true }, role: { type: String, default: "" }, email: { type: String, default: "" }, phone: { type: String, default: "" } }],
  notes: { type: String, default: "" },
}, { timestamps: true });

supplierSchema.index({ owner: 1, name: 1 }, { unique: true });
export const Supplier = mongoose.model<ISupplier>("Supplier", supplierSchema);
