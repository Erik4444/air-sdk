// Public wire-types for @viere/air-client.
//
// Mirrors the OpenAI-compatible surface that AIR speaks, plus AIR's own
// run-envelope. Kept narrow: only what callers actually touch. Internal AIR
// fields (quarantine state, alternatives) are surfaced via a passthrough
// `extra` field so we don't need a client release every time AIR adds a key.

export type Role = "system" | "user" | "assistant" | "tool";

/**
 * OpenAI-kompatible Content-Parts für multi-modal Inputs. Text-Parts haben
 * `text`, Image-Parts ein `image_url`-Objekt (URL oder data:-URI mit base64).
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  /** Assistant-emitted tool calls (set by the model, echoed back unchanged). */
  tool_calls?: ToolCall[];
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** Raw JSON string as emitted by the model. Parse on the consumer side. */
    arguments: string;
  };
}

/** Subset of AIR's run envelope. `extra` carries any fields not modeled here. */
export interface AirEnvelope {
  executionId: string;
  status: "success" | "fallback_success" | "failed";
  task: string;
  /** Policy label ("auto"/preset/"custom"), "explicit" or "passthrough". */
  strategy: string;
  model: {
    id: string;
    provider: string;
    adapter: string;
    /** Context window of the chosen model in tokens (from AIR's capabilities).
     *  Consumers use it for context compaction + a usage gauge. */
    maxContext?: number;
    /** Per-1k input/output prices (USD) of the chosen model, when AIR knows
     *  them. Consumers compute exact cost from token counts — no own price
     *  table. The streaming envelope omits usage, so cost is derived client-side
     *  from these rates and the trailing usage chunk's token counts. */
    promptCostPer1k?: number;
    completionCostPer1k?: number;
  };
  score: {
    score: number;
    quality: number;
    latency: number;
    cost?: number;
  };
  timing: {
    startedAt: string;
    latencyMs: number;
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number;
  };
  attempts: Array<{
    model: string;
    status: "success" | "failed";
    latencyMs: number;
    errorCode?: string;
  }>;
  /** Original payload from AIR — use this for fields not lifted above. */
  extra: Record<string, unknown>;
}

/**
 * Hard capability requirements layered onto routing for this request.
 *
 * AIR already infers constraints from the request body (tools array →
 * requireTools, image parts → requireVision, json_schema response_format →
 * requireJsonSchema, prompt size → minContext). Setting fields here can
 * *tighten* the inferred floor — useful when the caller has out-of-band
 * knowledge (e.g. "this session will need vision in a later turn, route
 * to a vision-capable model now"). It cannot weaken the inference.
 *
 * Transport: each non-default field becomes an `X-AIR-Require-*` /
 * `X-AIR-Min-Context` header. Unset = AIR's body-based inference wins.
 */
export interface SelectionConstraints {
  /** Minimum total context window (tokens) the model must support. */
  minContext?: number;
  requireTools?: boolean;
  requireVision?: boolean;
  requireJsonSchema?: boolean;
}

/**
 * Weight vector over AIR's score axes for a selection policy. Higher weight =
 * prefer that axis. Cost/latency are inverted at source (higher = cheaper /
 * faster), so a positive cost/latency weight means "prefer cheaper / faster".
 * Partial — omitted components fall back to the preset; AIR normalises.
 */
export interface PolicyWeights {
  quality?: number;
  latency?: number;
  cost?: number;
}

/**
 * Hard floors for a selection policy. Superset of the header-transported
 * SelectionConstraints — the richer gates (reliability/cost/latency ceilings,
 * EU/local, throughput/recency) ride in the request body, not headers.
 */
export interface PolicyFloors {
  minContext?: number;
  requireTools?: boolean;
  requireVision?: boolean;
  requireJsonSchema?: boolean;
  minParametersB?: number;
  maxCostPer1k?: number;
  maxLatencyMs?: number;
  localOnly?: boolean;
  euOnly?: boolean;
  /** Only free or local models (isFree || isLocal) — the free-tier gate. */
  freeOnly?: boolean;
  minThroughputTps?: number;
  minKnowledgeCutoff?: string;
  minReliability?: number;
  minQuality?: number;
}

/**
 * Full selection policy: the sort axis (`weights`) + the gates (`floors`) — the
 * sole selection surface. Sent as the `policy` body field; AIR resolves it
 * (preset name or partial object) and ranks the catalog with it on `air-auto` requests.
 */
export interface SelectionPolicy {
  preset?: "best" | "fast" | "cheap" | "auto";
  weights?: PolicyWeights;
  floors?: PolicyFloors;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string | string[];
  /** Full selection policy (weights + floors) — the sole selection surface.
   *  Overrides the client-level default; sent as the `policy` body field. AIR
   *  sorts by the weights and gates by the floors. */
  policy?: SelectionPolicy;
  /** Conversation-sticky routing key for this call (`X-AIR-Session`).
   *  Overrides the client-level `session`. */
  session?: string;
  /** Hard routing constraints (see SelectionConstraints). Optional. */
  constraints?: SelectionConstraints;
  /** Force the AIR envelope into the response/stream. Defaults to client setting. */
  debug?: boolean;
  /** How hard a reasoning-capable model should think (OpenAI o-series naming;
   *  AIR forwards it as OpenRouter's unified `reasoning.effort`). AIR silently
   *  drops it when the routed model isn't reasoning-capable — safe to set
   *  even when the caller doesn't know the target model ahead of time (e.g.
   *  policy routing via `air-auto`). */
  reasoningEffort?: "low" | "medium" | "high";
}

export interface ChatResponse {
  id: string;
  model: string;
  finishReason: string | null;
  message: ChatMessage;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    /** Estimated cost (USD) of this call: the upstream's reported total when
     *  present, else derived from the model's per-1k rates × token counts. */
    costUsd?: number;
  };
  /**
   * AIR-side run id, read from the `x-air-execution-id` response header.
   * Always populated for successful runs; pass to `AirClient.feedback`
   * to record thumbs-up/down or a free-text comment against this exact
   * routing decision.
   */
  executionId?: string;
  /** Present when `debug: true` was requested. */
  air?: AirEnvelope;
}

/**
 * Inputs to `AirClient.feedback`. `executionId` is the value surfaced by
 * `ChatResponse.executionId` (or `AirEnvelope.executionId` from a stream).
 * `success` is the only required signal; AIR derives a default outcome
 * score from it when no explicit `outcomeScore` is given.
 */
export interface FeedbackRequest {
  executionId: string;
  success: boolean;
  /** 0..1. Overrides the success-derived default in AIR's metrics rollup. */
  outcomeScore?: number;
  /** Free-text — surfaced in the AIR dashboard, capped at 2000 chars. */
  comment?: string;
}

// Stream-events emitted by `AirClient.chatStream`. Discriminated union by `type`.
export type StreamEvent =
  | { type: "text-delta"; text: string }
  /** Reasoning/Thinking-Delta (`delta.reasoning`) — fließt nur, wenn das Modell
   *  Reasoning streamt und `stripReasoning` NICHT gesetzt ist. */
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "model-chosen"; envelope: AirEnvelope }
  | {
      type: "done";
      finishReason: string | null;
      envelope?: AirEnvelope;
      /**
       * Token usage, when the upstream emitted a trailing usage chunk
       * (OpenAI `stream_options.include_usage`). The streaming `air.run`
       * envelope does not carry usage, so this is the canonical source for
       * token counts on a stream. Absent when the provider sends none.
       * `costUsd` is the upstream's reported cost when present, else derived
       * from the chosen model's per-1k rates × these token counts.
       */
      usage?: { promptTokens?: number; completionTokens?: number; costUsd?: number };
    }
  | { type: "error"; error: AirClientError };

export interface AirClientError {
  code: string;
  message: string;
  httpStatus?: number;
  /** AIR-specific error code (timeout, upstream_4xx, …) when surfaced. */
  airCode?: string;
}
