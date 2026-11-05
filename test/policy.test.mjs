import assert from "node:assert/strict";
import test from "node:test";
import { AirClient } from "../dist/index.js";

test("benannte Policy und Qualitätsgrenze kommen unverändert bei AIR an", async () => {
  let sent;
  const client = new AirClient({ baseUrl: "http://air.test", fetch: async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
      headers: { "content-type": "application/json" },
    });
  } });
  const policy = { preset: "balanced", floors: { requireTools: true }, maxQualityRegret: 0 };
  await client.chat({ model: "air-auto", messages: [{ role: "user", content: "hi" }], policy });
  assert.deepEqual(sent.policy, policy);
});
