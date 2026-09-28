import assert from "node:assert/strict";
import test from "node:test";

import { buildCustomerTripPack, summarizeOrderPackage } from "../models/OrderPackage.js";

test("summarizeOrderPackage aggregates itinerary readiness and traveler count", () => {
  const summary = summarizeOrderPackage({
    packageName: "Dubai Escape",
    status: "ready",
    travelerCount: 2,
    items: [
      { title: "Flight", serviceType: "flight", startDate: "2026-10-01T00:00:00.000Z" },
      { title: "Hotel", serviceType: "hotel", endDate: "2026-10-04T00:00:00.000Z" },
    ],
  } as any);

  assert.equal(summary.packageName, "Dubai Escape");
  assert.equal(summary.travelerCount, 2);
  assert.equal(summary.itemCount, 2);
  assert.equal(summary.totalServices, 2);
  assert.equal(summary.hasSchedule, true);
});

test("buildCustomerTripPack exposes itinerary essentials without private supplier or passport data", () => {
  const tripPack = buildCustomerTripPack({
    order: {
      orderNumber: "ORD-100",
      currency: "USD",
      items: [{ description: "Outbound flight", productType: "flight", supplierCost: 240, supplierReference: "INTERNAL-PNR" }],
    },
    customer: { customerName: "Amina", agencyName: "Amina Travel", email: "amina@example.com" },
    package: {
      packageName: "Rome weekend",
      status: "confirmed",
      items: [{ title: "Hotel check-in", serviceType: "hotel", startDate: "2026-10-01", supplierName: "Private supplier" }],
      travelerIds: ["traveler-1"],
    },
    travelers: [
      { _id: "traveler-1", firstName: "Amina", lastName: "Khan", passportNumber: "PRIVATE-PASSPORT" },
      { _id: "traveler-2", firstName: "Omar", lastName: "Khan", passportNumber: "OTHER-PASSPORT" },
    ],
  } as any);

  assert.equal(tripPack.customer.name, "Amina");
  assert.equal(tripPack.package?.packageName, "Rome weekend");
  assert.deepEqual(tripPack.travelers, [{ firstName: "Amina", lastName: "Khan" }]);
  assert.deepEqual(tripPack.itinerary, [
    { title: "Hotel check-in", serviceType: "hotel", startDate: "2026-10-01", endDate: undefined },
  ]);
  assert.equal(JSON.stringify(tripPack).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(tripPack).includes("supplierCost"), false);
});
