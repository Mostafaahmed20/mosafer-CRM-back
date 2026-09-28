import type { BoardRole } from "../models/Board.js";

export const BOARD_ROLE_HIERARCHY: Record<BoardRole, number> = {
  admin: 4,
  member: 3,
  guest: 2,
  observer: 1,
};

export type AppUserAccessShape = {
  role?: "user" | "admin" | string;
  canViewAllAnalytics?: boolean;
} | null | undefined;

export const WORKFLOW_ROLES = ["sales", "operations", "accounting"] as const;
export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

export function normalizeWorkflowRoles(value: unknown, globalRole?: unknown): WorkflowRole[] {
  if (normalizeUserRole(globalRole) === "admin") return [...WORKFLOW_ROLES];
  if (!Array.isArray(value)) return [...WORKFLOW_ROLES]; // Existing accounts retain access.
  return [...new Set(value.filter((role): role is WorkflowRole =>
    typeof role === "string" && (WORKFLOW_ROLES as readonly string[]).includes(role.trim().toLowerCase())
  ).map((role) => role.trim().toLowerCase() as WorkflowRole))];
}

export function hasWorkflowRole(user: { role?: unknown; workflowRoles?: unknown } | null | undefined, required: WorkflowRole): boolean {
  return normalizeWorkflowRoles(user?.workflowRoles, user?.role).includes(required);
}

export function normalizeUserRole(role: unknown): "user" | "admin" {
  if (typeof role !== "string") return "user";
  return role.trim().toLowerCase() === "admin" ? "admin" : "user";
}

export function isGlobalAdmin(user: AppUserAccessShape): boolean {
  return normalizeUserRole(user?.role) === "admin";
}

export function canViewAllAnalytics(user: AppUserAccessShape): boolean {
  return isGlobalAdmin(user) && Boolean(user?.canViewAllAnalytics);
}

export function getBoardRole(board: any, userId: string): BoardRole | null {
  const members = (board?.members || []) as any[];
  if (members.length > 0 && members[0]?.user !== undefined) {
    const entry = members.find((m) => String(m.user) === String(userId));
    return (entry?.role as BoardRole) || null;
  }

  if (String(board?.owner) === String(userId)) return "admin";
  const isLegacyMember = members.some((m) => String(m) === String(userId));
  return isLegacyMember ? "member" : null;
}

export function isBoardMember(board: any, userId: string): boolean {
  return Boolean(getBoardRole(board, userId));
}

export function hasBoardRoleAtLeast(boardRole: BoardRole | null, minRole: BoardRole): boolean {
  if (!boardRole) return false;
  return (BOARD_ROLE_HIERARCHY[boardRole] || 0) >= (BOARD_ROLE_HIERARCHY[minRole] || 0);
}
