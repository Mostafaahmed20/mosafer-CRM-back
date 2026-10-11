import "dotenv/config";
import { connectDB } from "../db.js";
import { Card } from "../models/Card.js";
import { Counter, nextReservationReference } from "../models/Counter.js";
import { Order } from "../models/Order.js";

async function migrateReservationReferences() {
  await connectDB();
  try {
    await Counter.updateOne(
      { _id: "reservation" },
      { $setOnInsert: { sequence: 61541 } },
      { upsert: true }
    );

    const existingCardRefs = await Card.find({
      kind: { $ne: "daily_task" },
      reservationRef: { $type: "string", $ne: "" },
    }).select("reservationRef").lean();
    const highestExisting = existingCardRefs.reduce((highest, card) => {
      const value = Number(card.reservationRef);
      return Number.isSafeInteger(value) ? Math.max(highest, value) : highest;
    }, 61541);
    await Counter.updateOne({ _id: "reservation" }, { $max: { sequence: highestExisting } });

    const legacyCards = await Card.find({
      kind: { $ne: "daily_task" },
      $or: [{ reservationRef: { $exists: false } }, { reservationRef: "" }],
    }).select("_id").lean();
    for (const card of legacyCards) {
      await Card.updateOne(
        { _id: card._id, $or: [{ reservationRef: { $exists: false } }, { reservationRef: "" }] },
        { $set: { reservationRef: await nextReservationReference() } }
      );
    }

    const legacyOrders = await Order.find({
      $or: [{ reservationRef: { $exists: false } }, { reservationRef: "" }],
    }).select("_id sourceCardId").lean();
    for (const order of legacyOrders) {
      const linkedCard = order.sourceCardId
        ? await Card.findById(order.sourceCardId).select("reservationRef").lean()
        : null;
      const reference = linkedCard?.reservationRef || await nextReservationReference();
      await Order.updateOne(
        { _id: order._id, $or: [{ reservationRef: { $exists: false } }, { reservationRef: "" }] },
        { $set: { reservationRef: reference } }
      );
    }

    console.info(`Backfilled ${legacyCards.length} lead references and ${legacyOrders.length} order references.`);
  } finally {
    const mongoose = await import("mongoose");
    await mongoose.default.disconnect();
  }
}

migrateReservationReferences().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
