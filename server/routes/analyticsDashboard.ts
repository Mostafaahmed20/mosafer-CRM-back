import { Router, Response } from "express";
import mongoose from "mongoose";
import { Board } from "../models/Board.js";
import { List } from "../models/List.js";
import { Card } from "../models/Card.js";
import { authMiddleware, AuthRequest, requireVerifiedEmail } from "../middleware/auth.js";
import { requireGlobalAnalyticsAccess } from "../middleware/globalAdmin.js";

const router = Router();

router.use(authMiddleware, requireVerifiedEmail);

const TERMINAL_STATUSES = ["Completed", "Closed", "Cancelled"] as const;

type SupportedRange = "24h" | "7d" | "30d";
type DashboardStatus = "good" | "watch" | "risk";

interface AnalyticsDashboardRequest extends AuthRequest {
  query: {
    range?: string;
  };
}

function parseRange(value?: string): SupportedRange | null {
  if (value == null || value === "") return "7d";
  if (value === "24h" || value === "7d" || value === "30d") return value;
  return null;
}

function startOfHour(date: Date) {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}

function startOfDay(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addHours(date: Date, hours: number) {
  const d = new Date(date);
  d.setHours(d.getHours() + hours);
  return d;
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function roundNumber(value: number, digits = 0) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pctDelta(current: number, previous: number) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
  if (previous === 0) {
    if (current === 0) return 0;
    return 100;
  }
  return roundNumber(((current - previous) / Math.abs(previous)) * 100, 0);
}

function clampPct(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function labelForDate(range: SupportedRange, date: Date) {
  if (range === "24h") {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      hour12: true,
    });
  }
  if (range === "7d") {
    return date.toLocaleDateString("en-US", { weekday: "short" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function bucketKeyForDate(range: SupportedRange, date: Date) {
  if (range === "24h") return date.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function buildRangeWindow(range: SupportedRange, now = new Date()) {
  if (range === "24h") {
    const end = new Date(now);
    const start = startOfHour(addHours(end, -23));
    const previousStart = addHours(start, -24);
    const previousEnd = new Date(start);
    return {
      range,
      start,
      end,
      previousStart,
      previousEnd,
      bucketUnit: "hour" as const,
      bucketCount: 24,
    };
  }

  const days = range === "7d" ? 7 : 30;
  const end = new Date(now);
  const start = startOfDay(addDays(end, -(days - 1)));
  const previousStart = addDays(start, -days);
  const previousEnd = new Date(start);
  return {
    range,
    start,
    end,
    previousStart,
    previousEnd,
    bucketUnit: "day" as const,
    bucketCount: days,
  };
}

async function getUserScopedListIds(userId: string, includeAll = false) {
  if (includeAll) {
    const lists = await List.find({}).select("_id");
    return lists.map((l) => l._id as mongoose.Types.ObjectId);
  }

  const boards = await Board.find({
    $or: [{ owner: userId }, { "members.user": userId }],
  }).select("_id");

  const boardIds = boards.map((b) => b._id as mongoose.Types.ObjectId);
  if (boardIds.length === 0) return [];

  const lists = await List.find({ board: { $in: boardIds } }).select("_id");
  return lists.map((l) => l._id as mongoose.Types.ObjectId);
}

async function computeWindowMetrics(
  listIds: mongoose.Types.ObjectId[],
  start: Date,
  end: Date
) {
  if (listIds.length === 0) {
    return {
      opened: 0,
      resolved: 0,
      sla: 0,
      firstResponse: 0,
    };
  }

  const [opened, resolvedFacet, firstResponseAgg] = await Promise.all([
    Card.countDocuments({
      kind: { $ne: "daily_task" },
      list: { $in: listIds },
      createdAt: { $gte: start, $lt: end },
      archived: { $ne: true },
    }),
    Card.aggregate<any>([
      {
        $match: {
          kind: { $ne: "daily_task" },
          list: { $in: listIds },
          archived: { $ne: true },
          $or: [{ dueComplete: true }, { status: { $in: [...TERMINAL_STATUSES] } }],
        },
      },
      {
        $addFields: {
          completionTimestamp: { $ifNull: ["$completedAt", "$updatedAt"] },
        },
      },
      {
        $match: {
          completionTimestamp: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: null,
          resolved: { $sum: 1 },
          slaMet: { $sum: { $cond: [{ $eq: ["$slaStatus", "Met"] }, 1, 0] } },
          slaBreached: { $sum: { $cond: [{ $eq: ["$slaStatus", "Breached"] }, 1, 0] } },
        },
      },
    ]),
    Card.aggregate<any>([
      {
        $match: {
          kind: { $ne: "daily_task" },
          list: { $in: listIds },
          createdAt: { $gte: start, $lt: end },
          archived: { $ne: true },
        },
      },
      {
        $match: {
          $expr: { $gt: ["$updatedAt", "$createdAt"] },
        },
      },
      {
        $group: {
          _id: null,
          avgMinutes: {
            $avg: {
              $divide: [{ $subtract: ["$updatedAt", "$createdAt"] }, 1000 * 60],
            },
          },
        },
      },
    ]),
  ]);

  const resolvedRow = resolvedFacet[0] || { resolved: 0, slaMet: 0, slaBreached: 0 };
  const slaDenominator = (resolvedRow.slaMet || 0) + (resolvedRow.slaBreached || 0);
  const sla = slaDenominator > 0 ? clampPct((resolvedRow.slaMet / slaDenominator) * 100) : 0;

  return {
    opened: Number(opened || 0),
    resolved: Number(resolvedRow.resolved || 0),
    sla,
    firstResponse: Math.max(0, Math.round(firstResponseAgg[0]?.avgMinutes || 0)),
  };
}

function makeStatusForSla(sla: number): DashboardStatus {
  if (sla >= 95) return "good";
  if (sla >= 85) return "watch";
  return "risk";
}

function makeStatusForBacklogGap(gap: number): DashboardStatus {
  if (gap <= 0) return "good";
  if (gap <= 10) return "watch";
  return "risk";
}

function makeStatusForResponse(minutes: number): DashboardStatus {
  if (minutes <= 15) return "good";
  if (minutes <= 30) return "watch";
  return "risk";
}

// GET /api/analytics/dashboard?range=24h|7d|30d
router.get("/dashboard", requireGlobalAnalyticsAccess, async (req: AnalyticsDashboardRequest, res: Response) => {
  try {
    const range = parseRange(req.query?.range);
    if (!range) {
      return res.status(400).json({ message: 'Invalid range. Use "24h", "7d", or "30d"' });
    }
    const now = new Date();
    const window = buildRangeWindow(range, now);
    const listIds = await getUserScopedListIds(req.userId as string, true);

    if (listIds.length === 0) {
      return res.json({
        range,
        generatedAt: new Date().toISOString(),
        summary: {
          opened: 0,
          resolved: 0,
          sla: 0,
          backlog: 0,
          firstResponse: 0,
        },
        salesFunnel: { stageCounts: [], averageNewToWonHours: null, conversionTimeSampleSize: 0, lossReasons: [] },
        trend: [],
        teams: [],
        reports: {
          operations: [],
          service: [],
          efficiency: [],
        },
      });
    }

    const [currentMetrics, previousMetrics, backlog, teamRows, createdRows, resolvedRows] = await Promise.all([
      computeWindowMetrics(listIds, window.start, window.end),
      computeWindowMetrics(listIds, window.previousStart, window.previousEnd),
      Card.countDocuments({
        kind: { $ne: "daily_task" },
        list: { $in: listIds },
        archived: { $ne: true },
        dueComplete: { $ne: true },
        status: { $nin: [...TERMINAL_STATUSES] },
      }),
      Card.aggregate<any>([
        { $match: { kind: { $ne: "daily_task" }, list: { $in: listIds }, archived: { $ne: true } } },
        {
          $addFields: {
            completionTimestamp: { $ifNull: ["$completedAt", "$updatedAt"] },
            teamKey: { $ifNull: ["$group", "Unassigned"] },
          },
        },
        {
          $group: {
            _id: "$teamKey",
            closed: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      {
                        $or: [
                          { $eq: ["$dueComplete", true] },
                          { $in: ["$status", [...TERMINAL_STATUSES]] },
                        ],
                      },
                      { $gte: ["$completionTimestamp", window.start] },
                      { $lt: ["$completionTimestamp", window.end] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            breached: {
              $sum: {
                $cond: [{ $eq: ["$slaStatus", "Breached"] }, 1, 0],
              },
            },
          },
        },
        { $sort: { closed: -1, breached: -1, _id: 1 } },
        { $limit: 8 },
      ]),
      Card.aggregate<any>([
        {
          $match: {
            kind: { $ne: "daily_task" },
            list: { $in: listIds },
            archived: { $ne: true },
            createdAt: { $gte: window.start, $lt: window.end },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: window.bucketUnit === "hour" ? "%Y-%m-%dT%H" : "%Y-%m-%d",
                date: "$createdAt",
              },
            },
            opened: { $sum: 1 },
          },
        },
      ]),
      Card.aggregate<any>([
        {
          $match: {
            kind: { $ne: "daily_task" },
            list: { $in: listIds },
            archived: { $ne: true },
            $or: [{ dueComplete: true }, { status: { $in: [...TERMINAL_STATUSES] } }],
          },
        },
        { $addFields: { completionTimestamp: { $ifNull: ["$completedAt", "$updatedAt"] } } },
        {
          $match: {
            completionTimestamp: { $gte: window.start, $lt: window.end },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: window.bucketUnit === "hour" ? "%Y-%m-%dT%H" : "%Y-%m-%d",
                date: "$completionTimestamp",
              },
            },
            resolved: { $sum: 1 },
            slaMet: { $sum: { $cond: [{ $eq: ["$slaStatus", "Met"] }, 1, 0] } },
            slaBreached: { $sum: { $cond: [{ $eq: ["$slaStatus", "Breached"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const summary = {
      opened: currentMetrics.opened,
      resolved: currentMetrics.resolved,
      sla: currentMetrics.sla,
      backlog: Number(backlog || 0),
      firstResponse: currentMetrics.firstResponse,
    };

    const [stageCounts, wonDurations, lossReasons] = await Promise.all([
      Card.aggregate<any>([
        { $match: { kind: { $ne: "daily_task" }, list: { $in: listIds } } },
        { $group: { _id: { $ifNull: ["$salesStage", "New"] }, count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $project: { _id: 0, stage: "$_id", count: 1 } },
      ]),
      Card.aggregate<any>([
        { $match: { kind: { $ne: "daily_task" }, list: { $in: listIds }, salesStage: "Won" } },
        { $project: {
          firstNew: { $first: { $filter: { input: { $ifNull: ["$salesStageHistory", []] }, as: "entry", cond: { $eq: ["$$entry.stage", "New"] } } } },
          firstWon: { $first: { $filter: { input: { $ifNull: ["$salesStageHistory", []] }, as: "entry", cond: { $eq: ["$$entry.stage", "Won"] } } } },
        } },
        { $match: { "firstNew.changedAt": { $ne: null }, "firstWon.changedAt": { $ne: null } } },
        { $project: { hours: { $divide: [{ $subtract: ["$firstWon.changedAt", "$firstNew.changedAt"] }, 3600000] } } },
        { $group: { _id: null, averageHours: { $avg: "$hours" }, sampleSize: { $sum: 1 } } },
      ]),
      Card.aggregate<any>([
        { $match: { kind: { $ne: "daily_task" }, list: { $in: listIds }, salesStage: "Lost" } },
        { $group: { _id: { $cond: [{ $eq: [{ $ifNull: ["$lossReason", ""] }, ""] }, "Unspecified", "$lossReason"] }, count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $project: { _id: 0, reason: "$_id", count: 1 } },
      ]),
    ]);
    const salesFunnel = {
      stageCounts,
      averageNewToWonHours: wonDurations[0]?.averageHours != null ? roundNumber(wonDurations[0].averageHours, 2) : null,
      conversionTimeSampleSize: wonDurations[0]?.sampleSize || 0,
      lossReasons,
    };

    type InternalTrendBucket = {
      key: string;
      label: string;
      opened: number;
      resolved: number;
      sla: number;
      slaMet: number;
      slaBreached: number;
    };

    const trendBuckets: InternalTrendBucket[] = [];
    const bucketByKey = new Map<string, InternalTrendBucket>();
    for (let i = 0; i < window.bucketCount; i++) {
      const date =
        window.bucketUnit === "hour" ? addHours(window.start, i) : addDays(window.start, i);
      const key = bucketKeyForDate(range, date);
      const row = {
        key,
        label: labelForDate(range, date),
        opened: 0,
        resolved: 0,
        sla: 0,
        slaMet: 0,
        slaBreached: 0,
      };
      trendBuckets.push(row);
      bucketByKey.set(key, row);
    }

    for (const row of createdRows) {
      const bucket = bucketByKey.get(String(row._id));
      if (bucket) bucket.opened = Number(row.opened || 0);
    }
    for (const row of resolvedRows) {
      const bucket = bucketByKey.get(String(row._id));
      if (!bucket) continue;
      bucket.resolved = Number(row.resolved || 0);
      bucket.slaMet = Number(row.slaMet || 0);
      bucket.slaBreached = Number(row.slaBreached || 0);
      const denom = bucket.slaMet + bucket.slaBreached;
      bucket.sla = denom > 0 ? clampPct((bucket.slaMet / denom) * 100) : 0;
    }

    const trend = trendBuckets.map(({ key: _key, slaMet: _m, slaBreached: _b, ...row }) => row);

    const teams = teamRows.map((row) => ({
      team: String(row._id || "Unassigned"),
      closed: Number(row.closed || 0),
      breached: Number(row.breached || 0),
    }));

    const backlogGapCurrent = summary.opened - summary.resolved;
    const backlogGapPrev = previousMetrics.opened - previousMetrics.resolved;
    const operationsDelta = backlogGapCurrent - backlogGapPrev;

    const reports = {
      operations: [
        {
          metric: "Intake vs Resolution",
          current: `${summary.opened} / ${summary.resolved}`,
          previous: `${previousMetrics.opened} / ${previousMetrics.resolved}`,
          delta: Number(operationsDelta),
          status: makeStatusForBacklogGap(backlogGapCurrent),
          action:
            backlogGapCurrent > 0
              ? "Rebalance queue ownership during peak windows and prioritize aging backlog."
              : "Maintain current throughput mix and monitor new-ticket spikes.",
        },
      ],
      service: [
        {
          metric: "SLA Compliance",
          current: `${summary.sla}%`,
          previous: `${previousMetrics.sla}%`,
          delta: Number(summary.sla - previousMetrics.sla),
          status: makeStatusForSla(summary.sla),
          action:
            summary.sla < 90
              ? "Review breached tickets by priority and tighten escalation triggers."
              : "Keep current SLA playbook and watch breach clusters by team.",
        },
      ],
      efficiency: [
        {
          metric: "First Response Time",
          current: `${summary.firstResponse} min`,
          previous: `${previousMetrics.firstResponse} min`,
          delta: Number(pctDelta(summary.firstResponse, previousMetrics.firstResponse)),
          status: makeStatusForResponse(summary.firstResponse),
          action:
            summary.firstResponse > 30
              ? "Add fast triage coverage and template responses for common request types."
              : "Preserve response SLAs and automate repetitive intake steps.",
        },
      ],
    } satisfies {
      operations: Array<{
        metric: string;
        current: string;
        previous: string;
        delta: number;
        status: DashboardStatus;
        action: string;
      }>;
      service: Array<{
        metric: string;
        current: string;
        previous: string;
        delta: number;
        status: DashboardStatus;
        action: string;
      }>;
      efficiency: Array<{
        metric: string;
        current: string;
        previous: string;
        delta: number;
        status: DashboardStatus;
        action: string;
      }>;
    };

    res.json({
      range,
      generatedAt: new Date().toISOString(),
      summary,
      trend,
      teams,
      reports,
      salesFunnel,
    });
  } catch (error) {
    console.error("Analytics dashboard error:", error);
    res.status(500).json({ message: "Failed to load analytics dashboard" });
  }
});

export default router;
