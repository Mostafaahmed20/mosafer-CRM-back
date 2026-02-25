import mongoose, { Document } from "mongoose";

export interface ICard extends Document {
  title: string;
  subject?: string;
  requester?: string;
  bookingRef?: string;
  agencyName?: string;
  hotelName?: string;
  supplierName?: string;
  supplierConfirmationNumber?: string;
  hotelConfirmationNumber?: string;
  voucherNumber?: string;
  checkInDate?: Date;
  checkOutDate?: Date;
  arrivalDate?: Date;
  paymentStatus?: string;
  coveringStatus?: "Requested" | "Paid by VCC" | "Invoiced to agency";
  netPaidToHotel?: number;
  sellToAgency?: number;
  type?: string;
  status?: string;
  priority?: string;
  group?: string;
  agent?: mongoose.Types.ObjectId;
  source?: string;
  handoverStatus?: "Not set" | "Resolved in shift" | "Pending for next shift";
  handoverSummary?: string;
  handoverDone?: string;
  handoverPending?: string;
  handoverPendingState?: "Yes" | "No";
  handoverBlocker?: string;
  handoverNextAction?: string;
  handoverNextOwner?: string;
  handoverUpdatedAt?: Date;
  handoverUpdatedBy?: mongoose.Types.ObjectId;
  handoverReminderSentAt?: Date;
  handoverReminderCount?: number;
  description: string;
  list: mongoose.Types.ObjectId;
  creator: mongoose.Types.ObjectId;
  position: number;
  dueDate?: Date;
  dueComplete: boolean;
  completedAt?: Date;
  dueReminder24hSent?: boolean;
  dueReminder24hSentAt?: Date;
  dueReminder1hSent?: boolean;
  dueReminder1hSentAt?: Date;
  dueReminderDueSent?: boolean;
  dueReminderDueSentAt?: Date;
  arrivalReminder3dSent?: boolean;
  arrivalReminder3dSentAt?: Date;
  arrivalReminder1dSent?: boolean;
  arrivalReminder1dSentAt?: Date;
  confirmationEscalationSent?: boolean;
  confirmationEscalationSentAt?: Date;
  pinned?: boolean;
  labels: { color: string; text: string }[];
  members: mongoose.Types.ObjectId[];
  comments: {
    _id?: mongoose.Types.ObjectId;
    text: string;
    author: mongoose.Types.ObjectId;
    createdAt: Date;
  }[];
  attachments: { name: string; url: string; type: string }[];
  checklists: {
    _id?: mongoose.Types.ObjectId;
    title: string;
    items: { _id?: mongoose.Types.ObjectId; text: string; completed: boolean }[];
  }[];
  serviceOrders: {
    _id?: mongoose.Types.ObjectId;
    service: string;
    quantity: number;
    price: number;
    currency: string;
    status: "Requested" | "In Progress" | "Completed" | "Cancelled";
    paymentStatus: "Unpaid" | "Partially paid" | "Paid";
    notes?: string;
  }[];
  cover?: string;
  archived: boolean;
  slaType?: string;
  slaDueAt?: Date;
  slaStartedAt?: Date;
  slaStatus?: "Open" | "Breached" | "Met" | "N/A";
  createdAt?: Date;
  updatedAt?: Date;
}

export const CARD_STATUSES = [
  "New",
  "In Progress",
  "Pending Supplier",
  "Pending Client",
  "Completed",
  "Closed",
  "Cancelled",
  // Legacy statuses kept for backward compatibility.
  "Requested",
  "Quoted",
  "Optioned",
  "Confirmed",
  "Reconfirmed",
  "In-house",
  "Open",
  "Pending",
  "Resolved",
] as const;

export const CARD_PAYMENT_STATUSES = [
  "Not required",
  "Pending",
  "Partially paid",
  "Paid",
] as const;

const cardSchema = new mongoose.Schema<ICard>(
  {
    title: { type: String, required: true },
    subject: { type: String, default: "" },
    requester: { type: String, default: "" },
    bookingRef: { type: String, default: "" },
    agencyName: { type: String, default: "" },
    hotelName: { type: String, default: "" },
    supplierName: { type: String, default: "" },
    supplierConfirmationNumber: { type: String, default: "" },
    hotelConfirmationNumber: { type: String, default: "" },
    voucherNumber: { type: String, default: "" },
    checkInDate: { type: Date },
    checkOutDate: { type: Date },
    arrivalDate: { type: Date },
    paymentStatus: { type: String, enum: CARD_PAYMENT_STATUSES, default: "Not required" },
    coveringStatus: {
      type: String,
      enum: ["Requested", "Paid by VCC", "Invoiced to agency"],
      default: "Requested",
    },
    netPaidToHotel: { type: Number, default: 0 },
    sellToAgency: { type: Number, default: 0 },
    type: { type: String, default: "Booking request" },
    status: { type: String, enum: CARD_STATUSES, default: "New" },
    priority: { type: String, default: "Medium" },
    group: { type: String, default: "Operations" },
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    source: { type: String, default: "Agency" },
    handoverStatus: {
      type: String,
      enum: ["Not set", "Resolved in shift", "Pending for next shift"],
      default: "Not set",
    },
    handoverSummary: { type: String, default: "" },
    handoverDone: { type: String, default: "" },
    handoverPending: { type: String, default: "" },
    handoverPendingState: { type: String, enum: ["Yes", "No"], default: "No" },
    handoverBlocker: { type: String, default: "" },
    handoverNextAction: { type: String, default: "" },
    handoverNextOwner: { type: String, default: "" },
    handoverUpdatedAt: { type: Date },
    handoverUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    handoverReminderSentAt: { type: Date },
    handoverReminderCount: { type: Number, default: 0 },
    description: { type: String, default: "" },
    list: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "List",
      required: true,
    },
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    position: { type: Number, default: 0 },
    dueDate: { type: Date },
    dueComplete: { type: Boolean, default: false },
    completedAt: { type: Date },
    dueReminder24hSent: { type: Boolean, default: false },
    dueReminder24hSentAt: { type: Date },
    dueReminder1hSent: { type: Boolean, default: false },
    dueReminder1hSentAt: { type: Date },
    dueReminderDueSent: { type: Boolean, default: false },
    dueReminderDueSentAt: { type: Date },
    arrivalReminder3dSent: { type: Boolean, default: false },
    arrivalReminder3dSentAt: { type: Date },
    arrivalReminder1dSent: { type: Boolean, default: false },
    arrivalReminder1dSentAt: { type: Date },
    confirmationEscalationSent: { type: Boolean, default: false },
    confirmationEscalationSentAt: { type: Date },
    pinned: { type: Boolean, default: false },
    labels: [
      {
        color: { type: String },
        text: { type: String, default: "" },
      },
    ],
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    comments: [
      {
        text: { type: String, required: true },
        author: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    attachments: [
      {
        name: { type: String },
        url: { type: String },
        type: { type: String },
      },
    ],
    checklists: [
      {
        title: { type: String },
        items: [
          {
            text: { type: String },
            completed: { type: Boolean, default: false },
          },
        ],
      },
    ],
    serviceOrders: [
      {
        service: { type: String, default: "" },
        quantity: { type: Number, default: 1 },
        price: { type: Number, default: 0 },
        currency: { type: String, default: "USD" },
        status: {
          type: String,
          enum: ["Requested", "In Progress", "Completed", "Cancelled"],
          default: "Requested",
        },
        paymentStatus: {
          type: String,
          enum: ["Unpaid", "Partially paid", "Paid"],
          default: "Unpaid",
        },
        notes: { type: String, default: "" },
      },
    ],
    cover: { type: String },
    archived: { type: Boolean, default: false },
    slaType: { type: String, default: "first_response" },
    slaDueAt: { type: Date },
    slaStartedAt: { type: Date },
    slaStatus: { type: String, enum: ["Open", "Breached", "Met", "N/A"], default: "Open" },
  },
  { timestamps: true }
);

export const Card = mongoose.model<ICard>("Card", cardSchema);
