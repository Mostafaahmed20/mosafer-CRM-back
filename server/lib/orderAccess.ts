import { Board } from "../models/Board.js";
import { List } from "../models/List.js";
import { Card } from "../models/Card.js";
import { Order } from "../models/Order.js";

export async function getAccessibleOrderFilter(userId: string) {
  const boards = await Board.find({
    $or: [
      { owner: userId },
      { members: { $elemMatch: { user: userId, role: { $in: ["admin", "member"] } } } },
    ],
  }).select("_id").lean();
  const boardIds = boards.map((board) => board._id);
  const lists = boardIds.length ? await List.find({ board: { $in: boardIds } }).select("_id").lean() : [];
  const linkedCards = lists.length
    ? await Card.find({ list: { $in: lists.map((list) => list._id) }, orderId: { $exists: true } }).select("orderId").lean()
    : [];
  return {
    $or: [
      { ownerId: userId },
      { sourceBoardId: { $in: boardIds } },
      { _id: { $in: linkedCards.map((card) => card.orderId).filter(Boolean) } },
    ],
  };
}

export async function findAccessibleOrder(orderId: string, userId: string) {
  const filter = await getAccessibleOrderFilter(userId);
  return Order.findOne({ _id: orderId, ...filter });
}
