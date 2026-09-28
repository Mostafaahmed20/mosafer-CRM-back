import { logger } from "../lib/logger.js";
import { formatBusinessDate, generateDailyTasksForDate } from "../lib/dailyOps.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export type DailyOpsGenerationResult = {
  businessDate: string;
  created: number;
  updated: number;
};

export async function runDailyOpsGenerationOnce(): Promise<DailyOpsGenerationResult> {
  logger.info({ event: "jobs.daily_ops_generation.start" }, "Daily ops generation job started");
  const businessDate = formatBusinessDate();
  const result = await generateDailyTasksForDate(businessDate);
  const payload = { businessDate, ...result };
  logger.info({ event: "jobs.daily_ops_generation.finish", ...payload }, "Daily ops generation job finished");
  return payload;
}

export function startDailyOpsGenerationJob() {
  const runner = async () => {
    try {
      await runDailyOpsGenerationOnce();
    } catch (error) {
      logger.error({ err: error }, "Daily ops generation job error");
    }
  };

  runner();
  setInterval(runner, CHECK_INTERVAL_MS);
}
