import { Router, Response } from "express";
import { CustomerProfile } from "../models/CustomerProfile.js";
import {
  AuthRequest,
  authMiddleware,
  requireVerifiedEmail,
} from "../middleware/auth.js";
import { User } from "../models/User.js";
import { normalizeUserRole } from "../lib/accessControl.js";

const router = Router();

router.use(authMiddleware, requireVerifiedEmail);

async function isAdminUser(userId?: string): Promise<boolean> {
  if (!userId) return false;
  const user = await User.findById(userId).select("role");
  return normalizeUserRole((user as any)?.role) === "admin";
}

async function findDuplicateCustomer({ owner, email, excludeId }: {
  owner: string;
  email?: string;
  excludeId?: string;
}) {
  const base = excludeId ? { _id: { $ne: excludeId }, owner } : { owner };

  if (email?.trim()) {
    const byEmail = await CustomerProfile.findOne({
      ...base,
      email: email.toLowerCase(),
    }).select("_id");
    if (byEmail) {
      return { field: "email" as const };
    }
  }

  return null;
}

function duplicateMessage() { return "Email already exists"; }

// GET /api/customers - List shared customer profiles for the CRM workspace
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const customers = await CustomerProfile.find({})
      .sort({ createdAt: -1 });

    res.json(customers);
  } catch (error) {
    console.error("Get customers error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/customers - Create a customer profile for the current user
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const {
      agencyName, customerName,
      phone, country, language, bookingValue,
      location,
      email,
      decisionRole,
    }: {
      agencyName?: string; customerName?: string;
      phone?: string; country?: string; language?: string; bookingValue?: string;
      location?: string;
      email?: string;
      decisionRole?: string;
    } = req.body || {};

    const displayName = String(customerName || agencyName || "").trim();
    if (!displayName) {
      return res.status(400).json({ message: "customerName is required" });
    }
    const normalizedAgencyName = displayName;
    const normalizedEmail = String(email || "").trim().toLowerCase();

    const duplicate = await findDuplicateCustomer({
      owner: req.userId!,
      email: normalizedEmail,
    });
    if (duplicate) {
      return res.status(409).json({ message: duplicateMessage() });
    }

    const customer = new CustomerProfile({
      owner: req.userId,
      agencyName: normalizedAgencyName,
      customerName: normalizedAgencyName,
      phone: String(phone || "").trim(),
      country: String(country || "").trim(),
      language: String(language || "").trim(),
      bookingValue: String(bookingValue || "").trim(),
      location: String(location || "").trim(),
      email: normalizedEmail,
      decisionRole: decisionRole || "Other",
    });

    await customer.save();
    res.status(201).json(customer);
  } catch (error: any) {
    if (error?.code === 11000) {
      const key = Object.keys(error?.keyPattern || {})[0];
      if (key === "email") {
        return res.status(409).json({ message: "Email already exists" });
      }
      return res.status(409).json({ message: "Customer profile already exists" });
    }
    console.error("Create customer error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/customers/:id - Update current user's customer profile
router.patch("/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!(await isAdminUser(req.userId))) {
      return res.status(403).json({ message: "Admin role required" });
    }

    const customer = await CustomerProfile.findOne({
      _id: req.params.id,
      owner: req.userId,
    });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    const {
      agencyName, customerName,
      phone, country, language, bookingValue,
      location,
      email,
      decisionRole,
    }: {
      agencyName?: string; customerName?: string;
      phone?: string; country?: string; language?: string; bookingValue?: string;
      location?: string;
      email?: string;
      decisionRole?: string;
    } = req.body || {};

    if (agencyName !== undefined || customerName !== undefined) {
      const nextName = String(customerName ?? agencyName ?? "").trim();
      if (!nextName) {
        return res.status(400).json({ message: "customerName cannot be empty" });
      }
      customer.agencyName = nextName;
      customer.customerName = nextName;
    }

    if (location !== undefined) customer.location = String(location).trim();

    if (email !== undefined) {
      customer.email = String(email).trim().toLowerCase();
    }

    if (decisionRole !== undefined) customer.decisionRole = String(decisionRole || "Other") as any;

    if (phone !== undefined) customer.phone = String(phone).trim();
    if (country !== undefined) customer.country = String(country).trim();
    if (language !== undefined) customer.language = String(language).trim();
    if (bookingValue !== undefined) customer.bookingValue = String(bookingValue).trim();

    const duplicate = await findDuplicateCustomer({
      owner: req.userId!,
      email: customer.email,
      excludeId: req.params.id,
    });
    if (duplicate) {
      return res.status(409).json({ message: duplicateMessage() });
    }

    await customer.save();
    res.json(customer);
  } catch (error: any) {
    if (error?.code === 11000) {
      const key = Object.keys(error?.keyPattern || {})[0];
      if (key === "email") {
        return res.status(409).json({ message: "Email already exists" });
      }
      return res.status(409).json({ message: "Customer profile already exists" });
    }
    console.error("Update customer error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/customers/:id - Remove current user's customer profile
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    if (!(await isAdminUser(req.userId))) {
      return res.status(403).json({ message: "Admin role required" });
    }

    const deleted = await CustomerProfile.findOneAndDelete({
      _id: req.params.id,
      owner: req.userId,
    });

    if (!deleted) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json({ message: "Customer deleted" });
  } catch (error) {
    console.error("Delete customer error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
