import { env } from "../config/env.js";

type SendEmailParams = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

const RESEND_API_KEY = env.RESEND_API_KEY;
const RESEND_FROM = env.RESEND_FROM;
const APP_BASE_URL = env.APP_BASE_URL;

export async function sendEmail({ to, subject, html, text }: SendEmailParams) {
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set. Skipping email.");
    return { skipped: true };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to,
      subject,
      html,
      ...(text ? { text } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend error: ${response.status} ${errorText}`);
  }

  return response.json();
}

export function buildDueReminderEmail({
  cardTitle,
  listTitle,
  boardTitle,
  dueText,
  actorName,
  boardId,
}: {
  cardTitle: string;
  listTitle: string;
  boardTitle?: string;
  dueText: string;
  actorName?: string;
  boardId?: string;
}) {
  const cardUrl = boardId ? `${APP_BASE_URL}/board/${boardId}` : APP_BASE_URL;
  const title = "Due reminder";

  const html = `
    <div style="background:#f8fafc;padding:24px;font-family:Arial,sans-serif;color:#0f172a;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;">
        <h2 style="margin:0 0 12px;font-size:20px;">${title}</h2>
        <p style="margin:0 0 8px;font-size:14px;">
          <strong>${cardTitle}</strong> is due ${dueText}.
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#475569;">
          Board: ${boardTitle || "Board"} • List: ${listTitle}
        </p>
        <a href="${cardUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-size:14px;">
          Open board
        </a>
        <p style="margin:14px 0 0;font-size:12px;color:#94a3b8;">
          ${actorName ? `Reminder sent by ${actorName}. ` : ""}This is an automated reminder.
        </p>
      </div>
    </div>
  `;

  const text = `${cardTitle} is due ${dueText}. Board: ${boardTitle || "Board"} • List: ${listTitle}. Open: ${cardUrl}`;

  return { subject: `Due reminder: ${cardTitle}`, html, text };
}

export function buildBoardInviteEmail({
  boardTitle,
  inviterName,
  boardId,
}: {
  boardTitle: string;
  inviterName?: string;
  boardId: string;
}) {
  const boardUrl = `${APP_BASE_URL}/board/${boardId}`;
  const subject = `You were invited to ${boardTitle}`;
  const html = `
    <div style="background:#f8fafc;padding:24px;font-family:Arial,sans-serif;color:#0f172a;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;">
        <h2 style="margin:0 0 12px;font-size:20px;">Board invitation</h2>
        <p style="margin:0 0 8px;font-size:14px;">
          ${inviterName ? `<strong>${inviterName}</strong> invited you to` : "You were invited to"} <strong>${boardTitle}</strong>.
        </p>
        <a href="${boardUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-size:14px;">
          Open board
        </a>
        <p style="margin:14px 0 0;font-size:12px;color:#94a3b8;">
          This is an automated invitation.
        </p>
      </div>
    </div>
  `;
  const text = `${inviterName ? `${inviterName} invited you to` : "You were invited to"} ${boardTitle}. Open: ${boardUrl}`;
  return { subject, html, text };
}

export function buildHandoverReminderEmail({
  cardTitle,
  boardId,
  nextAction,
  pendingDetails,
  blocker,
}: {
  cardTitle: string;
  boardId?: string;
  nextAction?: string;
  pendingDetails?: string;
  blocker?: string;
}) {
  const caseUrl = boardId ? `${APP_BASE_URL}/board/${boardId}` : APP_BASE_URL;
  const subject = `Handover reminder: ${cardTitle}`;
  const html = `
    <div style="background:#f8fafc;padding:24px;font-family:Arial,sans-serif;color:#0f172a;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;">
        <h2 style="margin:0 0 12px;font-size:20px;">Pending handover case</h2>
        <p style="margin:0 0 8px;font-size:14px;">
          Case <strong>${cardTitle}</strong> is still pending and assigned to you.
        </p>
        <p style="margin:0 0 8px;font-size:13px;color:#475569;">
          Next action: ${nextAction || "-"}
        </p>
        <p style="margin:0 0 8px;font-size:13px;color:#475569;">
          Pending details: ${pendingDetails || "-"}
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#475569;">
          Blocker: ${blocker || "-"}
        </p>
        <a href="${caseUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-size:14px;">
          Open case
        </a>
      </div>
    </div>
  `;
  const text = `Pending handover case: ${cardTitle}. Next action: ${nextAction || "-"}. Pending details: ${pendingDetails || "-"}. Blocker: ${blocker || "-"}. Open: ${caseUrl}`;
  return { subject, html, text };
}

export function buildEmailVerificationEmail({
  username,
  token,
}: {
  username: string;
  token: string;
}) {
  const verifyUrl = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  const subject = "Verify your email";
  const html = `
    <div style="background:#f8fafc;padding:24px;font-family:Arial,sans-serif;color:#0f172a;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;">
        <h2 style="margin:0 0 12px;font-size:20px;">Verify your email</h2>
        <p style="margin:0 0 10px;font-size:14px;">Hi ${username}, please verify your email to activate your account.</p>
        <a href="${verifyUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-size:14px;">
          Verify email
        </a>
      </div>
    </div>
  `;
  const text = `Hi ${username}, verify your email: ${verifyUrl}`;
  return { subject, html, text };
}

export function buildPasswordResetEmail({
  username,
  token,
}: {
  username: string;
  token: string;
}) {
  const resetUrl = `${APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const subject = "Reset your password";
  const html = `
    <div style="background:#f8fafc;padding:24px;font-family:Arial,sans-serif;color:#0f172a;">
      <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;">
        <h2 style="margin:0 0 12px;font-size:20px;">Reset your password</h2>
        <p style="margin:0 0 10px;font-size:14px;">Hi ${username}, click below to set a new password.</p>
        <a href="${resetUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-size:14px;">
          Reset password
        </a>
        <p style="margin:12px 0 0;font-size:12px;color:#64748b;">This link expires in 1 hour.</p>
      </div>
    </div>
  `;
  const text = `Hi ${username}, reset your password: ${resetUrl}`;
  return { subject, html, text };
}
