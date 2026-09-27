import { FetchLike } from "../http/transport.types.js";

export interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  url: string;
  init: RequestInit;
}

export interface FetchStub {
  fetch: FetchLike;
  calls: RecordedCall[];
}

export function stubFetch(responses: (StubResponse | Error)[]): FetchStub {
  const calls: RecordedCall[] = [];
  let index = 0;

  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    if (!next) throw new Error("stubFetch ran out of responses");
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json", ...next.headers },
    });
  };

  return { fetch, calls };
}

export function headerOf(call: RecordedCall, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}
