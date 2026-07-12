# @viere/air-sdk

TypeScript SDK for [AIR](https://air.viere.tech) — OpenAI-compatible chat
completions with a model-selection trace, selection policies, and tool-call
events.

AIR routes each request to the best model for the job (quality / latency /
cost weights, hard floors like EU-only or vision-required) and tells you *why*
in the stream. This SDK is the typed way to talk to it.

## Install

```sh
npm install @viere/air-sdk
```

Zero runtime dependencies. Node ≥ 18 (uses global `fetch`).

## Quick start

```ts
import { AirClient } from "@viere/air-sdk";

const air = new AirClient({
  baseUrl: "https://api.air.viere.tech",
  apiKey: process.env.AIR_API_KEY,
});

// Non-streaming: one call, routed by policy.
const res = await air.chat({
  model: "air-auto", // let the policy pick — or pin a concrete model id
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(res.message.content);
console.log(res.model, res.usage?.costUsd);
// res.executionId → pass to air.feedback() to rate this exact routing
// decision; add `debug: true` to get the full AirEnvelope (res.air).

// Streaming with model-selection trace and tool-call events.
for await (const ev of air.chatStream({ model: "air-auto", messages })) {
  // ev: token deltas, model_chosen, tool_call deltas, usage, done
}
```

## Selection policies

Requests carry a `SelectionPolicy`: weights sort the model pool, floors gate
it hard.

```ts
const policy = {
  weights: { quality: 0.7, latency: 0.3, cost: 0 },
  floors: { euOnly: true, minReliability: 80 },
};
await air.chat({ model: "air-auto", policy, messages });
```

Constraints such as `requireVision` or `requireTools` are inferred from the
request body (image parts, tool definitions) — set them explicitly only to
tighten routing beyond what the body implies.

## What this package is (and isn't)

- **Is**: the wire types (`SelectionPolicy`, score breakdowns, stream events)
  and a thin, dependency-free client for chat + streaming (SSE).
- **Isn't**: a UI framework. Rendering an event stream into chat bubbles is
  your app's job — the Viere Platform keeps its own display layer on top of
  this SDK, and yours will look different.

## Status

Extracted from the Viere Platform monorepo (2026-07) on the way to a
standalone release. API surface is small and stable; expect additive changes
around the selection trace as AIR grows.
