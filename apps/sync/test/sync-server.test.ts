import { beforeEach, describe, expect, it } from "vitest";

import { openNodeSqlite } from "@running-coach/sqlite-node";

import { createSyncHandler } from "../src/handler";
import { SyncStore } from "../src/store";

const SPACE = "0123456789abcdef0123456789abcdef";
const TOKEN = "t".repeat(43);
const ORIGIN = "https://example.github.io";

let now: Date;
let handle: (request: Request) => Promise<Response>;

beforeEach(async () => {
  now = new Date("2026-10-22T00:00:00Z");
  const store = new SyncStore(openNodeSqlite(":memory:"), () => now);
  await store.init();
  let n = 0;
  handle = createSyncHandler({
    store,
    allowedOrigins: [ORIGIN],
    // 配對碼可預測：每次多 1
    random: (bytes) => Uint8Array.from({ length: bytes }, (_, i) => (n + i) % 256).map((b, i) => (i === 0 ? n++ : b)),
  });
});

async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN, origin?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await handle(new Request(`http://sync.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: (res.status === 204 ? null : await res.json()) as Record<string, any>, headers: res.headers };
}

const blob = (n: number) => "b".repeat(n);

describe("同步空間", () => {
  it("建立、憑證、寫入、依序號取回、刪除", async () => {
    expect((await call("PUT", `/v1/spaces/${SPACE}`)).body).toEqual({ created: true });
    expect((await call("PUT", `/v1/spaces/${SPACE}`)).body).toEqual({ created: false });
    expect((await call("PUT", `/v1/spaces/${SPACE}`, undefined, "x".repeat(43))).status).toBe(403);
    expect((await call("GET", `/v1/spaces/${SPACE}/changes`, undefined, null)).status).toBe(401);
    expect((await call("GET", `/v1/spaces/${"f".repeat(32)}/changes`)).status).toBe(404);

    const push = await call("POST", `/v1/spaces/${SPACE}/changes`, {
      items: [
        { id: "aaaaaaaaaaaaaaaa", base: 0, blob: blob(10) },
        { id: "bbbbbbbbbbbbbbbb", base: 0, blob: blob(20) },
      ],
    });
    expect(push.body).toEqual({ applied: [{ id: "aaaaaaaaaaaaaaaa", seq: 1 }, { id: "bbbbbbbbbbbbbbbb", seq: 2 }], conflicts: [] });

    const all = await call("GET", `/v1/spaces/${SPACE}/changes?since=0`);
    expect(all.body.items.map((i: any) => [i.id, i.seq])).toEqual([["aaaaaaaaaaaaaaaa", 1], ["bbbbbbbbbbbbbbbb", 2]]);
    expect(all.body).toMatchObject({ latest: 2, more: false });
    expect(all.headers.get("cache-control")).toBe("no-store");

    // 依上次看到的序號更新；舊的序號是衝突
    expect((await call("POST", `/v1/spaces/${SPACE}/changes`, { items: [{ id: "aaaaaaaaaaaaaaaa", base: 1, blob: blob(5) }] })).body.applied).toEqual([
      { id: "aaaaaaaaaaaaaaaa", seq: 3 },
    ]);
    expect((await call("POST", `/v1/spaces/${SPACE}/changes`, { items: [{ id: "aaaaaaaaaaaaaaaa", base: 1, blob: blob(6) }] })).body).toEqual({
      applied: [],
      conflicts: ["aaaaaaaaaaaaaaaa"],
    });
    // 已經有的一筆不能當新的寫
    expect((await call("POST", `/v1/spaces/${SPACE}/changes`, { items: [{ id: "bbbbbbbbbbbbbbbb", base: 0, blob: blob(6) }] })).body.conflicts).toEqual([
      "bbbbbbbbbbbbbbbb",
    ]);

    const since2 = await call("GET", `/v1/spaces/${SPACE}/changes?since=2&limit=1`);
    expect(since2.body.items.map((i: any) => i.seq)).toEqual([3]);
    expect(since2.body.more).toBe(true);

    expect((await call("DELETE", `/v1/spaces/${SPACE}`)).body).toEqual({ deleted: true });
    expect((await call("GET", `/v1/spaces/${SPACE}/changes`)).status).toBe(404);
  });

  it("檢查格式與大小", async () => {
    await call("PUT", `/v1/spaces/${SPACE}`);
    expect((await call("PUT", "/v1/spaces/NOT-HEX")).status).toBe(400);
    expect((await call("POST", `/v1/spaces/${SPACE}/changes`, { items: [{ id: "short", base: 0, blob: "x" }] })).status).toBe(400);
    expect((await call("POST", `/v1/spaces/${SPACE}/changes`, { items: [{ id: "aaaaaaaaaaaaaaaa", base: 0, blob: "not base64!" }] })).status).toBe(400);
    expect((await call("POST", `/v1/spaces/${SPACE}/changes`, { items: [{ id: "aaaaaaaaaaaaaaaa", base: 0, blob: blob(1_400_001) }] })).status).toBe(400);
    expect((await call("POST", `/v1/spaces/${SPACE}/changes`, { items: Array.from({ length: 201 }, () => ({})) })).status).toBe(400);
  });
});

describe("配對", () => {
  it("新裝置建立配對碼；舊裝置送公開金鑰、再送加密的金鑰；新裝置取回後刪除", async () => {
    const created = await call("POST", "/v1/pair", { pub: "NEWPUB" }, null);
    expect(created.body.slot).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    const slot = created.body.slot as string;

    expect((await call("GET", `/v1/pair/${slot.toLowerCase()}`, undefined, null)).body).toEqual({ newPub: "NEWPUB", oldPub: null, box: null });
    // 公開金鑰到之前不能送金鑰
    expect((await call("POST", `/v1/pair/${slot}/box`, { box: "BOX" }, null)).status).toBe(409);
    expect((await call("POST", `/v1/pair/${slot}/hello`, { pub: "OLDPUB" }, null)).body).toEqual({ ok: true });
    // 只能一次：別人搶不走
    expect((await call("POST", `/v1/pair/${slot}/hello`, { pub: "EVIL" }, null)).status).toBe(409);
    expect((await call("POST", `/v1/pair/${slot}/box`, { box: "BOX" }, null)).body).toEqual({ ok: true });
    expect((await call("POST", `/v1/pair/${slot}/box`, { box: "BOX2" }, null)).status).toBe(409);
    expect((await call("GET", `/v1/pair/${slot}`, undefined, null)).body).toEqual({ newPub: "NEWPUB", oldPub: "OLDPUB", box: "BOX" });

    await call("DELETE", `/v1/pair/${slot}`, undefined, null);
    expect((await call("GET", `/v1/pair/${slot}`, undefined, null)).status).toBe(404);
  });

  it("十分鐘後失效；格式不對", async () => {
    const slot = (await call("POST", "/v1/pair", { pub: "NEWPUB" }, null)).body.slot as string;
    now = new Date(now.getTime() + 10 * 60_000 + 1);
    expect((await call("GET", `/v1/pair/${slot}`, undefined, null)).status).toBe(404);
    expect((await call("POST", `/v1/pair/${slot}/hello`, { pub: "OLDPUB" }, null)).status).toBe(409);
    expect((await call("GET", "/v1/pair/ILLEGAL1", undefined, null)).status).toBe(400);
    expect((await call("POST", "/v1/pair", { pub: "has space" }, null)).status).toBe(400);
  });
});

describe("跨來源", () => {
  it("只對允許的來源回 CORS 標頭；預檢", async () => {
    const pre = await handle(new Request(`http://sync.test/v1/spaces/${SPACE}/changes`, { method: "OPTIONS", headers: { origin: ORIGIN } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    const other = await call("POST", "/v1/pair", { pub: "X" }, null, "https://evil.example");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
