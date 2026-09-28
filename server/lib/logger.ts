import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.IS_PROD ? "info" : "debug",
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.proxy-authorization",
      "req.headers.cookie",
      "req.headers.set-cookie",
      "req.headers.x-api-key",
      "res.headers.set-cookie",
    ],
    censor: "[Redacted]",
  },
});

