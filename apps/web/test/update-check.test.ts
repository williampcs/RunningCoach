import { describe, expect, it } from "vitest";

import { newerCommit } from "../src/update-check";

const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("newerCommit", () => {
  it("returns the server commit when it differs", async () => {
    expect(await newerCommit("abc1234", respond({ commit: "def5678", date: "2026-10-24" }))).toBe("def5678");
  });

  it("returns null when the commit is the same", async () => {
    expect(await newerCommit("abc1234", respond({ commit: "abc1234" }))).toBeNull();
  });

  it("asks for an uncached copy", async () => {
    let init: RequestInit | undefined;
    const fetcher = (async (_url: string, i?: RequestInit) => {
      init = i;
      return new Response(JSON.stringify({ commit: "abc1234" }));
    }) as unknown as typeof fetch;
    await newerCommit("abc1234", fetcher);
    expect(init?.cache).toBe("no-store");
  });

  it("stays quiet when the file is missing, offline, not JSON or malformed", async () => {
    expect(await newerCommit("abc1234", respond({}, 404))).toBeNull();
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await newerCommit("abc1234", offline)).toBeNull();
    // 本機開發的伺服器對不存在的路徑回傳 index.html
    const html = (async () => new Response("<!doctype html><html></html>")) as unknown as typeof fetch;
    expect(await newerCommit("abc1234", html)).toBeNull();
    expect(await newerCommit("abc1234", respond({ commit: 42 }))).toBeNull();
    expect(await newerCommit("abc1234", respond(null))).toBeNull();
  });
});
