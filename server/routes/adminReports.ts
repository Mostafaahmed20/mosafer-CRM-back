import { Router, Response } from "express";
import mongoose from "mongoose";
import { authMiddleware, AuthRequest, requireVerifiedEmail } from "../middleware/auth.js";
import { requireGlobalAdmin } from "../middleware/globalAdmin.js";
import { Board } from "../models/Board.js";
import { Card } from "../models/Card.js";
import { CustomerProfile } from "../models/CustomerProfile.js";
import { List } from "../models/List.js";
import { Order } from "../models/Order.js";
import { OrderPayment, calculateOrderPaymentTotals, calculateOrderSettlement } from "../models/OrderPayment.js";
import { OrderTraveler } from "../models/OrderTraveler.js";
import { Quotation } from "../models/Quotation.js";
import { TravelService } from "../models/TravelService.js";
import { User } from "../models/User.js";

const router = Router();
router.use(authMiddleware, requireVerifiedEmail, requireGlobalAdmin);

type ConfirmedLeadsQuery = {
  page?: string;
  limit?: string;
  q?: string;
  agentId?: string;
  dateFrom?: string;
  dateTo?: string;
};

interface ConfirmedLeadsRequest extends AuthRequest {
  query: ConfirmedLeadsQuery;
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), max) : fallback;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDate(value: string | undefined, endOfDay = false): Date | null | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  else date.setHours(0, 0, 0, 0);
  return date;
}

export function financialsFor(card: any, order: any, payments: any[], services: any[]) {
  const currency = String(order?.currency || services[0]?.currency || "USD");
  const serviceTotals = services.reduce((sum, service) => {
    const quantity = Math.max(1, Number(service.quantity || 1));
    return {
      netCost: sum.netCost + Number(service.netRate ?? service.supplierCost ?? service.netCost ?? 0) * quantity,
      sellingPrice: sum.sellingPrice + Number(service.sellingRate ?? service.salePrice ?? service.sellingPrice ?? 0) * quantity,
    };
  }, { netCost: 0, sellingPrice: 0 });
  const totals = calculateOrderPaymentTotals(payments.map((payment) => ({ amount: payment.amount, status: payment.status })));
  // Orders are the accounting source of truth. Quotation/travel-service lines
  // are only used for legacy confirmed leads that have no order yet.
  const netCost = order
    ? Number(order.totalCost ?? order.supplierCost ?? 0)
    : services.length ? serviceTotals.netCost : Number(card.netPaidToHotel ?? 0);
  const sellingPrice = order
    ? Number(order.customerTotal ?? 0)
    : services.length ? serviceTotals.sellingPrice : Number(card.sellToAgency ?? 0);
  const paid = order ? totals.paid : (String(card.paymentStatus).toLowerCase() === "paid" ? sellingPrice : 0);
  const refunded = order ? totals.refunded : 0;
  const pending = order ? totals.pending : (String(card.paymentStatus).toLowerCase() === "partially paid" ? Math.max(sellingPrice - paid, 0) : 0);
  const settlement = order
    ? calculateOrderSettlement({ customerTotal: sellingPrice, paid, refunded, pending })
    : null;
  const balance = settlement?.balanceDue ?? Math.max(sellingPrice - paid, 0);
  const profit = order ? Number(order.grossMargin ?? sellingPrice - netCost) : sellingPrice - netCost;
  const revenueWithoutVat = profit / 1.15;
  const paymentStatus = order
    ? balance <= 0 ? "Paid" : paid > 0 || pending > 0 ? "Partially paid" : "Unpaid"
    : String(card.paymentStatus || "Unpaid");
  return {
    currency,
    netCost,
    sellingPrice,
    profit,
    revenueWithoutVat,
    marginPercent: sellingPrice > 0 ? (profit / sellingPrice) * 100 : 0,
    paid,
    refunded,
    pending,
    balance,
    paymentStatus,
  };
}

router.get("/confirmed-leads", async (req: ConfirmedLeadsRequest, res: Response) => {
  const page = parsePositiveInt(req.query.page, 1, 100000);
  const limit = parsePositiveInt(req.query.limit, 200, 200);
  const agentId = String(req.query.agentId || "").trim();
  if (agentId && !mongoose.Types.ObjectId.isValid(agentId)) return res.status(400).json({ message: "Invalid agentId" });

  const dateFrom = parseDate(req.query.dateFrom);
  const dateTo = parseDate(req.query.dateTo, true);
  if (dateFrom === null || dateTo === null || (dateFrom && dateTo && dateFrom > dateTo)) {
    return res.status(400).json({ message: "Invalid date range" });
  }

  const match: Record<string, any> = {
    kind: { $ne: "daily_task" },
    $or: [
      { salesStage: "Won" },
      { accountingStatus: { $in: ["Ready for accounting", "Sent to accounting", "Paid", "Closed"] } },
    ],
  };
  if (agentId) {
    const selectedAgentId = new mongoose.Types.ObjectId(agentId);
    match.$and = [{ $or: [
      { agent: selectedAgentId },
      { agent: null, creator: selectedAgentId },
    ] }];
  }
  if (dateFrom || dateTo) match.createdAt = { ...(dateFrom ? { $gte: dateFrom } : {}), ...(dateTo ? { $lte: dateTo } : {}) };

  const search = String(req.query.q || "").trim();
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    match.$and = [...(match.$and || []), { $or: [
      { title: regex }, { subject: regex }, { requester: regex }, { bookingRef: regex },
      { agencyName: regex }, { destination: regex }, { hotelName: regex }, { supplierName: regex }, { leadNeed: regex },
    ] }];
  }

  try {
    const cards = await Card.find(match).sort({ createdAt: -1, _id: -1 }).lean();
    const cardIds = cards.map((card) => card._id);
    const [lists, users, quotations, orders, travelServiceDocs] = cardIds.length ? await Promise.all([
      List.find({ _id: { $in: cards.map((card) => card.list) } }).select("_id title board").lean(),
      User.find().select("_id username email role").lean(),
      Quotation.find({ card: { $in: cardIds } }).sort({ version: -1 }).lean(),
      Order.find({ sourceCardId: { $in: cardIds } }).lean(),
      TravelService.find({ card: { $in: cardIds } }).sort({ createdAt: 1 }).lean(),
    ]) : [[], await User.find().select("_id username email role").lean(), [], [], []];

    const boardIds = [...new Set(lists.map((list: any) => String(list.board)))].map((id) => new mongoose.Types.ObjectId(id));
    const boards = boardIds.length ? await Board.find({ _id: { $in: boardIds } }).select("_id title").lean() : [];
    const orderIds = orders.map((order: any) => order._id);
    const creatorIds = [...new Set(cards.map((card: any) => String(card.creator)).filter(Boolean))].map((id) => new mongoose.Types.ObjectId(id));
    const agencyNames = [...new Set(cards.map((card: any) => String(card.agencyName || "").trim()).filter(Boolean))];
    const [paymentDocs, travelerDocs, customerDocs] = await Promise.all([
      orderIds.length ? OrderPayment.find({ orderId: { $in: orderIds } }).lean() : [],
      orderIds.length ? OrderTraveler.find({ orderId: { $in: orderIds } }).sort({ createdAt: 1 }).lean() : [],
      CustomerProfile.find({ $or: [
        { _id: { $in: orders.map((order: any) => order.customerId) } },
        ...(creatorIds.length && agencyNames.length ? [{ owner: { $in: creatorIds }, agencyName: { $in: agencyNames } }] : []),
      ] }).lean(),
    ]);

    const listById = new Map(lists.map((list: any) => [String(list._id), list]));
    const boardById = new Map(boards.map((board: any) => [String(board._id), board]));
    const userById = new Map(users.map((user: any) => [String(user._id), user]));
    const orderByCardId = new Map(orders.map((order: any) => [String(order.sourceCardId), order]));
    const customerById = new Map((customerDocs as any[]).map((customer) => [String(customer._id), customer]));
    const customerByOwnerAndAgency = new Map((customerDocs as any[]).map((customer) => [`${customer.owner}:${String(customer.agencyName || "").trim().toLowerCase()}`, customer]));
    const latestQuotationByCardId = new Map<string, any>();
    for (const quotation of quotations as any[]) {
      if (!latestQuotationByCardId.has(String(quotation.card))) latestQuotationByCardId.set(String(quotation.card), quotation);
    }
    const paymentsByOrderId = new Map<string, any[]>();
    for (const payment of paymentDocs as any[]) {
      const key = String(payment.orderId);
      paymentsByOrderId.set(key, [...(paymentsByOrderId.get(key) || []), payment]);
    }
    const travelersByOrderId = new Map<string, any[]>();
    for (const traveler of travelerDocs as any[]) {
      const key = String(traveler.orderId);
      travelersByOrderId.set(key, [...(travelersByOrderId.get(key) || []), traveler]);
    }
    const travelServicesByCardId = new Map<string, any[]>();
    for (const service of travelServiceDocs as any[]) {
      const key = String(service.card);
      travelServicesByCardId.set(key, [...(travelServicesByCardId.get(key) || []), service]);
    }

    const allRows = cards.map((card: any) => {
      const list: any = listById.get(String(card.list));
      const board: any = list ? boardById.get(String(list.board)) : null;
      const agent: any = userById.get(String(card.agent || card.creator));
      const order: any = orderByCardId.get(String(card._id)) || null;
      const payments = order ? paymentsByOrderId.get(String(order._id)) || [] : [];
      const quotation: any = latestQuotationByCardId.get(String(card._id)) || null;
      const customer: any = order
        ? customerById.get(String(order.customerId))
        : customerByOwnerAndAgency.get(`${card.creator}:${String(card.agencyName || "").trim().toLowerCase()}`);
      const travelers = order ? travelersByOrderId.get(String(order._id)) || [] : [];
      const services = order?.items?.length
        ? order.items.map((item: any) => ({
            type: item.productType,
            title: item.description,
            supplierName: item.metadata?.supplierName || "",
            quantity: item.quantity,
            netCost: item.supplierCost,
            sellingPrice: item.salePrice,
            currency: order.currency,
          }))
        : quotation?.lines?.length
          ? quotation.lines.map((line: any) => ({
              type: line.serviceType,
              title: line.description,
              supplierName: line.supplierName || "",
              quantity: line.quantity,
              netCost: line.netRate,
              sellingPrice: line.sellingRate,
              currency: quotation.currency,
            }))
          : travelServicesByCardId.get(String(card._id)) || [];
      return {
        lead: card,
        board: board ? { _id: String(board._id), title: board.title } : null,
        list: list ? { _id: String(list._id), title: list.title, board: String(list.board) } : null,
        agent: agent ? { _id: String(agent._id), username: agent.username, email: agent.email || "" } : { _id: String(card.agent || card.creator), username: "Unknown agent", email: "" },
        quotation,
        order,
        customer: customer ? {
          _id: String(customer._id),
          name: customer.customerName || customer.agencyName || "",
          agencyName: customer.agencyName || "",
          phone: customer.phone || "",
          email: customer.email || "",
          location: customer.location || "",
          country: customer.country || "",
        } : {
          _id: "",
          name: card.requester || card.agencyName || "",
          agencyName: card.agencyName || "",
          phone: "",
          email: "",
          location: "",
          country: "",
        },
        travelers,
        services,
        payments,
        financials: financialsFor(card, order, payments, services),
      };
    });

    const summary = allRows.reduce((total: any, row: any) => {
      total.confirmedLeads += 1;
      total.sellingPrice += row.financials.sellingPrice;
      total.netCost += row.financials.netCost;
      total.profit += row.financials.profit;
      total.revenueWithoutVat += row.financials.revenueWithoutVat;
      total.paid += row.financials.paid;
      total.balance += row.financials.balance;
      return total;
    }, { confirmedLeads: 0, sellingPrice: 0, netCost: 0, profit: 0, revenueWithoutVat: 0, paid: 0, balance: 0 });

    const currencyTotalsMap = new Map<string, any>();
    for (const row of allRows as any[]) {
      const currency = row.financials.currency;
      const totals = currencyTotalsMap.get(currency) || { currency, confirmedLeads: 0, sellingPrice: 0, netCost: 0, profit: 0, revenueWithoutVat: 0, paid: 0, balance: 0 };
      totals.confirmedLeads += 1;
      for (const key of ["sellingPrice", "netCost", "profit", "revenueWithoutVat", "paid", "balance"]) totals[key] += row.financials[key];
      currencyTotalsMap.set(currency, totals);
    }

    const byAgentMap = new Map<string, any>();
    for (const row of allRows as any[]) {
      const id = String(row.agent._id || "unassigned");
      const key = `${id}:${row.financials.currency}`;
      const agentSummary = byAgentMap.get(key) || { agentId: id, username: row.agent.username, currency: row.financials.currency, leads: 0, sellingPrice: 0, netCost: 0, profit: 0, revenueWithoutVat: 0, paid: 0, balance: 0 };
      agentSummary.leads += 1;
      for (const key of ["sellingPrice", "netCost", "profit", "revenueWithoutVat", "paid", "balance"]) agentSummary[key] += row.financials[key];
      byAgentMap.set(`${id}:${row.financials.currency}`, agentSummary);
    }

    const total = allRows.length;
    const skip = (page - 1) * limit;
    res.json({
      scope: "global-admin",
      generatedAt: new Date().toISOString(),
      items: allRows.slice(skip, skip + limit),
      agents: users.map((user: any) => ({ _id: String(user._id), username: user.username, email: user.email, role: user.role })),
      summary,
      currencyTotals: [...currencyTotalsMap.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      byAgent: [...byAgentMap.values()].sort((a, b) => b.leads - a.leads || a.currency.localeCompare(b.currency)),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), hasNext: skip + limit < total },
      filters: { q: search, agentId, dateFrom: req.query.dateFrom || "", dateTo: req.query.dateTo || "" },
    });
  } catch (error) {
    req.log?.error({ err: error }, "Failed to load confirmed leads report");
    res.status(500).json({ message: "Failed to load confirmed leads report" });
  }
});

export default router;
