import assert from "node:assert/strict";
import test from "node:test";

import { getAccountingReadiness, isAccountingLocked } from "../lib/accountingReadiness.js";

const completeCase = {
  customer: { agencyName: "Example Travel", location: "Cairo", email: "ops@example.test" },
  package: {
    status: "confirmed",
    startDate: new Date("2026-10-10"),
    endDate: new Date("2026-10-14"),
    items: [{ title: "Return flight" }],
    travelerIds: ["snapshot-1"],
  },
  items: [{ _id: "service-1", description: "CAI-JED return tickets", salePrice: 300, supplierCost: 200 }],
  fulfillments: [{
    orderItemId: "service-1",
    supplierName: "Example Air",
    supplierReference: "PNR-123",
    supplierInvoiceReference: "INV-123",
    supplierInvoiceAmount: 200,
    status: "booked",
  }],
  currency: "USD",
  balance: 0,
  customerPayments: { paid: 300, pending: 0 },
  travelerCount: 1,
};

test("accounting readiness passes when the customer, package, booking, costs, and settlement are complete", () => {
  assert.deepEqual(getAccountingReadiness(completeCase), { ready: true, blockers: [] });
});

test("accounting readiness reports missing records instead of allowing a premature handoff", () => {
  const result = getAccountingReadiness({
    ...completeCase,
    package: null,
    fulfillments: [],
    balance: 100,
    customerPayments: { paid: 0, pending: 100 },
  });

  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes("Create and confirm the travel package"));
  assert.ok(result.blockers.includes("Add supplier booking details for CAI-JED return tickets"));
  assert.ok(result.blockers.includes("Settle the customer balance before accounting handoff"));
  assert.ok(result.blockers.includes("Record and post the customer payment"));
});

test("accounting handoff locks sent, received, and closed orders", () => {
  assert.equal(isAccountingLocked("not_ready"), false);
  assert.equal(isAccountingLocked("sent"), true);
  assert.equal(isAccountingLocked("received"), true);
  assert.equal(isAccountingLocked("closed"), true);
});
