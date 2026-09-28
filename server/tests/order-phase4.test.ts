import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_ORDER_FULFILLMENT_STATUSES,
  OrderFulfillment,
  buildFulfillmentHistory,
  buildSupplierReferenceKey,
  buildSupplierReferenceDuplicateFilter,
  canCancelSupplierFulfillment,
  calculateSupplierInvoiceSettlement,
  calculateFulfillmentProgress,
  findSupplierPaymentByIdempotencyKey,
} from "../models/OrderFulfillment.js";

test("calculateFulfillmentProgress returns percentage of finished tasks", () => {
  const progress = calculateFulfillmentProgress([
    { title: "Create booking", status: "done" },
    { title: "Confirm supplier", status: "done" },
    { title: "Send voucher", status: "pending" },
  ]);

  assert.equal(progress, 67);
});

test("buildFulfillmentHistory records only changed supplier fields", () => {
  const changedAt = new Date("2026-09-26T12:00:00.000Z");
  const history = buildFulfillmentHistory(
    {
      orderItemId: "order-item-1",
      supplierName: "Old Supplier",
      supplierReference: "REF-1",
      supplierInvoiceReference: "INV-1",
      supplierInvoiceAmount: 100,
      supplierInvoiceDueAt: "2026-10-01",
      status: "pending",
      tasks: [{ title: "Confirm booking", status: "pending" }],
    },
    {
      orderItemId: "order-item-1",
      supplierName: "New Supplier",
      supplierReference: "REF-1",
      supplierInvoiceReference: "INV-2",
      supplierInvoiceAmount: 120,
      supplierInvoiceDueAt: "2026-10-05",
      status: "booked",
      tasks: [{ title: "Confirm booking", status: "done" }],
    },
    "user-1",
    changedAt
  );

  assert.deepEqual(history, [
    { field: "supplierName", from: "Old Supplier", to: "New Supplier", changedBy: "user-1", changedAt },
    { field: "supplierInvoiceReference", from: "INV-1", to: "INV-2", changedBy: "user-1", changedAt },
    { field: "supplierInvoiceAmount", from: "100", to: "120", changedBy: "user-1", changedAt },
    {
      field: "supplierInvoiceDueAt",
      from: "2026-10-01",
      to: "2026-10-05",
      changedBy: "user-1",
      changedAt,
    },
    { field: "status", from: "pending", to: "booked", changedBy: "user-1", changedAt },
    { field: "task: Confirm booking", from: "pending", to: "done", changedBy: "user-1", changedAt },
  ]);
});

test("buildSupplierReferenceDuplicateFilter matches exact references without regex expansion", () => {
  const filter = buildSupplierReferenceDuplicateFilter("order-1", "Air (One)", "AB.12", "fulfillment-1");

  assert.ok(filter);
  assert.equal(filter.orderId, "order-1");
  assert.deepEqual(filter.status, { $ne: "cancelled" });
  assert.deepEqual(filter._id, { $ne: "fulfillment-1" });
  assert.equal((filter.supplierName as RegExp).test("air (one)"), true);
  assert.equal((filter.supplierReference as RegExp).test("ab.12"), true);
  assert.equal((filter.supplierReference as RegExp).test("abX12"), false);
});

test("buildSupplierReferenceKey normalizes supplier and reference values", () => {
  assert.equal(buildSupplierReferenceKey(" Air (One) ", " AB.12 "), '["air (one)","ab.12"]');
  assert.equal(buildSupplierReferenceKey("Air One", ""), undefined);
  assert.equal(buildSupplierReferenceKey("", "AB.12"), undefined);
});

test("active fulfillment reference keys have a unique partial index", () => {
  const [keys, options] = OrderFulfillment.schema.indexes().find(([, indexOptions]) =>
    indexOptions.name === "uniq_active_order_supplier_reference"
  )!;

  assert.deepEqual(keys, { orderId: 1, supplierReferenceKey: 1 });
  assert.equal(options.unique, true);
  assert.deepEqual(options.partialFilterExpression, {
    supplierReferenceKey: { $type: "string" },
    status: { $in: ACTIVE_ORDER_FULFILLMENT_STATUSES },
  });
});

test("active order services can be linked to only one fulfillment", () => {
  const [keys, options] = OrderFulfillment.schema.indexes().find(([, indexOptions]) =>
    indexOptions.name === "uniq_active_order_item_fulfillment"
  )!;

  assert.deepEqual(keys, { orderId: 1, orderItemId: 1 });
  assert.equal(options.unique, true);
  assert.deepEqual(options.partialFilterExpression, {
    orderItemId: { $type: "objectId" },
    $or: [
      { status: { $in: ACTIVE_ORDER_FULFILLMENT_STATUSES } },
      { supplierInvoiceAmount: { $exists: true } },
      { "supplierPayments.0": { $exists: true } },
    ],
  });
});

test("calculateSupplierInvoiceSettlement reconciles partial supplier payments", () => {
  const now = new Date("2026-09-26T12:00:00.000Z");
  assert.deepEqual(calculateSupplierInvoiceSettlement(200, []), {
    paid: 0,
    outstanding: 200,
    status: "unpaid",
  });
  assert.deepEqual(calculateSupplierInvoiceSettlement(200, [{ amount: 75 }, { amount: 25 }]), {
    paid: 100,
    outstanding: 100,
    status: "partially_paid",
  });
  assert.deepEqual(calculateSupplierInvoiceSettlement(200, [{ amount: 200 }]), {
    paid: 200,
    outstanding: 0,
    status: "paid",
  });
  assert.equal(calculateSupplierInvoiceSettlement(0, []).status, "paid");
  assert.equal(calculateSupplierInvoiceSettlement(200, [{ amount: 250 }]).status, "overpaid");
  assert.equal(calculateSupplierInvoiceSettlement(200, [], new Date("2026-09-25T00:00:00.000Z"), now).status, "overdue");
  assert.equal(calculateSupplierInvoiceSettlement(200, [{ amount: 200 }], new Date("2026-09-25T00:00:00.000Z"), now).status, "paid");
  assert.equal(calculateSupplierInvoiceSettlement(200, [], new Date("2026-09-26T00:00:00.000Z"), now).status, "unpaid");
});

test("supplier fulfillment cannot be cancelled while an invoice or payment remains", () => {
  assert.equal(canCancelSupplierFulfillment(undefined, "", []), true);
  assert.equal(canCancelSupplierFulfillment(0, "INV-1", []), false);
  assert.equal(canCancelSupplierFulfillment(undefined, "INV-1", []), false);
  assert.equal(canCancelSupplierFulfillment(undefined, "", [{ amount: 10 }]), false);
});

test("supplier payment retry keys resolve to the original payment", () => {
  const payments = [
    { amount: 25, idempotencyKey: "attempt-1", paymentMethod: "manual", paidAt: new Date(), recordedBy: "user-1" },
  ];

  assert.equal(findSupplierPaymentByIdempotencyKey(payments, " attempt-1 "), payments[0]);
  assert.equal(findSupplierPaymentByIdempotencyKey(payments, "attempt-2"), undefined);
});
