import { Queue, Worker, type JobsOptions, type ConnectionOptions } from "bullmq";
import { env } from "../config/env.js";
import { runDueDateReminderJobOnce } from "../jobs/dueDateReminders.js";
import { runBookingOpsAutomationOnce } from "../jobs/bookingOpsAutomation.js";
import { runSlaMonitorOnce } from "../jobs/slaMonitor.js";
import { runHandoverReminderJobOnce } from "../jobs/handoverReminders.js";
import { JOBS, JOB_SCHEDULE_MS } from "./jobs.js";
import { setBullMqRuntime } from "./runtime.js";

const connection: ConnectionOptions = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null,
};

const defaultJobOptions: JobsOptions = {
  removeOnComplete: 50,
  removeOnFail: 100,
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
};

export async function startBullMqJobs() {
  const dueQueue = new Queue(JOBS.dueReminders, { connection, defaultJobOptions });
  const bookingQueue = new Queue(JOBS.bookingOps, { connection, defaultJobOptions });
  const slaQueue = new Queue(JOBS.slaMonitor, { connection, defaultJobOptions });
  const handoverQueue = new Queue(JOBS.handoverReminders, { connection, defaultJobOptions });

  const dueWorker = new Worker(
    JOBS.dueReminders,
    async () => {
      await runDueDateReminderJobOnce();
    },
    { connection }
  );
  const bookingWorker = new Worker(
    JOBS.bookingOps,
    async () => {
      await runBookingOpsAutomationOnce();
    },
    { connection }
  );
  const slaWorker = new Worker(
    JOBS.slaMonitor,
    async () => {
      await runSlaMonitorOnce();
    },
    { connection }
  );
  const handoverWorker = new Worker(
    JOBS.handoverReminders,
    async () => {
      await runHandoverReminderJobOnce();
    },
    { connection }
  );

  dueWorker.on("failed", (job, err) => {
    console.error(`[BullMQ] ${JOBS.dueReminders} failed`, job?.id, err);
  });
  bookingWorker.on("failed", (job, err) => {
    console.error(`[BullMQ] ${JOBS.bookingOps} failed`, job?.id, err);
  });
  slaWorker.on("failed", (job, err) => {
    console.error(`[BullMQ] ${JOBS.slaMonitor} failed`, job?.id, err);
  });
  handoverWorker.on("failed", (job, err) => {
    console.error(`[BullMQ] ${JOBS.handoverReminders} failed`, job?.id, err);
  });

  await dueQueue.upsertJobScheduler(
    "recurring",
    { every: JOB_SCHEDULE_MS.dueReminders },
    { name: "run", data: {} }
  );
  await bookingQueue.upsertJobScheduler(
    "recurring",
    { every: JOB_SCHEDULE_MS.bookingOps },
    { name: "run", data: {} }
  );
  await slaQueue.upsertJobScheduler(
    "recurring",
    { every: JOB_SCHEDULE_MS.slaMonitor },
    { name: "run", data: {} }
  );
  await handoverQueue.upsertJobScheduler(
    "recurring",
    { every: JOB_SCHEDULE_MS.handoverReminders },
    { name: "run", data: {} }
  );

  console.log("[BullMQ] Workers started for due reminders, booking ops, SLA monitor, and handover reminders");

  const runtime = {
    dueQueue,
    bookingQueue,
    slaQueue,
    handoverQueue,
    dueWorker,
    bookingWorker,
    slaWorker,
    handoverWorker,
  };
  setBullMqRuntime(runtime);
  return runtime;
}
