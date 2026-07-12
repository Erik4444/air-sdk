import type {
  AirClientError,
  AirEnvelope,
  ChatRequest,
  ChatResponse,
  FeedbackRequest,
  SelectionPolicy,
  StreamEvent,
  ToolDef,
} from "./types.js";
import { readSse } from "./sse.js";

export interface AirClientOptions {
  /** Base URL of AIR, e.g. `http://localhost:4000`. The `/v1` prefix is appended automatically. */
  baseUrl: string;
  /** API token. Sent as `Authorization: Bearer <token>`. Omit for sessions that don't need auth. */
  apiKey?: string;
  /** Default selection policy (weights + floors) — the sole selection surface.
   *  Sent as the `policy` body field. Per-call `req.policy` wins. */
  policy?: SelectionPolicy;
  /** When true, include the AIR envelope in every response/stream (`X-AIR-Debug`). */
  debug?: boolean;
  /** When true, strip `delta.reasoning` from streaming chunks (`X-AIR-Reasoning: strip`). */
  stripReasoning?: boolean;
  /** Conversation-sticky routing key (`X-AIR-Session`). Requests sharing the
   *  key reuse the first chosen model while it stays eligible — keeps the
   *  prompt cache warm and the voice consistent across turns. */
  session?: string;
  /** Custom fetch impl — useful for testing or for Next.js route-handler proxying. */
  fetch?: typeof fetch;
  /** Optional AbortSignal applied to every request. Per-call signals override this. */
  signal?: AbortSignal;
}

export class AirClient {
  private readonly opts: AirClientOptions;

  constructor(opts: AirClientOptions) {
    if (!opts.baseUrl) throw new Error("AirClient: baseUrl is required");
    this.opts = opts;
  }

  /** Non-streaming chat. Resolves to a parsed message + optional envelope. */
  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = toOpenAIBody(req, false);
    const response = await this.send(body, req, signal);
    const json = (await response.json()) as RawCompletion;
    if (!response.ok) throw toError(json, response.status);
    const executionId = response.headers.get("x-air-execution-id") ?? undefined;
    return fromCompletion(json, executionId);
  }

  /**
   * Record success/failure feedback for a previous run. Identified by the
   * `executionId` returned on `ChatResponse.executionId` (or the envelope
   * id from a stream). Persisted to AIR's metrics so future routing
   * decisions weigh the same model lower for this task on repeated
   * negative feedback.
   *
   * Throws `AirClientError` on non-2xx. Resolves to void on success — AIR
   * doesn't return a meaningful body here.
   */
  async feedback(req: FeedbackRequest, signal?: AbortSignal): Promise<void> {
    if (!req.executionId) throw new Error("AirClient.feedback: executionId is required");
    const url = new URL("/api/feedback", this.opts.baseUrl).toString();
    const fetchImpl = this.opts.fetch ?? fetch;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify({
        executionId: req.executionId,
        success: req.success,
        ...(typeof req.outcomeScore === "number" ? { outcomeScore: req.outcomeScore } : {}),
        ...(typeof req.comment === "string" ? { comment: req.comment } : {}),
      }),
    };
    const effectiveSignal = signal ?? this.opts.signal;
    if (effectiveSignal) init.signal = effectiveSignal;
    const response = await fetchImpl(url, init);
    if (!response.ok) {
      let parsed: { error?: string } = {};
      try {
        parsed = (await response.json()) as { error?: string };
      } catch {
        /* keep empty */
      }
      throw {
        code: "feedback_failed",
        message: parsed.error ?? `AIR feedback failed with HTTP ${response.status}`,
        httpStatus: response.status,
      } satisfies AirClientError;
    }
  }

  /** Streaming chat. Yields a typed event per SSE frame until done. */
  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const body = toOpenAIBody(req, true);
    const response = await this.send(body, req, signal);
    if (!response.ok) {
      let parsed: RawCompletion = {};
      try {
        parsed = (await response.json()) as RawCompletion;
      } catch {
        /* keep empty */
      }
      yield { type: "error", error: toError(parsed, response.status) };
      return;
    }
    yield* decodeStream(response);
  }

  private async send(
    body: Record<string, unknown>,
    req: ChatRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = new URL("/v1/chat/completions", this.opts.baseUrl).toString();
    const fetchImpl = this.opts.fetch ?? fetch;
    const debug = req.debug ?? this.opts.debug ?? false;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: body["stream"] ? "text/event-stream" : "application/json",
    };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    if (debug) headers["x-air-debug"] = "true";
    if (this.opts.stripReasoning) headers["x-air-reasoning"] = "strip";
    const session = req.session ?? this.opts.session;
    if (session) headers["x-air-session"] = session;
    // Selection policy travels in the body (not headers): the floors are richer
    // than the header set. Per-call wins over the client default.
    const policy = req.policy ?? this.opts.policy;
    if (policy) body.policy = policy;
    // Constraint headers — AIR treats these as the floor over body-inferred
    // constraints, so an explicit "true" can only tighten, never widen.
    const c = req.constraints;
    if (c) {
      if (c.requireTools) headers["x-air-require-tools"] = "true";
      if (c.requireVision) headers["x-air-require-vision"] = "true";
      if (c.requireJsonSchema) headers["x-air-require-json-schema"] = "true";
      if (typeof c.minContext === "number" && c.minContext > 0) {
        headers["x-air-min-context"] = String(Math.floor(c.minContext));
      }
    }

    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    };
    const effectiveSignal = signal ?? this.opts.signal;
    if (effectiveSignal) init.signal = effectiveSignal;
    return fetchImpl(url, init);
  }
}

// ---- wire-format helpers ---------------------------------------------------

interface RawCompletion {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenRouter cost extensions (USD). Present only when the upstream prices
     *  the call inline; authoritative over a rate-based estimate when it is. */
    total_cost?: number;
    cost?: number;
  };
  air?: Record<string, unknown>;
  error?: { message?: string; code?: string; type?: string };
}

interface RawStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: {
      role?: string;
      content?: string | null;
      /** Reasoning/Thinking-Stream (OpenRouter/DeepSeek-Konvention). */
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  // Trailing usage chunk (OpenAI `stream_options.include_usage`). Carries
  // empty `choices`, so it's read independently of the content deltas.
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenRouter inline cost (USD), when the upstream prices the stream. */
    total_cost?: number;
    cost?: number;
  };
}

// Validate that a value is JSON-serializable (no functions, symbols, undefined, circular refs)
const isJsonSerializable = (value: unknown, seen = new WeakSet<object>()): boolean => {
  if (value === null || typeof value !== "object") {
    return typeof value !== "function" && typeof value !== "symbol" && value !== undefined;
  }
  if (seen.has(value)) return false; // circular reference
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((v) => isJsonSerializable(v, seen));
  }
  return Object.values(value).every((v) => isJsonSerializable(v, seen));
};

// Sanitize a tool definition for safe JSON transport to upstream provider
const sanitizeTool = (tool: ToolDef): ToolDef | null => {
  const fn = tool.function;
  if (!fn || typeof fn !== "object") return null;
  const name = typeof fn.name === "string" ? fn.name : "";
  const description = typeof fn.description === "string" ? fn.description : "";
  const params = fn.parameters && isJsonSerializable(fn.parameters) ? fn.parameters : { type: "object", properties: {} };
  if (!name) return null;
  return { type: "function", function: { name, description, parameters: params } };
};

const toOpenAIBody = (req: ChatRequest, stream: boolean): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream,
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(sanitizeTool).filter((t): t is ToolDef => t !== null);
  }
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.topP === "number") body.top_p = req.topP;
  if (typeof req.maxTokens === "number") body.max_tokens = req.maxTokens;
  if (typeof req.stop !== "undefined") body.stop = req.stop;
  if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
  return body;
};

const fromCompletion = (raw: RawCompletion, executionId?: string): ChatResponse => {
  const choice = raw.choices?.[0];
  const msg = choice?.message ?? {};
  const toolCalls =
    msg.tool_calls?.map((tc) => ({
      id: tc.id ?? "",
      type: "function" as const,
      function: {
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "",
      },
    })) ?? undefined;
  const response: ChatResponse = {
    id: raw.id ?? "",
    model: raw.model ?? "",
    finishReason: choice?.finish_reason ?? null,
    message: {
      role: (msg.role as "assistant" | undefined) ?? "assistant",
      content: msg.content ?? "",
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    },
  };
  if (raw.usage) {
    response.usage = {
      ...(typeof raw.usage.prompt_tokens === "number" ? { promptTokens: raw.usage.prompt_tokens } : {}),
      ...(typeof raw.usage.completion_tokens === "number"
        ? { completionTokens: raw.usage.completion_tokens }
        : {}),
      ...(typeof raw.usage.total_cost === "number"
        ? { costUsd: raw.usage.total_cost }
        : typeof raw.usage.cost === "number"
        ? { costUsd: raw.usage.cost }
        : {}),
    };
  }
  // Prefer the header value — it's always present. Fall back to the envelope
  // only when the caller asked for debug and the header was somehow stripped
  // (proxies, browser fetch quirks).
  if (executionId) response.executionId = executionId;
  if (raw.air) {
    const env = liftEnvelope(raw.air);
    response.air = env;
    if (!response.executionId && env.executionId) response.executionId = env.executionId;
    // Cost: prefer AIR's server-side estimate (the non-streaming envelope
    // carries it), else derive from the envelope's per-1k rates × token counts.
    if (response.usage && response.usage.costUsd === undefined) {
      const derived = withDerivedCost(response.usage, env.model);
      const cost = env.usage?.costUsd ?? derived.costUsd;
      if (typeof cost === "number") response.usage.costUsd = cost;
    }
  }
  return response;
};

const toError = (raw: RawCompletion, status: number): AirClientError => {
  const msg = raw.error?.message ?? `AIR request failed with HTTP ${status}`;
  const error: AirClientError = {
    code: raw.error?.type ?? "request_failed",
    message: msg,
    httpStatus: status,
  };
  if (raw.error?.code) error.airCode = raw.error.code;
  return error;
};

type StreamUsage = { promptTokens?: number; completionTokens?: number; costUsd?: number };

/** Fill `costUsd` from the chosen model's per-1k rates when the upstream didn't
 *  report a cost inline. Tokens × rate, split by input/output — AIR carries the
 *  rates on the envelope `model` block. Returns the usage unchanged when it
 *  already has a cost or the rates are unknown (free/local models). */
const withDerivedCost = (
  usage: StreamUsage,
  model: AirEnvelope["model"] | undefined,
): StreamUsage => {
  if (typeof usage.costUsd === "number") return usage;
  const pr = model?.promptCostPer1k;
  const cr = model?.completionCostPer1k;
  if (typeof pr !== "number" || typeof cr !== "number") return usage;
  const pt = usage.promptTokens ?? 0;
  const ct = usage.completionTokens ?? 0;
  if (pt + ct === 0) return { ...usage, costUsd: 0 };
  return { ...usage, costUsd: (pt / 1000) * pr + (ct / 1000) * cr };
};

const makeDone = (
  finishReason: string | null,
  envelope: AirEnvelope | undefined,
  usage: StreamUsage | undefined,
): StreamEvent => {
  const done: Extract<StreamEvent, { type: "done" }> = { type: "done", finishReason };
  if (envelope) done.envelope = envelope;
  if (usage && (usage.promptTokens !== undefined || usage.completionTokens !== undefined)) {
    done.usage = withDerivedCost(usage, envelope?.model);
  }
  return done;
};

async function* decodeStream(response: Response): AsyncGenerator<StreamEvent> {
  let envelope: AirEnvelope | undefined;
  let finishReason: string | null = null;
  let usage: StreamUsage | undefined;
  for await (const frame of readSse(response)) {
    if (frame.event === "air.run") {
      try {
        // AIR wraps the envelope as `{ object: "air.run", air: <envelope> }`
        // (the non-streaming body nests it under `air` too). Unwrap `.air`;
        // fall back to the frame itself for older/flat builds.
        const parsed = JSON.parse(frame.data) as Record<string, unknown>;
        const raw = (parsed.air ?? parsed) as Record<string, unknown>;
        const env = liftEnvelope(raw);
        // The streaming envelope omits usage; carry the trailing usage chunk in
        // so consumers reading `envelope.usage` see token counts + derived cost.
        if (usage && !env.usage) env.usage = withDerivedCost(usage, env.model);
        envelope = env;
        yield { type: "model-chosen", envelope: env };
      } catch {
        /* malformed envelope — ignore */
      }
      continue;
    }
    if (frame.data === "[DONE]") {
      yield makeDone(finishReason, envelope, usage);
      return;
    }
    let chunk: RawStreamChunk;
    try {
      chunk = JSON.parse(frame.data) as RawStreamChunk;
    } catch {
      continue;
    }
    // The trailing usage chunk has an empty `choices` array — read it before
    // the choice guard below, otherwise the token counts are dropped.
    if (chunk.usage) {
      usage = {
        ...(typeof chunk.usage.prompt_tokens === "number"
          ? { promptTokens: chunk.usage.prompt_tokens }
          : {}),
        ...(typeof chunk.usage.completion_tokens === "number"
          ? { completionTokens: chunk.usage.completion_tokens }
          : {}),
        // Authoritative inline cost when the upstream prices the stream; else
        // left undefined and derived from the model's rates at done-time.
        ...(typeof chunk.usage.total_cost === "number"
          ? { costUsd: chunk.usage.total_cost }
          : typeof chunk.usage.cost === "number"
          ? { costUsd: chunk.usage.cost }
          : {}),
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text-delta", text: delta.content };
    }
    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
      yield { type: "reasoning-delta", text: delta.reasoning };
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const ev: StreamEvent = {
          type: "tool-call-delta",
          index: tc.index ?? 0,
        };
        if (tc.id) (ev as { id?: string }).id = tc.id;
        if (tc.function?.name) (ev as { name?: string }).name = tc.function.name;
        if (typeof tc.function?.arguments === "string") {
          (ev as { argumentsDelta?: string }).argumentsDelta = tc.function.arguments;
        }
        yield ev;
      }
    }
  }
  yield makeDone(finishReason, envelope, usage);
}

const liftEnvelope = (raw: Record<string, unknown>): AirEnvelope => {
  // Trust AIR's shape — narrow at the boundary, surface unknowns via `extra`.
  // We don't validate aggressively; clients can switch on `status` / `model.id`.
  const model = (raw.model ?? {}) as Record<string, unknown>;
  const score = (raw.score ?? {}) as Record<string, unknown>;
  const timing = (raw.timing ?? {}) as Record<string, unknown>;
  const usage = raw.usage as Record<string, unknown> | undefined;
  const attempts = Array.isArray(raw.attempts) ? (raw.attempts as Array<Record<string, unknown>>) : [];

  const env: AirEnvelope = {
    executionId: String(raw.executionId ?? ""),
    status: (raw.status as AirEnvelope["status"]) ?? "success",
    task: String(raw.task ?? ""),
    strategy: String(raw.strategy ?? ""),
    model: {
      id: String(model.id ?? ""),
      provider: String(model.provider ?? ""),
      adapter: String(model.adapter ?? ""),
      ...(typeof model.maxContext === "number" ? { maxContext: model.maxContext } : {}),
      ...(typeof model.promptCostPer1k === "number"
        ? { promptCostPer1k: model.promptCostPer1k }
        : {}),
      ...(typeof model.completionCostPer1k === "number"
        ? { completionCostPer1k: model.completionCostPer1k }
        : {}),
    },
    score: {
      score: Number(score.score ?? 0),
      quality: Number(score.quality ?? 0),
      latency: Number(score.latency ?? 0),
    },
    timing: {
      startedAt: String(timing.startedAt ?? ""),
      latencyMs: Number(timing.latencyMs ?? 0),
    },
    attempts: attempts.map((a) => {
      const out: AirEnvelope["attempts"][number] = {
        model: String(a.model ?? ""),
        status: (a.status as "success" | "failed") ?? "success",
        latencyMs: Number(a.latencyMs ?? 0),
      };
      if (a.errorCode !== undefined) out.errorCode = String(a.errorCode);
      return out;
    }),
    extra: raw,
  };
  if (typeof score.cost === "number") env.score.cost = score.cost;
  if (usage) {
    env.usage = {
      ...(typeof usage.promptTokens === "number" ? { promptTokens: usage.promptTokens } : {}),
      ...(typeof usage.completionTokens === "number" ? { completionTokens: usage.completionTokens } : {}),
      ...(typeof usage.costUsd === "number" ? { costUsd: usage.costUsd } : {}),
    };
  }
  return env;
};
