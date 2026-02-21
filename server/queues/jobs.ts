export const JOBS = {
  dueReminders: "due-reminders",
  bookingOps: "booking-ops",
  slaMonitor: "sla-monitor",
  handoverReminders: "handover-reminders",
} as const;

export const JOB_SCHEDULE_MS = {
  dueReminders: 10 * 60 * 1000,
  bookingOps: 15 * 60 * 1000,
  slaMonitor: 5 * 60 * 1000,
  handoverReminders: 30 * 60 * 1000,
} as const;
