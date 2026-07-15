import assert from "node:assert/strict";
import test from "node:test";

import { AirClient } from "../dist/index.js";

// AirClient whose injected fetch returns a fixed JSON error response, so we can
// drive `toError` end-to-end without a network (mirrors the cost.test fixture).
const clientWithJson = (status, body) =>
  new AirClient({
    baseUrl: "http://air.test",
    fetch: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  });

const rejection = (promise) => promise.then(() => null, (e) => e);

// A 402 budget/credit block carries the exact figures alongside message/type —
// the client must surface them as `details` so the UI can show "$5.12 / $5.00"
// instead of parsing the English message text.
test("toError surfaces a 402 budget payload's numbers as `details`", async () => {
  const client = clientWithJson(402, {
    error: {
      type: "budget_exceeded",
      message: "Monthly budget of $5.00 exhausted (used $5.12)",
      monthlyCapUsd: 5,
      monthlyUsedUsd: 5.12,
      dailyUsedUsd: 5.12,
    },
  });
  const err = await rejection(
    client.chat({ model: "air-auto", messages: [{ role: "user", content: "hi" }] }),
  );
  assert.ok(err, "chat() must reject on a 402");
  assert.equal(err.code, "budget_exceeded");
  assert.equal(err.httpStatus, 402);
  assert.equal(err.details.monthlyUsedUsd, 5.12);
  assert.equal(err.details.monthlyCapUsd, 5);
  assert.equal(err.details.dailyUsedUsd, 5.12);
  // message/type/code stay on their own fields, not duplicated into details.
  assert.equal(err.details.message, undefined);
  assert.equal(err.details.type, undefined);
});

// insufficient_credits (empty prepaid balance) carries the balance instead.
test("toError surfaces an insufficient_credits balance as `details`", async () => {
  const client = clientWithJson(402, {
    error: {
      type: "insufficient_credits",
      message: "Insufficient credits. Top up your account to continue.",
      balanceCredits: 0,
      balanceMicro: 0,
    },
  });
  const err = await rejection(
    client.chat({ model: "air-auto", messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(err.code, "insufficient_credits");
  assert.equal(err.details.balanceCredits, 0);
});

// A plain error (only message/type) must NOT grow an empty `details` bag.
test("toError leaves `details` unset when there are no extra fields", async () => {
  const client = clientWithJson(429, { error: { type: "rate_limit", message: "slow down" } });
  const err = await rejection(
    client.chat({ model: "air-auto", messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(err.code, "rate_limit");
  assert.equal(err.details, undefined);
});
