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
  /** Base URL of AIR, e.g. `http://localhost:4000`; the `/v1` prefix is appended automatically. */
  baseUrl: string;
  /** API token, sent as `Authorization: Bearer <token>`. */
  apiKey?: string;
  /** Default selection policy (`policy` body field); per-call `req.policy` wins. */
  policy?: SelectionPolicy;
  /** Include the AIR envelope in every response/stream (`X-AIR-Debug`). */
  debug?: boolean;
  /** Strip `delta.reasoning` from streaming chunks (`X-AIR-Reasoning: strip`). */
  stripReasoning?: boolean;
  /** Conversation-sticky routing key (`X-AIR-Session`); requests sharing it reuse the first chosen model while eligible. */
  session?: string;
  /** W3C trace-id (32 lowercase hex), sent as `traceparent`; per-call `req.trace` wins. */
  trace?: string;
  /** Custom fetch impl, e.g. for tests or Next.js route-handler proxying. */
  fetch?: typeof fetch;
  /** AbortSignal applied to every request; per-call signals override it. */
  signal?: AbortSignal;
}

export class AirClient {
  private readonly opts: AirClientOptions;

  constructor(opts: AirClientOptions) {
    if (!opts.baseUrl) throw new Error("AirClient: baseUrl is required");
    this.opts = opts;
  }

  /** Non-streaming chat; resolves to the parsed message plus optional envelope. */
  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = toOpenAIBody(req, false);
    const response = await this.send(body, req, signal);
    const json = (await response.json()) as RawCompletion;
    if (!response.ok) throw toError(json, response.status);
    const executionId = response.headers.get("x-air-execution-id") ?? undefined;
    return fromCompletion(json, executionId);
  }

  /** Record success/failure feedback for a previous run; throws `AirClientError` on non-2xx. */
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

  /** Streaming chat; yields one typed event per SSE frame until done. */
  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const body = toOpenAIBody(req, true);
    const response = await this.send(body, req, signal);
    if (!response.ok) {
      const parsed = await parseErrorResponse(response);
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
    // W3C Trace Context `00-<trace-id>-<span-id>-01`: fresh span id per request,
    // the caller's trace id ties every call of one operation together.
    const trace = req.trace ?? this.opts.trace;
    if (trace && /^[0-9a-f]{32}$/.test(trace)) {
      const span = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      headers["traceparent"] = `00-${trace}-${span}-01`;
    }
    // Policy travels in the body, not headers: the floors are richer than the header set.
    const policy = req.policy ?? this.opts.policy;
    if (policy) body.policy = policy;
    // AIR treats these headers as a floor over body-inferred constraints: "true" can only tighten.
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
    /** OpenRouter inline cost (USD); authoritative over a rate-based estimate when present. */
    total_cost?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  air?: Record<string, unknown>;
  // Index signature: type-specific error fields (e.g. a 402's budget numbers) pass through to `toError`.
  error?: { message?: string; code?: string; type?: string; [key: string]: unknown };
}

// AIR keeps streaming failures on the SSE contract even with a non-2xx status
// (`event: error` + error JSON + `[DONE]`), so the body may be JSON or SSE.
const parseErrorResponse = async (response: Response): Promise<RawCompletion> => {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as RawCompletion;
  } catch {
    // Continue with SSE framing below.
  }
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as RawCompletion;
      if (parsed.error) return parsed;
    } catch {
      // Keepalive/malformed frame — keep looking for an error frame.
    }
  }
  return {};
};

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
  // Trailing usage chunk (`stream_options.include_usage`); carries empty `choices`.
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenRouter inline cost (USD), when the upstream prices the stream. */
    total_cost?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

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
      ...(typeof raw.usage.prompt_tokens_details?.cached_tokens === "number"
        ? { cachedTokens: raw.usage.prompt_tokens_details.cached_tokens }
        : {}),
      ...(typeof raw.usage.total_cost === "number"
        ? { costUsd: raw.usage.total_cost }
        : typeof raw.usage.cost === "number"
        ? { costUsd: raw.usage.cost }
        : {}),
    };
  }
  // Header first (always present); the envelope is only a fallback for the
  // debug case where a proxy stripped the header.
  if (executionId) response.executionId = executionId;
  if (raw.air) {
    const env = liftEnvelope(raw.air);
    response.air = env;
    if (!response.executionId && env.executionId) response.executionId = env.executionId;
    // Prefer AIR's server-side cost estimate, else derive from the envelope's per-1k rates.
    if (response.usage && response.usage.costUsd === undefined) {
      const derived = withDerivedCost(response.usage, env.model);
      const cost = env.usage?.costUsd ?? derived.costUsd;
      if (typeof cost === "number") response.usage.costUsd = cost;
    }
  }
  return response;
};

const toError = (raw: RawCompletion, status?: number): AirClientError => {
  const msg =
    raw.error?.message ?? (status ? `AIR request failed with HTTP ${status}` : "AIR stream failed");
  const error: AirClientError = {
    code: raw.error?.type ?? "request_failed",
    message: msg,
    ...(typeof status === "number" ? { httpStatus: status } : {}),
  };
  if (raw.error?.code) error.airCode = raw.error.code;
  // Everything beyond message/type/code (e.g. a 402's budget numbers) rides in `details`.
  if (raw.error) {
    const { message: _m, type: _t, code: _c, ...rest } = raw.error;
    if (Object.keys(rest).length > 0) error.details = rest;
  }
  return error;
};

type StreamUsage = { promptTokens?: number; completionTokens?: number; costUsd?: number; cachedTokens?: number };

// Tokens × envelope per-1k rates; unchanged when a cost is present or the rates are unknown (free/local).
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
        // AIR wraps the envelope as `{ object: "air.run", air: <envelope> }`; a flat frame is accepted too.
        const parsed = JSON.parse(frame.data) as Record<string, unknown>;
        const raw = (parsed.air ?? parsed) as Record<string, unknown>;
        const env = liftEnvelope(raw);
        // The streaming envelope omits usage; carry the trailing usage chunk in.
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
    let chunk: RawStreamChunk & { error?: RawCompletion["error"] };
    try {
      chunk = JSON.parse(frame.data) as RawStreamChunk & { error?: RawCompletion["error"] };
    } catch {
      continue;
    }
    // AIR reports a failure after the headers went out as an `event: error`
    // frame (HTTP status already 200); some upstreams send a bare error object.
    // Either way the stream is over — surface it instead of ending "cleanly".
    if (frame.event === "error" || chunk.error) {
      yield {
        type: "error",
        error: toError(chunk as RawCompletion, response.status >= 400 ? response.status : undefined),
      };
      return;
    }
    // The trailing usage chunk has an empty `choices` array — read it before the choice guard.
    if (chunk.usage) {
      usage = {
        ...(typeof chunk.usage.prompt_tokens === "number"
          ? { promptTokens: chunk.usage.prompt_tokens }
          : {}),
        ...(typeof chunk.usage.completion_tokens === "number"
          ? { completionTokens: chunk.usage.completion_tokens }
          : {}),
        ...(typeof chunk.usage.prompt_tokens_details?.cached_tokens === "number"
          ? { cachedTokens: chunk.usage.prompt_tokens_details.cached_tokens }
          : {}),
        // Inline upstream cost is authoritative; otherwise derived from the rates at done-time.
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
  // Narrow at the boundary without aggressive validation; unknowns surface via `extra`.
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
