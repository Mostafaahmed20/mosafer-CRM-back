import assert from "node:assert/strict";
import test from "node:test";

import { CustomerTraveler } from "../models/CustomerTraveler.js";
import { OrderTraveler } from "../models/OrderTraveler.js";

test("a customer can link a reusable traveler only once", () => {
  const uniqueLink = CustomerTraveler.schema.indexes().find(([keys, options]) =>
    keys.customerId === 1 && keys.travelerId === 1 && options?.unique === true
  );

  assert.ok(uniqueLink);
});

test("order traveler records retain a reusable traveler reference and booking snapshot fields", () => {
  const travelerId = OrderTraveler.schema.path("travelerId") as any;

  assert.equal(travelerId.options.ref, "Traveler");
  for (const field of ["firstName", "lastName", "email", "phone", "passportNumber", "nationality", "dateOfBirth"]) {
    assert.ok(OrderTraveler.schema.path(field), `expected snapshot field ${field}`);
  }
});
