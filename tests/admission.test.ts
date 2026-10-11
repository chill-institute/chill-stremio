import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createAdmission, type Lease, type Refusal } from "../src/admission.ts";

const leased = (unit: Lease | Refusal): Lease => {
  if (typeof unit === "string") assert.fail(`refused by the ${unit} limit`);
  return unit;
};

test("a full link is refused while others proceed, and released links leave no entry", () => {
  const admission = createAdmission({ total: 4, perLink: 2 });
  const first = leased(admission.acquire("link-a"));
  const second = leased(admission.acquire("link-a"));
  assert.equal(admission.acquire("link-a"), "link");
  const other = leased(admission.acquire("link-b"));
  const anonymous = leased(admission.acquire());
  assert.equal(admission.acquire("link-c"), "total");
  first.release();
  first.release();
  const replacement = leased(admission.acquire());
  assert.equal(admission.acquire(), "total", "a repeated release frees once");
  for (const lease of [second, other, anonymous, replacement]) lease.release();
  assert.equal(admission.links, 0);
});
