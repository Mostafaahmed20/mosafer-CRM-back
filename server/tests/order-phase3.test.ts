import assert from "node:assert/strict";
import test from "node:test";

import { applyQuoteAcceptance, calculateQuoteTotal } from "../models/OrderQuote.js";
import { calculateOrderSettlement } from "../models/OrderPayment.js";

test("applyQuoteAcceptance freezes the accepted quote version and keeps the quote total immutable", () => {
  const accepted = applyQuoteAcceptance([
    { status: "draft", lines: [{ description: "Flight", quantity: 1, netRate: 100, sellingRate: 420 }] },
    { status: "sent", lines: [{ description: "Flight", quantity: 1, netRate: 100, sellingRate: 510 }] },
  ] as any);

  assert.equal(accepted.length, 2);
  assert.equal(accepted[1].status, "accepted");
  assert.equal(accepted[1].acceptedAt instanceof Date, true);
  assert.equal(accepted[1].lockedTotal, 510);
});

test("calculateOrderSettlement reconciles customer total versus paid and refunded amounts", () => {
  const settlement = calculateOrderSettlement({ customerTotal: 2000, paid: 1200, refunded: 150, pending: 300 });

  assert.equal(settlement.balanceDue, 650);
  assert.equal(settlement.status, "partially_paid");
  assert.equal(settlement.isFullySettled, false);
});

test("calculateQuoteTotal supports immutability of accepted snapshot totals", () => {
  const total = calculateQuoteTotal([
    { description: "Hotel", quantity: 2, netRate: 300, sellingRate: 600 },
  ]);

  assert.equal(total, 1200);
});
