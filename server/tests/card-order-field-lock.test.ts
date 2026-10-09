import assert from "node:assert/strict";
import test from "node:test";

import { getChangedPostConversionCardFields } from "../lib/cardOrderFieldLock.js";

test("post-conversion card updates allow unchanged legacy fields but reject changed values", () => {
  const current = {
    bookingRef: "OLD-REF",
    paymentStatus: "Paid",
    serviceOrders: [{ service: "Transfer", quantity: 1, price: 50 }],
  };

  assert.deepEqual(getChangedPostConversionCardFields({ bookingRef: "OLD-REF", title: "Updated title" }, current), []);
  assert.deepEqual(getChangedPostConversionCardFields({ paymentStatus: "Unpaid" }, current), ["paymentStatus"]);
  assert.deepEqual(getChangedPostConversionCardFields({
    serviceOrders: [{ service: "Transfer", quantity: 2, price: 50 }],
  }, current), ["serviceOrders"]);
});
