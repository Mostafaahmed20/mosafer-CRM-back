import { Card } from "../models/Card.js";
import { deriveSlaStatus, computeSlaDue } from "../lib/sla.js";
import { logger } from "../lib/logger.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function runSlaMonitorOnce() {
  logger.info({ event: "jobs.sla_monitor.start" }, "SLA monitor job started");
  const now = new Date();
  const cards = await Card.find({ kind: { $ne: "daily_task" }, archived: { $ne: true } }).select(
    "_id slaDueAt slaType slaStatus createdAt type status dueComplete"
  );

  let updated = 0;
  for (const card of cards) {
    const newStatus = deriveSlaStatus(card);
    let needsSave = false;
    if (!card.slaDueAt) {
      const due = computeSlaDue(card.type, card.createdAt || now);
      card.slaDueAt = due || undefined;
      needsSave = true;
    }
    if (card.slaStatus !== newStatus) {
      card.slaStatus = newStatus;
      needsSave = true;
    }
    if (needsSave) {
      await card.save();
      updated += 1;
    }
  }
  const result = { updated };
  logger.info({ event: "jobs.sla_monitor.finish", ...result }, "SLA monitor job finished");
  return result;
}

export function startSlaMonitorJob() {
  const runner = async () => {
    try {
      await runSlaMonitorOnce();
    } catch (err) {
      logger.error({ err }, "SLA monitor error");
    }
  };
  runner();
  setInterval(runner, CHECK_INTERVAL_MS);
}
