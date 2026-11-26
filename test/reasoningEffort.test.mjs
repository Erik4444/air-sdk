import assert from "node:assert/strict";
import test from "node:test";

import { RelaisClient } from "../dist/index.js";

// Regression für `ChatRequest.reasoningEffort` → muss als `reasoning_effort`
// im ausgehenden Request-Body landen (Relais entscheidet server-seitig, ob das
// geroutete Modell es überhaupt anwendet).

const minimalCompletion = () =>
  new Response(
    JSON.stringify({
      id: "cmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

test("chat(): reasoningEffort is forwarded as reasoning_effort in the request body", async () => {
  let capturedBody;
  const client = new RelaisClient({
    baseUrl: "http://relais.test",
    fetch: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return minimalCompletion();
    },
  });

  await client.chat({
    model: "relais-auto",
    messages: [{ role: "user", content: "hi" }],
    reasoningEffort: "high",
  });

  assert.equal(capturedBody.reasoning_effort, "high");
});

test("chat(): reasoning_effort is omitted from the body when reasoningEffort isn't set", async () => {
  let capturedBody;
  const client = new RelaisClient({
    baseUrl: "http://relais.test",
    fetch: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return minimalCompletion();
    },
  });

  await client.chat({ model: "relais-auto", messages: [{ role: "user", content: "hi" }] });

  assert.equal("reasoning_effort" in capturedBody, false);
});

test("chatStream(): reasoningEffort is forwarded as reasoning_effort in the request body", async () => {
  let capturedBody;
  const client = new RelaisClient({
    baseUrl: "http://relais.test",
    fetch: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const gen = client.chatStream({
    model: "relais-auto",
    messages: [{ role: "user", content: "hi" }],
    reasoningEffort: "low",
  });
  for await (const _ev of gen) {
    /* drain */
  }

  assert.equal(capturedBody.reasoning_effort, "low");
});
