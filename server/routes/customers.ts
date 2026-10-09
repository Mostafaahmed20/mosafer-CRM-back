import { Router, Response } from "express";
import {
  CustomerProfile,
  CUSTOMER_DECISION_ROLES,
} from "../models/CustomerProfile.js";
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findDuplicateCustomer({
  owner,
  agencyName,
  email,
  excludeId,
}: {
  owner: string;
  agencyName?: string;
  email?: string;
  excludeId?: string;
}) {
  const base = excludeId ? { _id: { $ne: excludeId }, owner } : { owner };

  if (agencyName) {
    const byAgency = await CustomerProfile.findOne({
      ...base,
      agencyName: { $regex: `^${escapeRegex(agencyName)}$`, $options: "i" },
    }).select("_id");
    if (byAgency) {
      return { field: "agencyName" as const };
    }
  }

  if (email) {
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

function duplicateMessage(field: "agencyName" | "email") {
  return field === "agencyName"
    ? "Agency name already exists"
    : "Email already exists";
}

// GET /api/customers - List current user's customer profiles
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const customers = await CustomerProfile.find({ owner: req.userId })
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
    if (!location?.trim()) {
      return res.status(400).json({ message: "location is required" });
    }
    if (!email?.trim()) {
      return res.status(400).json({ message: "email is required" });
    }
    if (!decisionRole?.trim()) {
      return res.status(400).json({ message: "decisionRole is required" });
    }

    if (!CUSTOMER_DECISION_ROLES.includes(decisionRole as any)) {
      return res.status(400).json({
        message: "Invalid decisionRole",
        allowedValues: CUSTOMER_DECISION_ROLES,
      });
    }

    const normalizedAgencyName = displayName;
    const normalizedEmail = email.trim().toLowerCase();

    const duplicate = await findDuplicateCustomer({
      owner: req.userId!,
      agencyName: normalizedAgencyName,
      email: normalizedEmail,
    });
    if (duplicate) {
      return res.status(409).json({ message: duplicateMessage(duplicate.field) });
    }

    const customer = new CustomerProfile({
      owner: req.userId,
      agencyName: normalizedAgencyName,
      customerName: normalizedAgencyName,
      phone: String(phone || "").trim(),
      country: String(country || "").trim(),
      language: String(language || "").trim(),
      bookingValue: String(bookingValue || "").trim(),
      location: location.trim(),
      email: normalizedEmail,
      decisionRole,
    });

    await customer.save();
    res.status(201).json(customer);
  } catch (error: any) {
    if (error?.code === 11000) {
      const key = Object.keys(error?.keyPattern || {})[0];
      if (key === "email") {
        return res.status(409).json({ message: "Email already exists" });
      }
      if (key === "agencyName") {
        return res.status(409).json({ message: "Agency name already exists" });
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

    if (location !== undefined) {
      if (!String(location).trim()) {
        return res.status(400).json({ message: "location cannot be empty" });
      }
      customer.location = String(location).trim();
    }

    if (email !== undefined) {
      if (!String(email).trim()) {
        return res.status(400).json({ message: "email cannot be empty" });
      }
      customer.email = String(email).trim().toLowerCase();
    }

    if (decisionRole !== undefined) {
      if (!String(decisionRole).trim()) {
        return res.status(400).json({ message: "decisionRole cannot be empty" });
      }
      if (!CUSTOMER_DECISION_ROLES.includes(String(decisionRole) as any)) {
        return res.status(400).json({
          message: "Invalid decisionRole",
          allowedValues: CUSTOMER_DECISION_ROLES,
        });
      }
      customer.decisionRole = String(decisionRole) as any;
    }

    if (phone !== undefined) customer.phone = String(phone).trim();
    if (country !== undefined) customer.country = String(country).trim();
    if (language !== undefined) customer.language = String(language).trim();
    if (bookingValue !== undefined) customer.bookingValue = String(bookingValue).trim();

    const duplicate = await findDuplicateCustomer({
      owner: req.userId!,
      agencyName: customer.agencyName,
      email: customer.email,
      excludeId: req.params.id,
    });
    if (duplicate) {
      return res.status(409).json({ message: duplicateMessage(duplicate.field) });
    }

    await customer.save();
    res.json(customer);
  } catch (error: any) {
    if (error?.code === 11000) {
      const key = Object.keys(error?.keyPattern || {})[0];
      if (key === "email") {
        return res.status(409).json({ message: "Email already exists" });
      }
      if (key === "agencyName") {
        return res.status(409).json({ message: "Agency name already exists" });
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
