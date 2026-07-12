// Minimal SSE reader. Pure async-generator over a fetch Response body —
// no event-source dep, works in Node 18+ and browsers.
//
// Returns one frame per emit. A frame carries `event` (defaults to "message"
// when omitted) and `data` (concatenated `data:` lines as the spec requires).

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/** Async-iterate SSE frames from a `Response.body`. Throws if body is null. */
export async function* readSse(response: Response): AsyncGenerator<SseFrame> {
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const tail = flushFrame(buffer);
        if (tail) yield tail;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are delimited by blank lines. Process every complete one
      // in the buffer; keep the trailing partial.
      let sepIndex = findFrameBoundary(buffer);
      while (sepIndex !== -1) {
        const raw = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex).replace(/^(\r?\n){1,2}/, "");
        const frame = flushFrame(raw);
        if (frame) yield frame;
        sepIndex = findFrameBoundary(buffer);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

const findFrameBoundary = (buf: string): number => {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
};

const flushFrame = (raw: string): SseFrame | null => {
  if (!raw.trim()) return null;
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
    // `retry` is ignored — we don't reconnect.
  }
  if (dataLines.length === 0) return null;
  const frame: SseFrame = { event, data: dataLines.join("\n") };
  if (id !== undefined) frame.id = id;
  return frame;
};
