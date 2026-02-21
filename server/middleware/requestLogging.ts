import crypto from "crypto";
import pinoHttp from "pino-http";
import type { NextFunction, Request, Response } from "express";
import type { IncomingMessage } from "http";
import { logger } from "../lib/logger.js";

type ApiError = Error & { status?: number; code?: string };

function getRequestId(req: IncomingMessage): string {
  const headerId = req.headers["x-request-id"];
  if (typeof headerId === "string" && headerId.trim()) return headerId.trim();
  if (Array.isArray(headerId) && headerId[0]) return String(headerId[0]);
  return crypto.randomUUID();
}

export const requestLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    const requestId = getRequestId(req);
    res.setHeader("x-request-id", requestId);
    return requestId;
  },
});

export function notFoundApiHandler(req: Request, res: Response) {
  res.status(404).json({
    message: "Not found",
    requestId: req.id,
  });
}

export function apiErrorHandler(
  err: ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const status = err.status && err.status >= 400 ? err.status : 500;
  const code = err.code || (status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR");
  req.log?.error({ err, code, status }, "API request failed");
  res.status(status).json({
    message: status === 500 ? "Server error" : err.message,
    code,
    requestId: req.id,
  });
}
