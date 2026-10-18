import { describe, expect, it } from "vitest";
import { ChatError } from "../src/llm/types.ts";
import { chatDeltas, readSse, SseParser } from "../src/llm/sse.ts";
import { collect, enc, splitAt, sseResponse, streamOf } from "./helpers.ts";

// A recorded-style OpenRouter stream: processing comments, a role-only first delta, CRLF events, two events in
// one write, a keep-alive comment, a finish chunk without content, [DONE] - and Turkish multi-byte text + emoji.
const RECORDED =
  ": OPENROUTER PROCESSING\n\n" +
  'data: {"id":"gen-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n' +
  'data: {"id":"gen-1","choices":[{"index":0,"delta":{"content":"Merhaba! "}}]}\r\n\r\n' +
  'data: {"id":"gen-1","choices":[{"index":0,"delta":{"content":"Bugün çok güzel"}}]}\n\ndata: {"id":"gen-1","choices":[{"index":0,"delta":{"content":" bir gün, değil mi? İyi şanslar 🌞, Ağaçlı Şişli."}}]}\n\n' +
  ": OPENROUTER PROCESSING\n\n" +
  'data: {"id":"gen-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":12}}\n\n' +
  "data: [DONE]\n\n";
const EXPECTED = "Merhaba! Bugün çok güzel bir gün, değil mi? İyi şanslar 🌞, Ağaçlı Şişli.";

describe("SseParser", () => {
  it("parses events, comments, multi-line data, event names and ids", () => {
    const p = new SseParser();
    const events = [
      ...p.feed(": comment\nevent: ping\nid: 7\ndata: a\ndata: b\n\n"),
      ...p.feed("data:no-space\n\n"),
      ...p.feed("retry: 100\nunknown: x\ndata: last"),
      ...p.end(),
    ];
    expect(events).toEqual([
      { event: "ping", data: "a\nb", id: "7" },
      { event: "message", data: "no-space", id: "7" },
      { event: "message", data: "last", id: "7" },
    ]);
  });

  it("handles CR-only line ends and a CR split from its LF across chunks", () => {
    const p = new SseParser();
    const events = [...p.feed("data: one\r"), ...p.feed("\r"), ...p.feed("data: two\r"), ...p.feed("\n\r\n"), ...p.end()];
    expect(events.map((e) => e.data)).toEqual(["one", "two"]);
  });

  it("drops events without data", () => {
    const p = new SseParser();
    expect([...p.feed("event: x\n\n: only a comment\n\n"), ...p.end()]).toEqual([]);
  });
});

describe("chatDeltas", () => {
  it("reassembles the recorded stream split at EVERY byte offset (also inside multi-byte UTF-8 characters)", async () => {
    const bytes = enc.encode(RECORDED);
    // make sure the fixture really has multi-byte characters to split
    expect(bytes.length).toBeGreaterThan(RECORDED.length);
    for (let cut = 1; cut < bytes.length; cut++) {
      const deltas = await collect(chatDeltas(sseResponse(splitAt(bytes, [cut]))));
      expect(deltas.join(""), `split at byte ${cut}`).toBe(EXPECTED);
    }
  });

  it("reassembles the stream delivered one byte at a time and in uneven 3-way splits", async () => {
    const bytes = enc.encode(RECORDED);
    const single = Array.from(bytes, (b) => new Uint8Array([b]));
    expect((await collect(chatDeltas(sseResponse(single)))).join("")).toBe(EXPECTED);
    for (let a = 1; a < bytes.length - 1; a += 7) {
      const b = Math.min(bytes.length - 1, a + 1 + ((a * 13) % 29));
      expect((await collect(chatDeltas(sseResponse(splitAt(bytes, [a, b]))))).join("")).toBe(EXPECTED);
    }
  });

  it("stops at [DONE] even if more data follows", async () => {
    const s = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n';
    expect(await collect(chatDeltas(sseResponse([enc.encode(s)])))).toEqual(["a"]);
  });

  it("handles a final event without the trailing blank line, and skips non-JSON data", async () => {
    const s = 'data: hello\n\ndata: {"choices":[{"delta":{"content":"x"}}]}';
    expect(await collect(chatDeltas(sseResponse([enc.encode(s)])))).toEqual(["x"]);
  });

  it("throws the upstream message on an error payload in the middle of the stream, after the earlier deltas", async () => {
    const s =
      'data: {"choices":[{"delta":{"content":"Mer"}}]}\n\n' +
      'data: {"id":"gen-1","error":{"code":502,"message":"Provider returned error"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"never"}}]}\n\n';
    const seen: string[] = [];
    const err = await (async () => {
      try {
        for await (const d of chatDeltas(sseResponse([enc.encode(s)]))) seen.push(d);
      } catch (e) {
        return e;
      }
    })();
    expect(seen).toEqual(["Mer"]);
    expect(err).toBeInstanceOf(ChatError);
    expect((err as Error).message).toContain("Provider returned error");
  });

  it("maps a mid-stream error code to the matching error kind", async () => {
    const s = 'data: {"error":{"code":429,"message":"slow down"}}\n\n';
    await expect(collect(chatDeltas(sseResponse([enc.encode(s)])))).rejects.toMatchObject({ code: "rate_limited" });
  });

  it.each([
    [401, { error: { message: "No auth credentials found", code: 401 } }, "invalid_key", /invalid API key/],
    [402, { error: { message: "Insufficient credits", code: 402 } }, "credits", /credits/],
    [429, { error: { message: "Rate limit exceeded", code: 429 } }, "rate_limited", /rate limited/],
    [500, { error: { message: "Internal" } }, "upstream", /Internal/],
    [503, { error: { message: "The chat proxy has no OpenRouter API key: put OPENROUTER_API_KEY=..." } }, "not_configured", /OPENROUTER_API_KEY/],
  ])("turns HTTP %i into a ChatError with the upstream message", async (status, body, code, pattern) => {
    const res = new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const err = await collect(chatDeltas(res)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect(err).toMatchObject({ code, status });
    expect((err as Error).message).toMatch(pattern);
    expect((err as Error).message).toContain(body.error.message.slice(0, 20));
  });

  it("uses the body text when an error response is not JSON", async () => {
    const res = new Response("Bad gateway from nginx", { status: 502 });
    await expect(collect(chatDeltas(res))).rejects.toThrow(/Bad gateway from nginx/);
  });

  it("reads a plain JSON completion when the backend did not stream", async () => {
    const res = new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Tamam." } }] }), {
      headers: { "Content-Type": "application/json" },
    });
    expect(await collect(chatDeltas(res))).toEqual(["Tamam."]);
  });

  it("aborts with an AbortError and cancels the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const abort = new AbortController();
    const got: string[] = [];
    const err = await (async () => {
      try {
        for await (const d of chatDeltas(new Response(body, { headers: { "Content-Type": "text/event-stream" } }), abort.signal)) {
          got.push(d);
          abort.abort();
        }
      } catch (e) {
        return e;
      }
    })();
    expect(got).toEqual(["a"]);
    expect((err as Error).name).toBe("AbortError");
    expect(cancelled).toBe(true);
  });

  it("readSse cancels the stream when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("data: 1\n\ndata: 2\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const ev of readSse(body)) {
      expect(ev.data).toBe("1");
      break;
    }
    expect(cancelled).toBe(true);
  });

  it("works with a stream of many tiny events", async () => {
    const words = Array.from({ length: 300 }, (_, i) => `kelime${i} `);
    const s = words.map((w) => `data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    const bytes = enc.encode(s);
    const chunks = splitAt(bytes, Array.from({ length: 50 }, (_, i) => Math.floor(((i + 1) * bytes.length) / 51)));
    expect((await collect(chatDeltas(new Response(streamOf(chunks))))).join("")).toBe(words.join(""));
  });
});
