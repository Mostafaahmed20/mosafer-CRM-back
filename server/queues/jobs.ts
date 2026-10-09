export const JOBS = {
  dueReminders: "due-reminders",
  bookingOps: "booking-ops",
  slaMonitor: "sla-monitor",
  handoverReminders: "handover-reminders",
  dailyOpsGeneration: "daily-ops-generation",
  followUpReminders: "follow-up-reminders",
} as const;

export const JOB_SCHEDULE_MS = {
  dueReminders: 10 * 60 * 1000,
  bookingOps: 15 * 60 * 1000,
  slaMonitor: 5 * 60 * 1000,
  handoverReminders: 30 * 60 * 1000,
  dailyOpsGeneration: 15 * 60 * 1000,
  followUpReminders: 15 * 60 * 1000,
} as const;
