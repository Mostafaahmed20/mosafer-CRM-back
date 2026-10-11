import { Response, Router } from "express";
import { authMiddleware, AuthRequest, requireVerifiedEmail } from "../middleware/auth.js";
import { Card } from "../models/Card.js";
import { List } from "../models/List.js";
import { Board } from "../models/Board.js";
import { Order } from "../models/Order.js";

const router = Router();
router.use(authMiddleware, requireVerifiedEmail);

router.get("/lookup/:reference", async (req: AuthRequest, res: Response) => {
  const reference = String(req.params.reference || "").trim();
  if (!/^\d{4,12}$/.test(reference)) {
    return res.status(400).json({ message: "Enter the numeric reservation reference" });
  }

  let card = await Card.findOne({ reservationRef: reference })
    .populate("agent", "username email")
    .populate("creator", "username email");
  let order = card ? await Order.findOne({ sourceCardId: card._id }) : await Order.findOne({ reservationRef: reference });
  if (!card && order?.sourceCardId) {
    card = await Card.findById(order.sourceCardId)
      .populate("agent", "username email")
      .populate("creator", "username email");
  }

  if (!card && !order) return res.status(404).json({ message: "Reservation not found" });

  const list = card ? await List.findById(card.list).select("title board") : null;
  const board = list ? await Board.findById(list.board).select("title") : null;
  return res.json({
    reservationRef: card?.reservationRef || order?.reservationRef || reference,
    lead: card ? {
      _id: card._id,
      title: card.title,
      customerName: card.agencyName || card.requester || "",
      customerPhone: card.customerPhone || "",
      customerEmail: card.customerEmail || "",
      destination: card.destination || "",
      travelDates: card.travelDates || "",
      checkInDate: card.checkInDate,
      checkOutDate: card.checkOutDate,
      adultCount: card.adultCount || 0,
      childCount: card.childCount || 0,
      travelerCount: card.travelerCount || 0,
      travelServices: card.travelServices || [],
      salesStage: card.salesStage || "New",
      status: card.status || "",
      source: card.source || "",
      leadNeed: card.leadNeed || "",
      description: card.description || "",
      agent: card.agent || null,
      createdAt: card.createdAt,
    } : null,
    workspace: list && board ? { boardId: String(list.board), boardTitle: board.title, listTitle: list.title } : null,
    order: order ? {
      _id: order._id,
      orderNumber: order.orderNumber,
      status: order.status,
      accountingStatus: order.accountingStatus,
      currency: order.currency,
      customerTotal: order.customerTotal,
      supplierCost: order.supplierCost,
      grossMargin: order.grossMargin,
      amountPaid: order.amountPaid,
      balance: order.balance,
    } : null,
  });
});

export default router;
