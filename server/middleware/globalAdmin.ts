import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth.js";
import { canViewAllAnalytics, isGlobalAdmin } from "../lib/accessControl.js";

export function requireGlobalAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (!isGlobalAdmin(req.user)) {
    return res.status(403).json({ message: "Global admin role required" });
  }
  next();
}

export function requireGlobalAnalyticsAccess(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (!canViewAllAnalytics(req.user)) {
    return res.status(403).json({ message: "Analytics admin access required" });
  }
  next();
}
