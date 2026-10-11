import mongoose, { Document } from "mongoose";

export type OrderPackageStatus = "draft" | "ready" | "confirmed" | "in_travel" | "completed" | "cancelled";

export interface IOrderPackageItem {
  title: string;
  serviceType: string;
  startDate?: Date | string;
  endDate?: Date | string;
  supplierName?: string;
  supplierReference?: string;
  notes?: string;
}

export interface IOrderPackage extends Document {
  orderId: mongoose.Types.ObjectId | string;
  packageName: string;
  status: OrderPackageStatus;
  startDate?: Date;
  endDate?: Date;
  summary?: string;
  items: IOrderPackageItem[];
  travelerIds: (mongoose.Types.ObjectId | string)[];
  createdAt?: Date;
  updatedAt?: Date;
}

type CustomerTripPackInput = {
  order: {
    orderNumber: string;
    currency: string;
    travelDate?: Date | string;
    items?: Array<{
      description?: string;
      productType?: string;
      serviceStart?: Date | string;
      serviceEnd?: Date | string;
    }>;
  };
  customer?: { customerName?: string; agencyName?: string; email?: string } | null;
  package?: {
    packageName: string;
    status: string;
    summary?: string;
    startDate?: Date | string;
    endDate?: Date | string;
    items?: IOrderPackageItem[];
    travelerIds?: Array<string | mongoose.Types.ObjectId>;
  } | null;
  travelers?: Array<{
    _id: string | mongoose.Types.ObjectId;
    firstName: string;
    lastName: string;
  }>;
};

function toDateOnly(value?: Date | string): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

export function buildCustomerTripPack(input: CustomerTripPackInput) {
  const packageItems = Array.isArray(input.package?.items) ? input.package.items : [];
  const orderItems = Array.isArray(input.order.items) ? input.order.items : [];
  // A package can contain the customer-facing itinerary while order.items is the
  // canonical priced sale list. Prefer the explicit package itinerary when it
  // exists; use order services only for legacy packages without itinerary items.
  const itinerarySource = packageItems.length ? packageItems : orderItems;
  const packageTravelerIds = new Set((input.package?.travelerIds || []).map(String));
  const travelers = (input.travelers || [])
    .filter((traveler) => !packageTravelerIds.size || packageTravelerIds.has(String(traveler._id)))
    .map((traveler) => ({ firstName: traveler.firstName, lastName: traveler.lastName }));

  return {
    order: {
      orderNumber: input.order.orderNumber,
      currency: input.order.currency,
      travelDate: toDateOnly(input.order.travelDate),
    },
    customer: {
      name: input.customer?.customerName || input.customer?.agencyName || "Customer",
      email: input.customer?.email || "",
    },
    package: input.package
      ? {
          packageName: input.package.packageName,
          status: input.package.status,
          summary: input.package.summary || "",
          startDate: toDateOnly(input.package.startDate),
          endDate: toDateOnly(input.package.endDate),
        }
      : null,
    travelers,
    itinerary: itinerarySource.map((item) => ({
      title: String("title" in item ? item.title : item.description || "Travel service"),
      serviceType: String("serviceType" in item ? item.serviceType || "other" : item.productType || "other"),
      startDate: toDateOnly("startDate" in item ? item.startDate : "serviceStart" in item ? item.serviceStart : undefined),
      endDate: toDateOnly("endDate" in item ? item.endDate : "serviceEnd" in item ? item.serviceEnd : undefined),
    })),
  };
}

export function summarizeOrderPackage(input: {
  packageId?: string;
  packageName?: string;
  items?: IOrderPackageItem[];
  orderItems?: Array<{ description?: string; productType?: string; serviceStart?: Date | string; serviceEnd?: Date | string }>;
  status?: string;
  travelerCount?: number;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const orderItems = Array.isArray(input.orderItems) ? input.orderItems : [];
  const serviceCount = orderItems.length || items.length;
  const starts = orderItems.map((item) => item.serviceStart ? new Date(item.serviceStart) : undefined).filter((date): date is Date => Boolean(date && !Number.isNaN(date.getTime())));
  const ends = orderItems.map((item) => item.serviceEnd ? new Date(item.serviceEnd) : undefined).filter((date): date is Date => Boolean(date && !Number.isNaN(date.getTime())));
  const status = String(input.status || "draft").toLowerCase();

  return {
    packageId: input.packageId,
    packageName: String(input.packageName || "Travel package").trim(),
    status,
    travelerCount: Number(input.travelerCount || 0),
    itemCount: serviceCount,
    totalServices: serviceCount,
    startDate: input.startDate ? new Date(input.startDate) : starts.length ? new Date(Math.min(...starts.map((date) => date.getTime()))) : undefined,
    endDate: input.endDate ? new Date(input.endDate) : ends.length ? new Date(Math.max(...ends.map((date) => date.getTime()))) : undefined,
    hasSchedule: items.some((item) => Boolean(item.startDate || item.endDate)) || orderItems.some((item) => Boolean(item.serviceStart || item.serviceEnd)),
  };
}

const orderPackageItemSchema = new mongoose.Schema<IOrderPackageItem>(
  {
    title: { type: String, required: true, trim: true },
    serviceType: { type: String, default: "other", trim: true },
    startDate: { type: Date },
    endDate: { type: Date },
    supplierName: { type: String, default: "" },
    supplierReference: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { _id: false }
);

const orderPackageSchema = new mongoose.Schema<IOrderPackage>(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    packageName: { type: String, required: true, trim: true },
    status: { type: String, enum: ["draft", "ready", "confirmed", "in_travel", "completed", "cancelled"], default: "draft" },
    startDate: { type: Date },
    endDate: { type: Date },
    summary: { type: String, default: "" },
    items: { type: [orderPackageItemSchema], default: [] },
    travelerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "OrderTraveler" }],
  },
  { timestamps: true }
);

export const OrderPackage = mongoose.model<IOrderPackage>("OrderPackage", orderPackageSchema);
