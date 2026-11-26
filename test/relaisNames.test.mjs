import assert from "node:assert/strict";
import test from "node:test";

import { RelaisClient } from "../dist/index.js";

// Relais statt Relais: Das SDK sendet nur die neuen Namen und liest beide, damit es gegen alte
// Server, in der Übergangszeit (beide Namen) und danach (nur neue) läuft.

const ENV = {
  executionId: "exec-1",
  status: "success",
  task: "general",
  strategy: "best",
  model: { id: "m", provider: "p", adapter: "openrouter" },
};

const recording = (respond) => {
  const calls = [];
  const client = new RelaisClient({
    baseUrl: "http://relais.test",
    apiKey: "sk-proj-relais-test",
    debug: true,
    stripReasoning: true,
    session: "s-1",
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return respond();
    },
  });
  return { client, calls };
};

const json = (body, headers = {}) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
const stream = (frames) => () =>
  new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

const COMPLETION = {
  id: "c1",
  model: "relais-auto",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
};
const REQ = {
  model: "relais-auto",
  messages: [{ role: "user", content: "hi" }],
  constraints: { requireTools: true, requireVision: true, requireJsonSchema: true, minContext: 9000 },
};

const collect = async (gen) => {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

test("sendet nur X-Relais-* und keine X-AIR-*", async () => {
  const { client, calls } = recording(json(COMPLETION));
  await client.chat(REQ);
  const headers = calls[0].headers;
  assert.deepEqual(
    Object.keys(headers).filter((h) => h.startsWith("x-relais-")).sort(),
    [
      "x-relais-debug",
      "x-relais-min-context",
      "x-relais-reasoning",
      "x-relais-require-json-schema",
      "x-relais-require-tools",
      "x-relais-require-vision",
      "x-relais-session",
    ],
  );
  assert.equal(Object.keys(headers).some((h) => h.toLowerCase().startsWith("x-air-")), false);
});

test("liest die Ausführungs-ID aus dem neuen und aus dem alten Header", async () => {
  const fresh = await recording(json(COMPLETION, { "x-relais-execution-id": "exec-new" })).client.chat(REQ);
  assert.equal(fresh.executionId, "exec-new");
  const old = await recording(json(COMPLETION, { "x-air-execution-id": "exec-old" })).client.chat(REQ);
  assert.equal(old.executionId, "exec-old");
  const both = await recording(
    json(COMPLETION, { "x-relais-execution-id": "exec-new", "x-air-execution-id": "exec-new" }),
  ).client.chat(REQ);
  assert.equal(both.executionId, "exec-new");
});

test("liest den Umschlag aus relais, aus air und aus beiden", async () => {
  for (const body of [{ relais: ENV }, { air: ENV }, { relais: ENV, air: ENV }]) {
    const res = await recording(json({ ...COMPLETION, ...body })).client.chat(REQ);
    assert.equal(res.relais?.executionId, "exec-1", JSON.stringify(Object.keys(body)));
    assert.equal(res.executionId, "exec-1");
  }
});

test("der Run-Frame zählt einmal: relais.run, air.run mit beiden Feldern, altes air.run", async () => {
  const frames = {
    neu: `event: relais.run\ndata: ${JSON.stringify({ object: "relais.run", relais: ENV })}\n\n`,
    uebergang: `event: air.run\ndata: ${JSON.stringify({ object: "air.run", air: ENV, relais: ENV })}\n\n`,
    alt: `event: air.run\ndata: ${JSON.stringify({ object: "air.run", air: ENV })}\n\n`,
  };
  for (const [name, frame] of Object.entries(frames)) {
    const { client } = recording(
      stream([`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`, frame, "data: [DONE]\n\n"]),
    );
    const events = await collect(client.chatStream(REQ));
    const chosen = events.filter((e) => e.type === "model-chosen");
    assert.equal(chosen.length, 1, name);
    assert.equal(chosen[0].envelope.executionId, "exec-1", name);
    assert.equal(events.at(-1).type, "done", name);
    assert.equal(events.at(-1).envelope.executionId, "exec-1", name);
  }
});
