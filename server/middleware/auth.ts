import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { normalizeUserRole, normalizeWorkflowRoles } from "../lib/accessControl.js";

const JWT_SECRET = env.JWT_SECRET;

export interface AuthRequest extends Request {
  userId?: string;
  user?: {
    id: string;
    role: "user" | "admin";
    workflowRoles: Array<"sales" | "operations" | "accounting">;
    emailVerified: boolean;
    canViewAllAnalytics: boolean;
    username?: string;
    email?: string;
  };
}

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await User.findById(decoded.userId).select(
      "_id role workflowRoles emailVerified canViewAllAnalytics username email"
    );
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    req.userId = String(user._id);
    req.user = {
      id: String(user._id),
      role: normalizeUserRole(user.role),
      workflowRoles: normalizeWorkflowRoles((user as any).workflowRoles, user.role),
      emailVerified: Boolean(user.emailVerified),
      canViewAllAnalytics: Boolean((user as any).canViewAllAnalytics),
      username: user.username,
      email: user.email,
    };
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

export function generateToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
}

export async function requireVerifiedEmail(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (req.user) {
    if (!req.user.emailVerified) {
      return res.status(403).json({
        message: "Please verify your email before accessing this resource",
        code: "EMAIL_NOT_VERIFIED",
      });
    }
    return next();
  }

  try {
    const user = await User.findById(req.userId).select("emailVerified");
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    if (!user.emailVerified) {
      return res.status(403).json({
        message: "Please verify your email before accessing this resource",
        code: "EMAIL_NOT_VERIFIED",
      });
    }
    next();
  } catch {
    return res.status(500).json({ message: "Server error" });
  }
}

export function requireWorkflowRole(required: "sales" | "operations" | "accounting") {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.role === "admin" || req.user?.workflowRoles?.includes(required)) return next();
    return res.status(403).json({ message: `${required[0].toUpperCase()}${required.slice(1)} role required`, code: "WORKFLOW_ROLE_REQUIRED", requiredRole: required });
  };
}
