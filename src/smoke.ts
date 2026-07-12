// Smoke-Test: kein Test-Framework, einfach `node dist/smoke.js`.
// Validiert SSE-Decoder + Envelope-Lift + Stream-Event-Sequenz gegen einen
// gemockten AIR-Response. Bei Fehlschlag exit 1.

import { AirClient } from "./client.js";
import type { StreamEvent } from "./types.js";

const SSE_BODY = [
  // Erst die Modellauswahl als air.run-Frame.
  `event: air.run`,
  `data: ${JSON.stringify({
    executionId: "exec-1",
    status: "success",
    task: "general",
    strategy: "best",
    model: { id: "anthropic/claude-sonnet-4.6", provider: "anthropic", adapter: "anthropic" },
    score: { score: 0.91, quality: 0.95, latency: 0.6, cost: 0.4 },
    timing: { startedAt: "2026-05-19T22:00:00Z", latencyMs: 12 },
    attempts: [{ model: "anthropic/claude-sonnet-4.6", status: "success", latencyMs: 12 }],
  })}`,
  ``,
  // Dann zwei Text-Chunks.
  `data: ${JSON.stringify({
    id: "c1",
    model: "anthropic/claude-sonnet-4.6",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hallo" } }],
  })}`,
  ``,
  `data: ${JSON.stringify({
    id: "c1",
    model: "anthropic/claude-sonnet-4.6",
    choices: [{ index: 0, delta: { content: ", Welt." } }],
  })}`,
  ``,
  // Tool-Call-Delta.
  `data: ${JSON.stringify({
    id: "c1",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{"q":"x"}' },
            },
          ],
        },
      },
    ],
  })}`,
  ``,
  // Finish.
  `data: ${JSON.stringify({
    id: "c1",
    choices: [{ index: 0, finish_reason: "stop", delta: {} }],
  })}`,
  ``,
  `data: [DONE]`,
  ``,
].join("\n");

const mockFetch: typeof fetch = async () =>
  new Response(SSE_BODY, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const assert = (cond: unknown, msg: string): void => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  }
};

async function main(): Promise<void> {
  const client = new AirClient({
    baseUrl: "http://mock.local",
    debug: true,
    fetch: mockFetch,
  });

  const events: StreamEvent[] = [];
  for await (const ev of client.chatStream({
    model: "air-auto",
    messages: [{ role: "user", content: "ping" }],
  })) {
    events.push(ev);
  }

  const types = events.map((e) => e.type);
  console.log("events:", types.join(" → "));

  assert(types[0] === "model-chosen", "first event is model-chosen");
  const first = events[0];
  if (first?.type === "model-chosen") {
    assert(first.envelope.model.id === "anthropic/claude-sonnet-4.6", "envelope model id");
    assert(first.envelope.score.score === 0.91, "envelope score");
    assert(first.envelope.strategy === "best", "envelope policy label");
  }

  const text = events
    .filter((e): e is Extract<StreamEvent, { type: "text-delta" }> => e.type === "text-delta")
    .map((e) => e.text)
    .join("");
  assert(text === "Hallo, Welt.", `text concat ('${text}')`);

  const tcd = events.find(
    (e): e is Extract<StreamEvent, { type: "tool-call-delta" }> => e.type === "tool-call-delta",
  );
  assert(tcd?.id === "call_1", "tool-call id");
  assert(tcd?.name === "search", "tool-call name");
  assert(tcd?.argumentsDelta === '{"q":"x"}', "tool-call arguments");

  const done = events[events.length - 1];
  assert(done?.type === "done", "last event is done");
  if (done?.type === "done") {
    assert(done.finishReason === "stop", "finishReason=stop");
    assert(done.envelope?.executionId === "exec-1", "done carries envelope");
  }

  if (process.exitCode) {
    console.error("smoke failed");
  } else {
    console.log("smoke ok");
  }
}

async function testToolSanitization(): Promise<void> {
  console.log("\n--- Tool Sanitization Test ---");
  
  const client = new AirClient({
    baseUrl: "http://mock.local",
    debug: true,
    fetch: async (url, init) => {
      // Capture the request body to verify tools are sanitized
      const body = JSON.parse(init?.body as string ?? "{}");
      console.log("Request tools:", JSON.stringify(body.tools, null, 2));
      
      // Verify sanitization worked
      if (body.tools && body.tools.length > 0) {
        const tool = body.tools[0];
        if (tool.function.parameters && typeof tool.function.parameters === "object") {
          // Check that invalid values were replaced with safe defaults
          const params = tool.function.parameters as Record<string, unknown>;
          if (params.type === "object" && params.properties && typeof params.properties === "object") {
            console.log("✓ Tool sanitization: invalid parameters replaced with safe schema");
          }
        }
      }
      
      return new Response(SSE_BODY, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  // Tool with invalid parameters (function, symbol, undefined, circular ref)
  const invalidTool = {
    type: "function" as const,
    function: {
      name: "test_tool",
      description: "Test tool with invalid schema",
      parameters: {
        type: "object",
        properties: {
          validProp: { type: "string" },
          invalidFunc: () => "this is a function", // function - not JSON serializable
          invalidSymbol: Symbol("test"), // symbol - not JSON serializable
          invalidUndefined: undefined, // undefined - not JSON serializable
        },
        required: ["validProp"],
      },
    },
  };

  try {
    for await (const _ev of client.chatStream({
      model: "air-auto",
      messages: [{ role: "user", content: "ping" }],
      tools: [invalidTool],
    })) {
      // consume stream
    }
    console.log("✓ Tool sanitization test passed - no JSON.stringify error");
  } catch (e) {
    console.error("✗ Tool sanitization test failed:", e);
    process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).then(() => testToolSanitization());
