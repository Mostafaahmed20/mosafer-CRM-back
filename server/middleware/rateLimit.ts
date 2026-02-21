import rateLimit from "express-rate-limit";

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createAuthLimiter(windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many auth attempts. Please try again later." },
  });
}

const authWindowMs = readInt("AUTH_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000);

export const loginRateLimit = createAuthLimiter(
  authWindowMs,
  readInt("AUTH_RATE_LIMIT_LOGIN_MAX", 10)
);

export const registerRateLimit = createAuthLimiter(
  authWindowMs,
  readInt("AUTH_RATE_LIMIT_REGISTER_MAX", 5)
);

export const forgotPasswordRateLimit = createAuthLimiter(
  authWindowMs,
  readInt("AUTH_RATE_LIMIT_FORGOT_MAX", 5)
);

export const resetPasswordRateLimit = createAuthLimiter(
  authWindowMs,
  readInt("AUTH_RATE_LIMIT_RESET_MAX", 10)
);

export const googleRateLimit = createAuthLimiter(
  authWindowMs,
  readInt("AUTH_RATE_LIMIT_GOOGLE_MAX", 20)
);
