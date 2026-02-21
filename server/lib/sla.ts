import { Card } from "../models/Card.js";

const SLA_RULES: Record<string, number> = {
  // hours
  "Booking request": 8,
  "Rate request": 6,
  "Reconfirmation": 4,
  "Cancellation": 2,
  "Service request": 6,
  default: 8,
};

export function computeSlaDue(type?: string, start?: Date): Date | null {
  const hours = SLA_RULES[type || ""] ?? SLA_RULES.default;
  const base = start ? new Date(start) : new Date();
  return new Date(base.getTime() + hours * 60 * 60 * 1000);
}

export function deriveSlaStatus(card: any): "Open" | "Breached" | "Met" | "N/A" {
  if (!card.slaDueAt) return "N/A";
  if (card.dueComplete || card.status === "Completed" || card.status === "Closed") {
    return "Met";
  }
  const now = new Date();
  return now > new Date(card.slaDueAt) ? "Breached" : "Open";
}

export async function ensureCardSla(card: any): Promise<any> {
  if (!card) return card;
  if (!card.slaDueAt) {
    card.slaDueAt = computeSlaDue(card.type, card.slaStartedAt || card.createdAt);
    card.slaStartedAt = card.slaStartedAt || card.createdAt || new Date();
  }
  card.slaStatus = deriveSlaStatus(card);
  return card;
}

export async function recomputeCardSla(cardId: string): Promise<void> {
  const card = await Card.findById(cardId);
  if (!card) return;
  await ensureCardSla(card);
  await card.save();
}
