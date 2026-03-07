import { Router, Request, Response } from "express";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { User } from "../models/User.js";
import { AuthRequest, authMiddleware, generateToken, requireVerifiedEmail } from "../middleware/auth.js";
import { requireGlobalAdmin } from "../middleware/globalAdmin.js";
import { env } from "../config/env.js";
import {
  loginRateLimit,
  registerRateLimit,
  forgotPasswordRateLimit,
  resetPasswordRateLimit,
  googleRateLimit,
} from "../middleware/rateLimit.js";
import {
  sendEmail,
  buildEmailVerificationEmail,
  buildPasswordResetEmail,
} from "../lib/email.js";

const router = Router();
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const hashToken = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");

const createRawToken = () => crypto.randomBytes(32).toString("hex");
const isProd = env.IS_PROD;
const appBaseUrl = env.APP_BASE_URL;
const GOOGLE_ACCOUNT_RECOVERY_URL = "https://accounts.google.com/signin/recovery";
const GLOBAL_USER_ROLES = ["user", "admin"] as const;

async function trySendEmailWithFallback({
  to,
  subject,
  html,
  text,
  fallbackPath,
  fallbackToken,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  fallbackPath: string;
  fallbackToken: string;
}) {
  try {
    await sendEmail({ to, subject, html, text });
    return { delivered: true as const };
  } catch (error: any) {
    const message = String(error?.message || "");
    const isResendSandboxRestriction =
      message.includes("You can only send testing emails to your own email address") ||
      message.includes("verify a domain at resend.com/domains");

    if (isProd || !isResendSandboxRestriction) {
      throw error;
    }

    const url = `${appBaseUrl}${fallbackPath}?token=${encodeURIComponent(fallbackToken)}&email=${encodeURIComponent(to)}`;
    console.warn(`[EMAIL-DEV-FALLBACK] Could not send email to ${to}. Open this URL manually: ${url}`);
    return { delivered: false as const, devUrl: url };
  }
}

function toAdminUserSummary(user: any) {
  return {
    _id: user._id,
    username: user.username,
    email: user.email,
    role: user.role || "user",
    canViewAllAnalytics: Boolean(user.canViewAllAnalytics),
    emailVerified: Boolean(user.emailVerified),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// POST /api/users/register
router.post("/register", registerRateLimit, async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res
        .status(400)
        .json({ message: "Username, email and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      if (existingUser.authProvider === "google") {
        return res.status(400).json({
          message: "This email is registered with Google. Continue with Google Sign-In.",
          code: "USE_GOOGLE_LOGIN",
        });
      }
      return res.status(400).json({ message: "Email already in use" });
    }

    const verificationToken = createRawToken();
    const verificationTokenHash = hashToken(verificationToken);

    const user = new User({
      username: String(username).trim(),
      email: normalizedEmail,
      password,
      authProvider: "local",
      emailVerified: false,
      emailVerificationToken: verificationTokenHash,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await user.save();

    const emailPayload = buildEmailVerificationEmail({
      username: user.username,
      token: verificationToken,
    });
    const sendResult = await trySendEmailWithFallback({
      to: user.email,
      subject: emailPayload.subject,
      html: emailPayload.html,
      text: emailPayload.text,
      fallbackPath: "/verify-email",
      fallbackToken: verificationToken,
    });

    if (!sendResult.delivered && sendResult.devUrl) {
      return res.status(201).json({
        message: "Account created. Email delivery is restricted in development; use the dev verification link.",
        devVerificationUrl: sendResult.devUrl,
      });
    }

    return res.status(201).json({
      message: "Account created. Please verify your email before login.",
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/users/login
router.post("/login", loginRateLimit, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    if (user.authProvider === "google") {
      return res.status(400).json({
        message: "This account uses Google Sign-In. Continue with Google.",
        code: "USE_GOOGLE_LOGIN",
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    if (!user.emailVerified) {
      return res.status(403).json({
        message: "Please verify your email before logging in",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    const token = generateToken(String(user._id));
    res.json({
      token,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role || "user",
        canViewAllAnalytics: Boolean((user as any).canViewAllAnalytics),
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/users/google
router.post("/google", googleRateLimit, async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ message: "Google credential is required" });
    }
    if (!googleClient || !GOOGLE_CLIENT_ID) {
      return res.status(500).json({ message: "Google login is not configured" });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload?.sub) {
      return res.status(400).json({ message: "Invalid Google token" });
    }

    const email = String(payload.email).toLowerCase().trim();
    const googleId = payload.sub;
    const displayName = payload.name || email.split("@")[0];

    let user = await User.findOne({ email });
    if (!user) {
      user = new User({
        username: displayName,
        email,
        authProvider: "google",
        googleId,
        emailVerified: true,
      });
    } else {
      user.authProvider = user.authProvider || "google";
      user.googleId = user.googleId || googleId;
      user.emailVerified = true;
      if (!user.username && displayName) {
        user.username = displayName;
      }
    }

    await user.save();

    const token = generateToken(String(user._id));
    res.json({
      token,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role || "user",
        canViewAllAnalytics: Boolean((user as any).canViewAllAnalytics),
      },
    });
  } catch (error) {
    console.error("Google login error:", error);
    res.status(401).json({ message: "Google authentication failed" });
  }
});

// POST /api/users/verify-email
router.post("/verify-email", async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: "Verification token is required" });
    }

    const user = await User.findOne({
      emailVerificationToken: hashToken(String(token)),
      emailVerificationExpires: { $gt: new Date() },
    });
    if (!user) {
      return res.status(400).json({ message: "Invalid or expired verification token" });
    }

    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    res.json({ message: "Email verified successfully" });
  } catch (error) {
    console.error("Verify email error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/users/resend-verification
router.post("/resend-verification", async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user || user.authProvider !== "local" || user.emailVerified) {
      return res.json({ message: "If account exists, a verification email was sent" });
    }

    const verificationToken = createRawToken();
    user.emailVerificationToken = hashToken(verificationToken);
    user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    const emailPayload = buildEmailVerificationEmail({
      username: user.username,
      token: verificationToken,
    });
    await trySendEmailWithFallback({
      to: user.email,
      subject: emailPayload.subject,
      html: emailPayload.html,
      text: emailPayload.text,
      fallbackPath: "/verify-email",
      fallbackToken: verificationToken,
    });

    res.json({ message: "If account exists, a verification email was sent" });
  } catch (error) {
    console.error("Resend verification error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/users/forgot-password
router.post("/forgot-password", forgotPasswordRateLimit, async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (user?.authProvider === "google") {
      return res.status(200).json({
        message: "This email uses Google Sign-In. Reset your password from Google account recovery.",
        code: "USE_GOOGLE_ACCOUNT_RECOVERY",
        recoveryUrl: GOOGLE_ACCOUNT_RECOVERY_URL,
      });
    }

    if (user && user.authProvider === "local") {
      const resetToken = createRawToken();
      user.resetPasswordToken = hashToken(resetToken);
      user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
      await user.save();

      const emailPayload = buildPasswordResetEmail({
        username: user.username,
        token: resetToken,
      });
      await trySendEmailWithFallback({
        to: user.email,
        subject: emailPayload.subject,
        html: emailPayload.html,
        text: emailPayload.text,
        fallbackPath: "/reset-password",
        fallbackToken: resetToken,
      });
    }

    res.json({ message: "If account exists, password reset instructions were sent" });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/users/reset-password
router.post("/reset-password", resetPasswordRateLimit, async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ message: "Token and password are required" });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const user = await User.findOne({
      resetPasswordToken: hashToken(String(token)),
      resetPasswordExpires: { $gt: new Date() },
    });
    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset token" });
    }

    user.password = String(password);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.emailVerified = true;
    await user.save();

    res.json({ message: "Password reset successful" });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/users/admin/:userId/analytics-access
router.patch(
  "/admin/:userId/analytics-access",
  authMiddleware,
  requireVerifiedEmail,
  requireGlobalAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const { canViewAllAnalytics } = req.body ?? {};

      if (typeof canViewAllAnalytics !== "boolean") {
        return res.status(400).json({
          message: "`canViewAllAnalytics` boolean is required",
        });
      }

      const user = await User.findById(req.params.userId).select(
        "_id username email role canViewAllAnalytics emailVerified createdAt updatedAt"
      );
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      if (canViewAllAnalytics && user.role !== "admin") {
        return res.status(400).json({
          message: "Analytics access can only be enabled for users with admin role",
        });
      }

      user.canViewAllAnalytics = canViewAllAnalytics;
      await user.save();

      res.json({
        message: "Analytics access updated",
        user: toAdminUserSummary(user),
      });
    } catch (error) {
      console.error("Update analytics access error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// GET /api/users/admin/users
router.get(
  "/admin/users",
  authMiddleware,
  requireVerifiedEmail,
  requireGlobalAdmin,
  async (_req: AuthRequest, res: Response) => {
    try {
      const users = await User.find({})
        .select("_id username email role canViewAllAnalytics emailVerified createdAt updatedAt")
        .sort({ createdAt: -1 });

      res.json({
        users: users.map((user) => toAdminUserSummary(user)),
      });
    } catch (error) {
      console.error("List admin users error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// PATCH /api/users/admin/:userId/role
router.patch(
  "/admin/:userId/role",
  authMiddleware,
  requireVerifiedEmail,
  requireGlobalAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const { role } = req.body ?? {};
      const normalizedRole = typeof role === "string" ? role.trim() : "";

      if (!GLOBAL_USER_ROLES.includes(normalizedRole as (typeof GLOBAL_USER_ROLES)[number])) {
        return res.status(400).json({ message: 'Role must be "user" or "admin"' });
      }

      const user = await User.findById(req.params.userId).select(
        "_id username email role canViewAllAnalytics emailVerified createdAt updatedAt"
      );
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const nextRole = normalizedRole as "user" | "admin";
      const currentRole = (user.role || "user") as "user" | "admin";

      if (currentRole === "admin" && nextRole !== "admin") {
        const adminCount = await User.countDocuments({ role: "admin" });
        const isSelf = String(user._id) === String(req.userId);
        if (adminCount <= 1) {
          return res.status(400).json({ message: "Cannot demote the last global admin" });
        }
        // Optional stricter safeguard: prevent locking yourself out accidentally if you are managing access from UI.
        if (isSelf && adminCount <= 1) {
          return res.status(400).json({ message: "Cannot remove your own last global admin access" });
        }
      }

      user.role = nextRole;
      if (nextRole !== "admin") {
        user.canViewAllAnalytics = false;
      }
      await user.save();

      res.json({
        message: "Global role updated",
        user: toAdminUserSummary(user),
      });
    } catch (error) {
      console.error("Update global role error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

export default router;
