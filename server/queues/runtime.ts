import type { Queue, Worker } from "bullmq";

type JobMode = "timer" | "bullmq";

type BullMqRuntime = {
  dueQueue: Queue;
  bookingQueue: Queue;
  slaQueue: Queue;
  handoverQueue: Queue;
  dueWorker: Worker;
  bookingWorker: Worker;
  slaWorker: Worker;
  handoverWorker: Worker;
};

let mode: JobMode = "timer";
let bullmqRuntime: BullMqRuntime | null = null;
let bullmqError: string | null = null;

export function setJobMode(next: JobMode) {
  mode = next;
}

export function getJobMode(): JobMode {
  return mode;
}

export function setBullMqRuntime(runtime: BullMqRuntime | null) {
  bullmqRuntime = runtime;
}

export function getBullMqRuntime(): BullMqRuntime | null {
  return bullmqRuntime;
}

export function setBullMqError(message: string | null) {
  bullmqError = message;
}

export function getBullMqError(): string | null {
  return bullmqError;
}
