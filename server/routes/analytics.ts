import { Router, Response } from "express";
import mongoose from "mongoose";
import { Card } from "../models/Card.js";
import { List } from "../models/List.js";
import { User } from "../models/User.js";
import { authMiddleware, AuthRequest, requireVerifiedEmail } from "../middleware/auth.js";
import { boardAuth } from "../middleware/boardAuth.js";

const router = Router({ mergeParams: true });
router.use(authMiddleware, requireVerifiedEmail, boardAuth());

type AnalyticsRequest = AuthRequest & {
  params: {
    boardId: string;
  };
};

function parsePositiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function startOfDay(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

async function getBoardListIds(boardId: string) {
  const lists = await List.find({ board: boardId }).select("_id title");
  return lists.map((list) => list._id as mongoose.Types.ObjectId);
}

function buildRange(req: AnalyticsRequest) {
  const days = parsePositiveInt(req.query.days, 30, 365);
  const now = new Date();
  const end = new Date(now);
  const start = startOfDay(addDays(end, -(days - 1)));
  return { days, start, end };
}

// GET /api/boards/:boardId/analytics/summary
router.get("/summary", async (req: AnalyticsRequest, res: Response) => {
  try {
    const listIds = await getBoardListIds(req.params.boardId);
    if (listIds.length === 0) {
      return res.json({
        boardId: req.params.boardId,
        generatedAt: new Date().toISOString(),
        kpis: {
          totalCards: 0,
          openCards: 0,
          completedCards: 0,
          archivedCards: 0,
          overdueCards: 0,
          dueToday: 0,
          dueNext7Days: 0,
          slaBreached: 0,
          slaMet: 0,
          handoverPending: 0,
          totalSellAmount: 0,
          totalCostAmount: 0,
          estimatedMargin: 0,
        },
        breakdowns: {
          byStatus: [],
          byPriority: [],
          byGroup: [],
          bySource: [],
        },
        salesFunnel: { stageCounts: [], averageNewToWonHours: null, lossReasons: [] },
      });
    }

    const now = new Date();
    const todayStart = startOfDay(now);
    const tomorrowStart = addDays(todayStart, 1);
    const next7DaysEnd = addDays(todayStart, 7);

    const [facet] = await Card.aggregate<any>([
      { $match: { list: { $in: listIds }, kind: { $ne: "daily_task" } } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalCards: { $sum: 1 },
                archivedCards: {
                  $sum: { $cond: [{ $eq: ["$archived", true] }, 1, 0] },
                },
                completedCards: {
                  $sum: { $cond: [{ $eq: ["$dueComplete", true] }, 1, 0] },
                },
                openCards: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ["$archived", true] },
                          { $ne: ["$dueComplete", true] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                overdueCards: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ["$archived", true] },
                          { $ne: ["$dueComplete", true] },
                          { $ne: ["$dueDate", null] },
                          { $lt: ["$dueDate", now] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                dueToday: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ["$archived", true] },
                          { $ne: ["$dueDate", null] },
                          { $gte: ["$dueDate", todayStart] },
                          { $lt: ["$dueDate", tomorrowStart] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                dueNext7Days: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ["$archived", true] },
                          { $ne: ["$dueDate", null] },
                          { $gte: ["$dueDate", todayStart] },
                          { $lt: ["$dueDate", next7DaysEnd] },
                          { $ne: ["$dueComplete", true] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                slaBreached: {
                  $sum: { $cond: [{ $eq: ["$slaStatus", "Breached"] }, 1, 0] },
                },
                slaMet: {
                  $sum: { $cond: [{ $eq: ["$slaStatus", "Met"] }, 1, 0] },
                },
                handoverPending: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $eq: ["$handoverPendingState", "Yes"] },
                          { $eq: ["$handoverStatus", "Pending for next shift"] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                totalSellAmount: {
                  $sum: { $ifNull: ["$sellToAgency", 0] },
                },
                totalCostAmount: {
                  $sum: { $ifNull: ["$netPaidToHotel", 0] },
                },
              },
            },
            {
              $project: {
                _id: 0,
                totalCards: 1,
                openCards: 1,
                completedCards: 1,
                archivedCards: 1,
                overdueCards: 1,
                dueToday: 1,
                dueNext7Days: 1,
                slaBreached: 1,
                slaMet: 1,
                handoverPending: 1,
                totalSellAmount: 1,
                totalCostAmount: 1,
                estimatedMargin: { $subtract: ["$totalSellAmount", "$totalCostAmount"] },
              },
            },
          ],
          byStatus: [
            {
              $group: {
                _id: { $ifNull: ["$status", "Unspecified"] },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1, _id: 1 } },
            { $project: { _id: 0, key: "$_id", count: 1 } },
          ],
          byPriority: [
            {
              $group: {
                _id: { $ifNull: ["$priority", "Unspecified"] },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1, _id: 1 } },
            { $project: { _id: 0, key: "$_id", count: 1 } },
          ],
          byGroup: [
            {
              $group: {
                _id: { $ifNull: ["$group", "Unspecified"] },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1, _id: 1 } },
            { $project: { _id: 0, key: "$_id", count: 1 } },
          ],
          bySource: [
            {
              $group: {
                _id: { $ifNull: ["$source", "Unspecified"] },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1, _id: 1 } },
            { $project: { _id: 0, key: "$_id", count: 1 } },
          ],
        },
      },
    ]);

    const funnelMatch = { list: { $in: listIds }, kind: { $ne: "daily_task" } };
    const [stageCounts, wonDurations, lossReasons] = await Promise.all([
      Card.aggregate<any>([
        { $match: funnelMatch },
        { $group: { _id: { $ifNull: ["$salesStage", "New"] }, count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $project: { _id: 0, stage: "$_id", count: 1 } },
      ]),
      Card.aggregate<any>([
        { $match: { ...funnelMatch, salesStage: "Won" } },
        { $project: {
          firstNew: { $first: { $filter: { input: { $ifNull: ["$salesStageHistory", []] }, as: "entry", cond: { $eq: ["$$entry.stage", "New"] } } } },
          firstWon: { $first: { $filter: { input: { $ifNull: ["$salesStageHistory", []] }, as: "entry", cond: { $eq: ["$$entry.stage", "Won"] } } } },
        } },
        { $match: { "firstNew.changedAt": { $ne: null }, "firstWon.changedAt": { $ne: null } } },
        { $project: { hours: { $divide: [{ $subtract: ["$firstWon.changedAt", "$firstNew.changedAt"] }, 3600000] } } },
        { $group: { _id: null, averageHours: { $avg: "$hours" }, sampleSize: { $sum: 1 } } },
      ]),
      Card.aggregate<any>([
        { $match: { ...funnelMatch, salesStage: "Lost" } },
        { $group: { _id: { $ifNull: [{ $cond: [{ $eq: [{ $ifNull: ["$lossReason", ""] }, ""] }, "Unspecified", "$lossReason"] }, "Unspecified"] }, count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $project: { _id: 0, reason: "$_id", count: 1 } },
      ]),
    ]);

    res.json({
      boardId: req.params.boardId,
      generatedAt: new Date().toISOString(),
      kpis: facet?.totals?.[0] || {},
      breakdowns: {
        byStatus: facet?.byStatus || [],
        byPriority: facet?.byPriority || [],
        byGroup: facet?.byGroup || [],
        bySource: facet?.bySource || [],
      },
      salesFunnel: {
        stageCounts,
        averageNewToWonHours: wonDurations[0]?.averageHours != null ? Number(wonDurations[0].averageHours.toFixed(2)) : null,
        conversionTimeSampleSize: wonDurations[0]?.sampleSize || 0,
        lossReasons,
      },
    });
  } catch (error) {
    console.error("Get analytics summary error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/boards/:boardId/analytics/trends?days=30
router.get("/trends", async (req: AnalyticsRequest, res: Response) => {
  try {
    const listIds = await getBoardListIds(req.params.boardId);
    const { days, start, end } = buildRange(req);

    const labels: string[] = [];
    const indexByDay = new Map<string, number>();
    for (let i = 0; i < days; i++) {
      const date = addDays(start, i);
      const key = isoDay(date);
      indexByDay.set(key, i);
      labels.push(key);
    }

    const emptySeries = labels.map((date) => ({
      date,
      created: 0,
      updated: 0,
      dueCompleted: 0,
      overdueDueDates: 0,
    }));

    if (listIds.length === 0) {
      return res.json({
        boardId: req.params.boardId,
        range: { days, start: start.toISOString(), end: end.toISOString() },
        notes: ["Legacy completed cards without completedAt may be approximated using updatedAt."],
        series: emptySeries,
      });
    }

    const [createdAgg, updatedAgg, completedAgg, overdueDueAgg] = await Promise.all([
      Card.aggregate<any>([
        {
          $match: {
            list: { $in: listIds },
            createdAt: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
      ]),
      Card.aggregate<any>([
        {
          $match: {
            list: { $in: listIds },
            updatedAt: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$updatedAt" } },
            count: { $sum: 1 },
          },
        },
      ]),
      Card.aggregate<any>([
        {
          $match: {
            list: { $in: listIds },
            dueComplete: true,
            $or: [
              { completedAt: { $gte: start, $lte: end } },
              {
                $and: [
                  { completedAt: null },
                  { updatedAt: { $gte: start, $lte: end } },
                ],
              },
            ],
          },
        },
        {
          $addFields: {
            completionTimestamp: { $ifNull: ["$completedAt", "$updatedAt"] },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$completionTimestamp" } },
            count: { $sum: 1 },
          },
        },
      ]),
      Card.aggregate<any>([
        {
          $match: {
            list: { $in: listIds },
            dueDate: { $gte: start, $lte: end },
            archived: { $ne: true },
            dueComplete: { $ne: true },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$dueDate" } },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const series = [...emptySeries];
    for (const row of createdAgg) {
      const idx = indexByDay.get(String(row._id));
      if (idx !== undefined) series[idx].created = row.count || 0;
    }
    for (const row of updatedAgg) {
      const idx = indexByDay.get(String(row._id));
      if (idx !== undefined) series[idx].updated = row.count || 0;
    }
    for (const row of completedAgg) {
      const idx = indexByDay.get(String(row._id));
      if (idx !== undefined) series[idx].dueCompleted = row.count || 0;
    }
    for (const row of overdueDueAgg) {
      const idx = indexByDay.get(String(row._id));
      if (idx !== undefined) series[idx].overdueDueDates = row.count || 0;
    }

    res.json({
      boardId: req.params.boardId,
      range: { days, start: start.toISOString(), end: end.toISOString() },
      notes: ["Legacy completed cards without completedAt may be approximated using updatedAt."],
      series,
    });
  } catch (error) {
    console.error("Get analytics trends error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/boards/:boardId/analytics/performance
router.get("/performance", async (req: AnalyticsRequest, res: Response) => {
  try {
    const listIds = await getBoardListIds(req.params.boardId);
    const now = new Date();

    if (listIds.length === 0) {
      return res.json({
        boardId: req.params.boardId,
        generatedAt: new Date().toISOString(),
        agents: [],
      });
    }

    const rows = await Card.aggregate<any>([
      {
        $match: {
          list: { $in: listIds },
          agent: { $ne: null },
        },
      },
      {
        $group: {
          _id: "$agent",
          assignedCards: { $sum: 1 },
          openCards: {
            $sum: {
              $cond: [
                {
                  $and: [{ $ne: ["$archived", true] }, { $ne: ["$dueComplete", true] }],
                },
                1,
                0,
              ],
            },
          },
          completedCards: {
            $sum: { $cond: [{ $eq: ["$dueComplete", true] }, 1, 0] },
          },
          overdueCards: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$archived", true] },
                    { $ne: ["$dueComplete", true] },
                    { $ne: ["$dueDate", null] },
                    { $lt: ["$dueDate", now] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          slaBreached: {
            $sum: { $cond: [{ $eq: ["$slaStatus", "Breached"] }, 1, 0] },
          },
          totalSellAmount: { $sum: { $ifNull: ["$sellToAgency", 0] } },
          totalCostAmount: { $sum: { $ifNull: ["$netPaidToHotel", 0] } },
          avgCycleTimeHours: {
            $avg: {
              $cond: [
                { $eq: ["$dueComplete", true] },
                {
                  $divide: [
                    {
                      $subtract: [{ $ifNull: ["$completedAt", "$updatedAt"] }, "$createdAt"],
                    },
                    1000 * 60 * 60,
                  ],
                },
                null,
              ],
            },
          },
        },
      },
      { $sort: { completedCards: -1, assignedCards: -1 } },
    ]);

    const agentIds = rows.map((r) => r._id).filter(Boolean);
    const users = await User.find({ _id: { $in: agentIds } }).select("username email");
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    res.json({
      boardId: req.params.boardId,
      generatedAt: new Date().toISOString(),
      agents: rows.map((row) => {
        const user = userMap.get(String(row._id)) as any;
        const completionRate =
          row.assignedCards > 0 ? Number(((row.completedCards / row.assignedCards) * 100).toFixed(2)) : 0;
        const totalSellAmount = Number((row.totalSellAmount || 0).toFixed(2));
        const totalCostAmount = Number((row.totalCostAmount || 0).toFixed(2));
        return {
          agentId: String(row._id),
          username: user?.username || "Unknown",
          email: user?.email || null,
          assignedCards: row.assignedCards || 0,
          openCards: row.openCards || 0,
          completedCards: row.completedCards || 0,
          overdueCards: row.overdueCards || 0,
          slaBreached: row.slaBreached || 0,
          completionRate,
          avgCycleTimeHours:
            row.avgCycleTimeHours != null ? Number(Number(row.avgCycleTimeHours).toFixed(2)) : null,
          totalSellAmount,
          totalCostAmount,
          estimatedMargin: Number((totalSellAmount - totalCostAmount).toFixed(2)),
        };
      }),
    });
  } catch (error) {
    console.error("Get analytics performance error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
