import assert from "node:assert/strict";
import test from "node:test";

import { AirClient } from "../dist/index.js";

// Prompt-Caching-Messung: der
// Upstream meldet Cache-Treffer als `usage.prompt_tokens_details.cached_tokens`
// (OpenAI-/OpenRouter-Wire) — der Client muss sie als `cachedTokens` liefern,
// im Stream wie non-streaming. Fehlt das Feld, bleibt `cachedTokens` absent.

const clientWith = (body, headers = { "content-type": "application/json" }) =>
  new AirClient({
    baseUrl: "http://air.test",
    fetch: async () => new Response(body, { status: 200, headers }),
  });

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test("non-streaming: cached_tokens aus prompt_tokens_details wird zu usage.cachedTokens", async () => {
  const client = clientWith(
    JSON.stringify({
      id: "r1",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    }),
  );
  const res = await client.chat({ model: "air-auto", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.usage.promptTokens, 1200);
  assert.equal(res.usage.cachedTokens, 1024);
});

test("non-streaming: ohne prompt_tokens_details bleibt cachedTokens absent", async () => {
  const client = clientWith(
    JSON.stringify({
      id: "r2",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
  );
  const res = await client.chat({ model: "air-auto", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.usage.cachedTokens, undefined);
});

test("streaming: Trailing-Usage-Chunk trägt cachedTokens bis ins done-Event", async () => {
  const client = new AirClient({
    baseUrl: "http://air.test",
    fetch: async () =>
      new Response(
        [
          sse({ choices: [{ index: 0, delta: { content: "hi" } }] }),
          sse({
            choices: [],
            usage: { prompt_tokens: 500, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 384 } },
          }),
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  const events = [];
  for await (const ev of client.chatStream({ model: "air-auto", messages: [{ role: "user", content: "hi" }] }))
    events.push(ev);
  const done = events.find((e) => e.type === "done");
  assert.equal(done.usage.promptTokens, 500);
  assert.equal(done.usage.cachedTokens, 384);
});
