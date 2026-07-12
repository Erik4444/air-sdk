import assert from "node:assert/strict";
import test from "node:test";

import { AirClient } from "../dist/index.js";

// Build an AirClient whose injected fetch returns a fixed SSE stream, so we can
// drive decodeStream end-to-end without a network. Mirrors AIR's debug stream
// shape: content delta → trailing usage chunk → `air.run` envelope, then close
// (no explicit [DONE] in debug mode — the socket just ends).
const clientWithStream = (frames) =>
  new AirClient({
    baseUrl: "http://air.test",
    fetch: async () =>
      new Response(frames.join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });

const collect = async (gen) => {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const sseEnvelope = (env) =>
  `event: air.run\ndata: ${JSON.stringify({ object: "air.run", air: env })}\n\n`;

// The streaming envelope from AIR carries NO usage/cost — token counts arrive in
// the trailing chunk, rates on the envelope model. The client must multiply.
test("streaming cost is derived from the envelope's per-1k rates × token counts", async () => {
  const client = clientWithStream([
    sse({ choices: [{ index: 0, delta: { content: "hi" } }] }),
    sse({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } }),
    sseEnvelope({
      executionId: "x",
      status: "success",
      model: { id: "m", provider: "p", adapter: "openrouter", promptCostPer1k: 0.003, completionCostPer1k: 0.015 },
    }),
  ]);

  const events = await collect(client.chatStream({ model: "air-auto", messages: [{ role: "user", content: "hi" }] }));
  const done = events.find((e) => e.type === "done");
  const chosen = events.find((e) => e.type === "model-chosen");

  // 1000/1k*0.003 + 100/1k*0.015 = 0.003 + 0.0015 = 0.0045.
  // Averaging would have been wrong; the split is exact.
  assert.ok(Math.abs(done.usage.costUsd - 0.0045) < 1e-9, `got ${done?.usage?.costUsd}`);
  // Rates are lifted onto the envelope so other consumers can recompute too.
  assert.equal(chosen.envelope.model.promptCostPer1k, 0.003);
  assert.equal(chosen.envelope.model.completionCostPer1k, 0.015);
});

test("an upstream-reported inline cost wins over the rate-based estimate", async () => {
  const client = clientWithStream([
    sse({ choices: [{ index: 0, delta: { content: "hi" } }] }),
    // OpenRouter priced the stream inline → authoritative, ignore the rates.
    sse({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_cost: 0.42 } }),
    sseEnvelope({
      executionId: "x",
      status: "success",
      model: { id: "m", provider: "p", adapter: "openrouter", promptCostPer1k: 0.003, completionCostPer1k: 0.015 },
    }),
  ]);

  const done = (await collect(client.chatStream({ model: "air-auto", messages: [{ role: "user", content: "hi" }] }))).find(
    (e) => e.type === "done",
  );
  assert.equal(done.usage.costUsd, 0.42);
});

test("no rates and no reported cost → usage carries tokens but no costUsd (free/local)", async () => {
  const client = clientWithStream([
    sse({ choices: [{ index: 0, delta: { content: "hi" } }] }),
    sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    sseEnvelope({ executionId: "x", status: "success", model: { id: "free", provider: "p", adapter: "ollama" } }),
  ]);

  const done = (await collect(client.chatStream({ model: "air-local", messages: [{ role: "user", content: "hi" }] }))).find(
    (e) => e.type === "done",
  );
  assert.equal(done.usage.promptTokens, 10);
  assert.equal(done.usage.costUsd, undefined);
});
