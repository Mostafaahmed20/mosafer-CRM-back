import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedCorsOrigin } from "../lib/cors.js";

test("allows configured origins in every environment", () => {
  assert.equal(isAllowedCorsOrigin("https://crm.example.com", ["https://crm.example.com"], false), true);
});

test("allows localhost development ports outside production", () => {
  assert.equal(isAllowedCorsOrigin("http://localhost:3002", [], true), true);
  assert.equal(isAllowedCorsOrigin("http://127.0.0.1:4173", [], true), true);
});

test("does not allow unconfigured public origins or localhost in production", () => {
  assert.equal(isAllowedCorsOrigin("https://attacker.example", [], true), false);
  assert.equal(isAllowedCorsOrigin("http://localhost:3002", [], false), false);
});

test("rejects malformed origins", () => {
  assert.equal(isAllowedCorsOrigin("localhost:3002", [], true), false);
  assert.equal(isAllowedCorsOrigin("http://localhost:3002/path", [], true), false);
});