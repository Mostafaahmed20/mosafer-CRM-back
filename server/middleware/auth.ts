import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { env } from "../config/env.js";

const JWT_SECRET = env.JWT_SECRET;

export interface AuthRequest extends Request {
  userId?: string;
}

export function authMiddleware(
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
    req.userId = decoded.userId;
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
