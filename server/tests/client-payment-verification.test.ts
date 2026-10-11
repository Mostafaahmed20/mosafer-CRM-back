import assert from "node:assert/strict";
import test from "node:test";

import { getSupplierSubmissionBlocker } from "../lib/clientPaymentVerification.js";

test("supplier submission requires a full payment confirmed by the accountant via WhatsApp", () => {
  assert.ok(getSupplierSubmissionBlocker({
    customerTotal: 500,
    currency: "SAR",
    payments: [{ amount: 500, currency: "SAR", status: "posted" }],
  }));
  assert.ok(getSupplierSubmissionBlocker({
    customerTotal: 500,
    currency: "SAR",
    payments: [{ amount: 499, currency: "SAR", status: "posted", accountantConfirmation: { confirmedAt: new Date() } }],
  }));
});

test("supplier submission passes only for the full confirmed amount in the order currency", () => {
  const blocker = getSupplierSubmissionBlocker({
    customerTotal: 500,
    currency: "SAR",
    payments: [
      { amount: 300, currency: "SAR", status: "posted", accountantConfirmation: { confirmedAt: new Date() } },
      { amount: 200, currency: "SAR", status: "posted", accountantConfirmation: { confirmedAt: new Date() } },
      { amount: 1000, currency: "USD", status: "posted", accountantConfirmation: { confirmedAt: new Date() } },
    ],
  });
  assert.equal(blocker, null);
});
