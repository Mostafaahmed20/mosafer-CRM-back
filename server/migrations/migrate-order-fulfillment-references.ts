import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../db.js";
import {
  ACTIVE_ORDER_FULFILLMENT_STATUSES,
  OrderFulfillment,
  buildSupplierReferenceKey,
} from "../models/OrderFulfillment.js";

const INDEX_NAME = "uniq_active_order_supplier_reference";
const ORDER_ITEM_INDEX_NAME = "uniq_active_order_item_fulfillment";

async function migrateOrderFulfillmentReferences() {
  await connectDB();

  try {
    const records = await OrderFulfillment.collection.find({}, {
      projection: {
        _id: 1,
        orderId: 1,
        supplierName: 1,
        supplierReference: 1,
        orderItemId: 1,
        supplierInvoiceAmount: 1,
        supplierPayments: 1,
        status: 1,
      },
    }).toArray();

    const activeKeys = new Map<string, typeof records>();
    const activeOrderItems = new Map<string, typeof records>();
    const collisions: Array<{ kind: string; orderId: string; ids: string[] }> = [];

    for (const record of records) {
      const isActive = ACTIVE_ORDER_FULFILLMENT_STATUSES.includes(record.status);
      if (isActive) {
        const key = buildSupplierReferenceKey(record.supplierName || "", record.supplierReference || "");
        if (key) {
          const scopedKey = `${record.orderId}:${key}`;
          const matchingRecords = activeKeys.get(scopedKey) || [];
          matchingRecords.push(record);
          activeKeys.set(scopedKey, matchingRecords);
        }
      }

      const hasFinancialClaim = isActive || record.supplierInvoiceAmount !== undefined || Boolean(record.supplierPayments?.length);
      if (record.orderItemId && hasFinancialClaim) {
        const itemKey = `${record.orderId}:${record.orderItemId}`;
        const linkedRecords = activeOrderItems.get(itemKey) || [];
        linkedRecords.push(record);
        activeOrderItems.set(itemKey, linkedRecords);
      }
    }

    for (const matchingRecords of activeKeys.values()) {
      if (matchingRecords.length > 1) {
        collisions.push({
          kind: "duplicate supplier references",
          orderId: String(matchingRecords[0].orderId),
          ids: matchingRecords.map((record) => String(record._id)),
        });
      }
    }
    for (const linkedRecords of activeOrderItems.values()) {
      if (linkedRecords.length > 1) {
        collisions.push({
          kind: "multiple active or financially unresolved fulfillments linked to one order service",
          orderId: String(linkedRecords[0].orderId),
          ids: linkedRecords.map((record) => String(record._id)),
        });
      }
    }

    if (collisions.length) {
      console.error("Active fulfillment conflicts must be resolved before migration:");
      for (const collision of collisions) {
        console.error(`  ${collision.kind} on order ${collision.orderId}: fulfillment IDs ${collision.ids.join(", ")}`);
      }
      process.exitCode = 1;
      return;
    }

    const setOperations = records.flatMap((record) => {
      const isActive = ACTIVE_ORDER_FULFILLMENT_STATUSES.includes(record.status);
      const key = isActive
        ? buildSupplierReferenceKey(record.supplierName || "", record.supplierReference || "")
        : undefined;
      return key
        ? [{ updateOne: { filter: { _id: record._id }, update: { $set: { supplierReferenceKey: key } } } }]
        : [];
    });
    const unsetOperations = records.flatMap((record) => {
      const hasKey = ACTIVE_ORDER_FULFILLMENT_STATUSES.includes(record.status)
        && buildSupplierReferenceKey(record.supplierName || "", record.supplierReference || "");
      return hasKey
        ? []
        : [{ updateOne: { filter: { _id: record._id }, update: { $unset: { supplierReferenceKey: "" } } } }];
    });

    if (setOperations.length) {
      await OrderFulfillment.collection.bulkWrite(setOperations);
    }
    if (unsetOperations.length) {
      await OrderFulfillment.collection.bulkWrite(unsetOperations);
    }

    const existingIndexes = await OrderFulfillment.collection.indexes();
    if (existingIndexes.some((index) => index.name === ORDER_ITEM_INDEX_NAME)) {
      await OrderFulfillment.collection.dropIndex(ORDER_ITEM_INDEX_NAME);
    }
    await OrderFulfillment.collection.createIndex(
      { orderId: 1, supplierReferenceKey: 1 },
      {
        unique: true,
        name: INDEX_NAME,
        partialFilterExpression: {
          supplierReferenceKey: { $type: "string" },
          status: { $in: ACTIVE_ORDER_FULFILLMENT_STATUSES },
        },
      }
    );
    await OrderFulfillment.collection.createIndex(
      { orderId: 1, orderItemId: 1 },
      {
        unique: true,
        name: ORDER_ITEM_INDEX_NAME,
        partialFilterExpression: {
          orderItemId: { $type: "objectId" },
          $or: [
            { status: { $in: ACTIVE_ORDER_FULFILLMENT_STATUSES } },
            { supplierInvoiceAmount: { $exists: true } },
            { "supplierPayments.0": { $exists: true } },
          ],
        },
      }
    );

    console.log(`Migrated ${setOperations.length} supplier fulfillment references and ensured ${INDEX_NAME} and ${ORDER_ITEM_INDEX_NAME}.`);
  } finally {
    await mongoose.disconnect();
  }
}

migrateOrderFulfillmentReferences().catch((error) => {
  console.error("Order fulfillment reference migration failed:", error);
  process.exitCode = 1;
});
