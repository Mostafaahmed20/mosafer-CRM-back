import { Response, Router } from "express";
import mongoose from "mongoose";
import { Card } from "../models/Card.js";
import { List } from "../models/List.js";
import { Board } from "../models/Board.js";
import { User } from "../models/User.js";
import { Quotation } from "../models/Quotation.js";
import { Order } from "../models/Order.js";
import { OrderPayment, calculateOrderPaymentTotals } from "../models/OrderPayment.js";
import { authMiddleware, AuthRequest, requireVerifiedEmail } from "../middleware/auth.js";
import { requireGlobalAdmin } from "../middleware/globalAdmin.js";

const router = Router();
router.use(authMiddleware, requireVerifiedEmail, requireGlobalAdmin);

interface AdminReportRequest extends AuthRequest {
  query: {
    page?: string;
    limit?: string;
    q?: string;
    agentId?: string;
    dateFrom?: string;
    dateTo?: string;
  };
}

const CONFIRMED_STATUS_SET = ["Confirmed", "Completed", "Closed"];
const MAX_REPORT_ROWS = 5000;

function parsePositiveInt(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function parseDate(value: string | undefined, endOfDay = false): Date | undefined {
  if (!value?.trim()) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  if (endOfDay && value.length <= 10) date.setUTCHours(23, 59, 59, 999);
  return date;
}

function isValidObjectId(value?: string) {
  return Boolean(value && mongoose.Types.ObjectId.isValid(value));
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function money(value: unknown) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function quoteTotals(lines: any[]) {
  return lines.reduce(
    (totals, line) => {
      const quantity = Math.max(1, Number(line.quantity || 1));
      totals.net += quantity * Number(line.netRate || 0);
      totals.sale += quantity * Number(line.sellingRate || 0);
      return totals;
    },
    { net: 0, sale: 0 },
  );
}

function sanitizePayment(payment: any) {
  return {
    _id: String(payment._id),
    paymentMethod: payment.paymentMethod || "manual",
    paymentReference: payment.paymentReference || "",
    amount: money(payment.amount),
    currency: payment.currency || "USD",
    status: payment.status || "pending",
    paidAt: payment.paidAt || null,
    refundedAt: payment.refundedAt || null,
    notes: payment.notes || "",
    attachments: Array.isArray(payment.attachments)
      ? payment.attachments.map((attachment: any) => ({
          name: attachment.name || "Proof of payment",
          url: attachment.url || "",
          type: attachment.type || "application/octet-stream",
          size: Number(attachment.size || 0),
          uploadedAt: attachment.uploadedAt || null,
        }))
      : [],
    createdAt: payment.createdAt || null,
  };
}

function buildFinancials(card: any, quote: any | null, order: any | null, payments: any[]) {
  const quoteTotalsValue = quoteTotals(Array.isArray(quote?.lines) ? quote.lines : []);
  const orderPaymentTotals = calculateOrderPaymentTotals(payments);
  const netCost = order ? money(order.supplierCost) : money(quoteTotalsValue.net);
  const sellingPrice = order ? money(order.customerTotal) : money(quoteTotalsValue.sale);
  const profit = order ? money(order.grossMargin) : money(sellingPrice - netCost);
  const paid = money(orderPaymentTotals.paid);
  const refunded = money(orderPaymentTotals.refunded);
  const pending = money(orderPaymentTotals.pending);
  const balance = order ? money(order.balance) : money(Math.max(sellingPrice - (paid - refunded), 0));

  return {
    currency: order?.currency || quote?.currency || "USD",
    netCost,
    sellingPrice,
    profit,
    marginPercent: sellingPrice ? money((profit / sellingPrice) * 100) : 0,
    paid,
    refunded,
    pending,
    balance,
    paymentStatus: card.paymentStatus || (balance <= 0 && sellingPrice > 0 ? "Paid" : paid > 0 ? "Partially paid" : "Pending"),
  };
}

function toReportRow(card: any, context: { agent: any; board: any; list: any; quote: any | null; order: any | null; payments: any[] }) {
  const financials = buildFinancials(card, context.quote, context.order, context.payments);
  return {
    lead: {
      ...card,
      _id: String(card._id),
      list: card.list ? String(card.list) : null,
      orderId: card.orderId ? String(card.orderId) : null,
      agent: context.agent,
      creator: card.creator || null,
      members: Array.isArray(card.members) ? card.members : [],
    },
    board: context.board,
    list: context.list,
    agent: context.agent || { _id: "", username: "Unassigned", email: "" },
    quotation: context.quote
      ? {
          _id: String(context.quote._id),
          version: context.quote.version,
          status: context.quote.status,
          currency: context.quote.currency,
          lines: context.quote.lines || [],
          notes: context.quote.notes || "",
          sentAt: context.quote.sentAt || null,
          acceptedAt: context.quote.acceptedAt || null,
          createdAt: context.quote.createdAt || null,
        }
      : null,
    order: context.order,
    payments: context.payments.map(sanitizePayment),
    financials,
  };
}

router.get("/confirmed-leads", async (req: AdminReportRequest, res: Response) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 100000);
    const limit = parsePositiveInt(req.query.limit, 50, 200);
    const match: Record<string, any> = {
      kind: { $ne: "daily_task" },
      $or: [{ salesStage: "Won" }, { status: { $in: CONFIRMED_STATUS_SET }, salesStage: { $ne: "Lost" } }],
    };

    if (req.query.agentId?.trim()) {
      if (!isValidObjectId(req.query.agentId.trim())) return res.status(400).json({ message: "Invalid agentId" });
      match.agent = new mongoose.Types.ObjectId(req.query.agentId.trim());
    }

    const dateFrom = parseDate(req.query.dateFrom);
    const dateTo = parseDate(req.query.dateTo, true);
    if (req.query.dateFrom && !dateFrom) return res.status(400).json({ message: "Invalid dateFrom" });
    if (req.query.dateTo && !dateTo) return res.status(400).json({ message: "Invalid dateTo" });
    if (dateFrom || dateTo) {
      match.createdAt = {};
      if (dateFrom) match.createdAt.$gte = dateFrom;
      if (dateTo) match.createdAt.$lte = dateTo;
    }

    if (req.query.q?.trim()) {
      const regex = new RegExp(escapeRegExp(req.query.q.trim()), "i");
      match.$and = [
        { $or: [{ title: regex }, { requester: regex }, { agencyName: regex }, { bookingRef: regex }, { destination: regex }, { description: regex }] },
      ];
    }

    const cards = await Card.find(match)
      .sort({ createdAt: -1, _id: -1 })
      .limit(MAX_REPORT_ROWS)
      .populate("agent", "username email")
      .populate("creator", "username email")
      .populate("members", "username email")
      .lean();

    const cardIds = cards.map((card: any) => card._id);
    const linkedOrderIds = cards.map((card: any) => card.orderId).filter(Boolean);
    const listIds = cards.map((card: any) => card.list).filter(Boolean);
    const [lists, quotes, orders, users] = await Promise.all([
      List.find({ _id: { $in: listIds } }).select("_id title board").lean(),
      Quotation.find({ card: { $in: cardIds } }).sort({ version: -1 }).lean(),
      Order.find({ $or: [{ sourceCardId: { $in: cardIds } }, { _id: { $in: linkedOrderIds } }] }).sort({ createdAt: -1 }).lean(),
      User.find({}).select("_id username email role").sort({ username: 1 }).lean(),
    ]);

    const orderIds = orders.map((order: any) => order._id);
    const payments = orderIds.length ? await OrderPayment.find({ orderId: { $in: orderIds } }).sort({ createdAt: 1 }).lean() : [];
    const boardIds = lists.map((list: any) => list.board).filter(Boolean);
    const boards = boardIds.length ? await Board.find({ _id: { $in: boardIds } }).select("_id title").lean() : [];

    const listMap = new Map(lists.map((list: any) => [String(list._id), list]));
    const boardMap = new Map(boards.map((board: any) => [String(board._id), board]));
    const quoteMap = new Map<string, any>();
    for (const quote of quotes) {
      const key = String(quote.card);
      if (!quoteMap.has(key) || quote.status === "Accepted") quoteMap.set(key, quote);
    }
    const orderMap = new Map(orders.map((order: any) => [String(order.sourceCardId), order]));
    const orderIdMap = new Map(orders.map((order: any) => [String(order._id), order]));
    const paymentsMap = new Map<string, any[]>();
    for (const payment of payments) {
      const key = String(payment.orderId);
      paymentsMap.set(key, [...(paymentsMap.get(key) || []), payment]);
    }

    const rows = cards.map((card: any) => {
      const list = listMap.get(String(card.list));
      const board = list ? boardMap.get(String(list.board)) : null;
      const agent = card.agent
        ? { _id: String(card.agent._id), username: card.agent.username || "Unknown", email: card.agent.email || "" }
        : null;
      const quote = quoteMap.get(String(card._id)) || null;
      const order = orderMap.get(String(card._id)) || orderIdMap.get(String(card.orderId)) || null;
      return toReportRow(
        card,
        {
          agent,
          board: board ? { _id: String(board._id), title: board.title } : null,
          list: list ? { _id: String(list._id), title: list.title, board: String(list.board) } : null,
          quote,
          order,
          payments: order ? paymentsMap.get(String(order._id)) || [] : [],
        },
      );
    });

    const summary = rows.reduce(
      (total, row) => {
        total.confirmedLeads += 1;
        total.sellingPrice += row.financials.sellingPrice;
        total.netCost += row.financials.netCost;
        total.profit += row.financials.profit;
        total.paid += row.financials.paid;
        total.balance += row.financials.balance;
        return total;
      },
      { confirmedLeads: 0, sellingPrice: 0, netCost: 0, profit: 0, paid: 0, balance: 0 },
    );
    const byAgentMap = new Map<string, any>();
    for (const row of rows) {
      const key = row.agent?._id || "unassigned";
      const entry = byAgentMap.get(key) || {
        agentId: row.agent?._id || "",
        username: row.agent?.username || "Unassigned",
        leads: 0,
        sellingPrice: 0,
        netCost: 0,
        profit: 0,
        paid: 0,
        balance: 0,
      };
      entry.leads += 1;
      entry.sellingPrice += row.financials.sellingPrice;
      entry.netCost += row.financials.netCost;
      entry.profit += row.financials.profit;
      entry.paid += row.financials.paid;
      entry.balance += row.financials.balance;
      byAgentMap.set(key, entry);
    }

    const roundTotals = (value: any) => money(value);
    const normalizedSummary = Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, key === "confirmedLeads" ? value : roundTotals(value)]));
    const byAgent = Array.from(byAgentMap.values()).map((entry) => ({
      ...entry,
      sellingPrice: roundTotals(entry.sellingPrice),
      netCost: roundTotals(entry.netCost),
      profit: roundTotals(entry.profit),
      paid: roundTotals(entry.paid),
      balance: roundTotals(entry.balance),
    }));

    const start = (page - 1) * limit;
    const items = rows.slice(start, start + limit);
    res.json({
      scope: "global-admin",
      generatedAt: new Date().toISOString(),
      items,
      agents: users.map((user: any) => ({ _id: String(user._id), username: user.username, email: user.email || "", role: user.role })),
      summary: normalizedSummary,
      byAgent,
      pagination: {
        page,
        limit,
        total: rows.length,
        totalPages: Math.max(1, Math.ceil(rows.length / limit)),
        hasNext: start + items.length < rows.length,
      },
      filters: {
        agentId: req.query.agentId || "",
        dateFrom: req.query.dateFrom || "",
        dateTo: req.query.dateTo || "",
        q: req.query.q || "",
      },
    });
  } catch (error) {
    console.error("Confirmed leads report error:", error);
    res.status(500).json({ message: "Failed to load confirmed leads report" });
  }
});

export default router;
