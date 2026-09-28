import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateOrderMetrics,
  deriveOrderStatusAfterPayment,
  deriveOrderStatusAfterSupplierBooking,
  setOrderItemActualSupplierCost,
} from "../models/Order.js";

test("calculateOrderMetrics derives customerTotal, totalCost, grossMargin and balance", () => {
  const metrics = calculateOrderMetrics({
    saleSubtotal: 1000,
    taxes: 100,
    serviceFees: 50,
    markup: 20,
    discounts: 30,
    supplierCost: 700,
    supplierTaxes: 40,
    paymentFees: 25,
    amountPaid: 400,
  });

  assert.equal(metrics.customerTotal, 800);
  assert.equal(metrics.totalCost, 765);
  assert.equal(metrics.grossMargin, 35);
  assert.equal(metrics.balance, 400);
});

test("deriveOrderStatusAfterPayment only advances eligible orders", () => {
  assert.equal(deriveOrderStatusAfterPayment("draft", 100), "partially_paid");
  assert.equal(deriveOrderStatusAfterPayment("confirmed", 100), "confirmed");
  assert.equal(deriveOrderStatusAfterPayment("draft", 0), "draft");
});

test("deriveOrderStatusAfterSupplierBooking reserves eligible orders", () => {
  assert.equal(deriveOrderStatusAfterSupplierBooking("partially_paid", "booked"), "reserved");
  assert.equal(deriveOrderStatusAfterSupplierBooking("confirmed", "booked"), "confirmed");
  assert.equal(deriveOrderStatusAfterSupplierBooking("draft", "pending"), "draft");
  assert.equal(deriveOrderStatusAfterSupplierBooking("reserved", "cancelled"), "reserved");
  assert.equal(deriveOrderStatusAfterSupplierBooking("partially_paid", "cancelled"), "partially_paid");
});

test("setOrderItemActualSupplierCost replaces estimates and reconciles order total", () => {
  const order = {
    supplierCost: 500,
    items: [{ _id: "item-1", supplierCost: 100, estimatedSupplierCost: undefined as number | undefined }],
  };

  assert.equal(setOrderItemActualSupplierCost(order, "item-1", 125), true);
  assert.equal(order.items[0].estimatedSupplierCost, 100);
  assert.equal(order.items[0].supplierCost, 125);
  assert.equal(order.supplierCost, 525);

  assert.equal(setOrderItemActualSupplierCost(order, "item-1", 130), true);
  assert.equal(order.items[0].supplierCost, 130);
  assert.equal(order.supplierCost, 530);

  assert.equal(setOrderItemActualSupplierCost(order, "item-1", undefined), true);
  assert.equal(order.items[0].supplierCost, 100);
  assert.equal(order.supplierCost, 500);
});

test("setOrderItemActualSupplierCost treats supplier invoice as a line total for multiple travelers", () => {
  const order = {
    supplierCost: 200,
    items: [{ _id: "item-2", quantity: 2, supplierCost: 100, estimatedSupplierCost: undefined as number | undefined }],
  };

  assert.equal(setOrderItemActualSupplierCost(order, "item-2", 180), true);
  assert.equal(order.items[0].supplierCost, 90);
  assert.equal(order.supplierCost, 180);
  assert.equal(order.items[0].estimatedSupplierCost, 100);
});
