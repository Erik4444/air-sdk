// Public wire-types for @viere/air-client: the OpenAI-compatible surface AIR
// speaks plus AIR's own run envelope. Kept narrow — fields AIR adds later ride
// in the passthrough `extra`, so no client release is needed for them.

export type Role = "system" | "user" | "assistant" | "tool";

/** OpenAI-kompatible Content-Parts: Text-Parts haben `text`, Image-Parts ein
 *  `image_url`-Objekt (URL oder data:-URI mit base64). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  /** Assistant-emitted tool calls, echoed back unchanged. */
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
    /** Raw JSON string as emitted by the model; parse on the consumer side. */
    arguments: string;
  };
}

/** Subset of AIR's run envelope; `extra` carries any fields not modeled here. */
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
    /** Context window of the chosen model in tokens. */
    maxContext?: number;
    /** Per-1k input/output prices (USD) of the chosen model; consumers derive
     *  exact cost from these rates × token counts instead of an own price table. */
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
    /** Prompt tokens served from the provider's prompt cache; absent when the
     *  upstream doesn't report caching. */
    cachedTokens?: number;
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

/** Hard capability floors for routing; they can only tighten AIR's body-inferred
 *  constraints, never weaken them. Transported as `X-AIR-Require-*` /
 *  `X-AIR-Min-Context` headers. */
export interface SelectionConstraints {
  /** Minimum total context window (tokens) the model must support. */
  minContext?: number;
  requireTools?: boolean;
  requireVision?: boolean;
  requireJsonSchema?: boolean;
}

/** Weight vector over AIR's score axes; cost/latency are inverted at source, so
 *  a positive weight means "prefer cheaper / faster". Omitted axes fall back to the preset. */
export interface PolicyWeights {
  quality?: number;
  latency?: number;
  cost?: number;
}

/** Hard floors for a selection policy — a superset of SelectionConstraints; the
 *  richer gates ride in the request body, not in headers. */
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
  /** Only free or local models — the free-tier gate. */
  freeOnly?: boolean;
  minThroughputTps?: number;
  minKnowledgeCutoff?: string;
  minReliability?: number;
  minQuality?: number;
}

/** Full selection policy (sort axis + gates), sent as the `policy` body field
 *  and resolved by AIR on `air-auto` requests. */
export interface SelectionPolicy {
  preset?: "best" | "balanced" | "fast" | "cheap" | "auto";
  weights?: PolicyWeights;
  floors?: PolicyFloors;
  /** Maximum quality loss from the best eligible model, in score points. */
  maxQualityRegret?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string | string[];
  /** Selection policy for this call; overrides the client-level default. */
  policy?: SelectionPolicy;
  /** Conversation-sticky routing key (`X-AIR-Session`); overrides the client-level `session`. */
  session?: string;
  /** W3C trace-id (32 lowercase hex) sent as `traceparent`; overrides the client-level `trace`. */
  trace?: string;
  /** Hard routing constraints (see SelectionConstraints). */
  constraints?: SelectionConstraints;
  /** Force the AIR envelope into the response/stream; defaults to the client setting. */
  debug?: boolean;
  /** Reasoning effort (OpenAI o-series naming), forwarded as `reasoning.effort`;
   *  AIR silently drops it when the routed model isn't reasoning-capable. */
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
    /** Estimated cost (USD): the upstream's reported total, else per-1k rates × token counts. */
    costUsd?: number;
    /** Prompt tokens served from the provider's prompt cache. */
    cachedTokens?: number;
  };
  /** AIR-side run id from the `x-air-execution-id` header; pass it to
   *  `AirClient.feedback` to rate this exact routing decision. */
  executionId?: string;
  /** Present when `debug: true` was requested. */
  air?: AirEnvelope;
}

/** Inputs to `AirClient.feedback`; `success` is the only required signal, AIR
 *  derives a default outcome score from it. */
export interface FeedbackRequest {
  executionId: string;
  success: boolean;
  /** 0..1; overrides the success-derived default in AIR's metrics rollup. */
  outcomeScore?: number;
  /** Free-text, surfaced in the AIR dashboard, capped at 2000 chars. */
  comment?: string;
}

// Stream events emitted by `AirClient.chatStream`, discriminated by `type`.
export type StreamEvent =
  | { type: "text-delta"; text: string }
  /** Reasoning-Delta (`delta.reasoning`); fließt nur, wenn das Modell Reasoning
   *  streamt und `stripReasoning` nicht gesetzt ist. */
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "model-chosen"; envelope: AirEnvelope }
  | {
      type: "done";
      finishReason: string | null;
      envelope?: AirEnvelope;
      /** Token usage from the trailing usage chunk (the streaming envelope carries
       *  none); `costUsd` is the upstream's figure, else derived from per-1k rates. */
      usage?: { promptTokens?: number; completionTokens?: number; costUsd?: number; cachedTokens?: number };
    }
  | { type: "error"; error: AirClientError };

export interface AirClientError {
  code: string;
  message: string;
  httpStatus?: number;
  /** AIR-specific error code (timeout, upstream_4xx, …) when surfaced. */
  airCode?: string;
  /** Further structured fields of the AIR error payload — e.g. a 402's
   *  budget/balance numbers — so the UI needn't parse the message text. */
  details?: Record<string, unknown>;
}
