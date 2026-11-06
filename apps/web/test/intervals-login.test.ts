import { beforeEach, describe, expect, it } from "vitest";

import { disconnectIntervals, exchangeLoginCode, INTERVALS_SCOPES, readLoginCallback } from "../src/intervals-login";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

let replaced: string[];

beforeEach(() => {
  replaced = [];
  const g = globalThis as Record<string, unknown>;
  g.sessionStorage = new MemoryStorage();
  g.location = { origin: "https://staging.example.com", search: "", pathname: "/", hash: "" };
  g.history = { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) };
});

const loc = (search: string, hash = "") => ({ search, pathname: "/", hash });

describe("用 Intervals.icu 登入：回呼（規格 12.37）", () => {
  it("state 對得上：拿到 code，網址上的 code 與 state 馬上清掉（其他參數與 # 留著）", () => {
    sessionStorage.setItem("zone2mate.intervals-login.state", "s1");
    sessionStorage.setItem("zone2mate.intervals-login.from", "wizard");
    expect(readLoginCallback(loc("?code=c1&state=s1&x=1", "#help"))).toEqual({ kind: "code", code: "c1", from: "wizard" });
    expect(replaced).toEqual(["/?x=1#help"]);
    // 用過就清掉：同一個 state 不能再用
    expect(sessionStorage.getItem("zone2mate.intervals-login.state")).toBeNull();
  });

  it("state 對不上或沒存：不用那個 code；網址照樣清掉", () => {
    sessionStorage.setItem("zone2mate.intervals-login.state", "s1");
    expect(readLoginCallback(loc("?code=c1&state=other"))).toEqual({ kind: "invalid", from: "settings" });
    expect(readLoginCallback(loc("?code=c1&state=s1"))).toEqual({ kind: "invalid", from: "settings" });
    expect(replaced).toEqual(["/", "/"]);
  });

  it("在 Intervals.icu 按了拒絕：denied", () => {
    sessionStorage.setItem("zone2mate.intervals-login.state", "s1");
    expect(readLoginCallback(loc("?error=access_denied&state=s1"))).toEqual({ kind: "denied", from: "settings" });
  });

  it("不是回呼：不動網址", () => {
    expect(readLoginCallback(loc("?foo=1"))).toBeNull();
    expect(readLoginCallback(loc("?code=1"))).toBeNull();
    expect(replaced).toEqual([]);
  });

  it("權限只要讀", () => {
    expect(INTERVALS_SCOPES.split(",").every((s) => s.endsWith(":READ"))).toBe(true);
  });
});

describe("換 token 與中斷連結", () => {
  it("把 code 與回呼網址送到同步服務，拿回 token 與選手", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: "t1", athlete_id: "i42", athlete_name: "Runner", scope: "ACTIVITY:READ" }));
    }) as unknown as typeof fetch;
    expect(await exchangeLoginCode("https://sync.example.com/", "c1", fetchImpl)).toEqual({ accessToken: "t1", athleteId: "i42", athleteName: "Runner" });
    expect(calls[0]!.url).toBe("https://sync.example.com/v1/intervals/token");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ code: "c1", redirect_uri: "https://staging.example.com/" });
  });

  it("錯誤換成看得懂的話", async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(exchangeLoginCode("https://s", "c", reply(404, { error: "not_configured" }))).rejects.toThrow("還沒設定好");
    await expect(exchangeLoginCode("https://s", "c", reply(400, { error: "invalid_code" }))).rejects.toThrow("授權過期");
    const down = (async () => {
      throw new TypeError("x");
    }) as unknown as typeof fetch;
    await expect(exchangeLoginCode("https://s", "c", down)).rejects.toThrow("連不上");
  });

  it("中斷連結：帶 Bearer 呼叫 disconnect-app；失敗回 false（呼叫端照樣刪 token）", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await disconnectIntervals("t1", "https://intervals.icu/api/v1", ok)).toBe(true);
    expect(calls[0]).toMatchObject({ url: "https://intervals.icu/api/v1/disconnect-app", init: { method: "DELETE", headers: { authorization: "Bearer t1" } } });
    const fail = (async () => {
      throw new TypeError("cors");
    }) as unknown as typeof fetch;
    expect(await disconnectIntervals("t1", "https://intervals.icu/api/v1", fail)).toBe(false);
  });
});
