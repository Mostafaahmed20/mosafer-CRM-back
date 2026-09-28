import assert from "node:assert/strict";
import test from "node:test";

import { calculateOrderPaymentTotals } from "../models/OrderPayment.js";
import { calculateQuoteTotal } from "../models/OrderQuote.js";

test("calculateQuoteTotal sums all quote lines and preserves quantity", () => {
  const total = calculateQuoteTotal([
    { description: "Flight", quantity: 2, netRate: 350, sellingRate: 420 },
    { description: "Hotel", quantity: 1, netRate: 450, sellingRate: 520 },
  ]);

  assert.equal(total, 1360);
});

test("calculateOrderPaymentTotals counts posted payments and refunds separately", () => {
  const totals = calculateOrderPaymentTotals([
    { amount: 400, status: "posted" },
    { amount: 200, status: "posted" },
    { amount: 75, status: "refunded" },
    { amount: 50, status: "pending" },
  ] as any);

  assert.equal(totals.paid, 600);
  assert.equal(totals.refunded, 75);
  assert.equal(totals.net, 525);
});
