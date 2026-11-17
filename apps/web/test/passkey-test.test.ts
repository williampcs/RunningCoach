import { describe, expect, it } from "vitest";

import {
  buildReport,
  describePlatform,
  errorInfo,
  fingerprint,
  fromBase64Url,
  getLine,
  getOptions,
  pickCapabilities,
  PRF_TEST_SALT,
  redact,
  toBase64Url,
  createOptions,
  type Environment,
} from "../src/passkey-test";

const ENV: Environment = {
  platform: "iOS 18.5 · Safari 18.5",
  webauthn: true,
  platformAuthenticator: true,
  capabilities: { "extension:prf": true, hybridTransport: false },
};

describe("describePlatform", () => {
  it("reads iPhone Safari", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
    expect(describePlatform(ua).label).toBe("iOS 18.5 · Safari 18.5");
  });

  it("marks other browsers on iPhone as WebKit", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.119 Mobile/15E148 Safari/604.1";
    expect(describePlatform(ua).label).toBe("iOS 18.4.1 · Chrome 138（WebKit）");
  });

  it("reads Android Chrome and Samsung Internet", () => {
    const chrome = "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
    expect(describePlatform(chrome).label).toBe("Android 15 · Chrome 141");
    const samsung = "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36";
    expect(describePlatform(samsung).label).toBe("Android 14 · Samsung Internet 27.0");
  });

  it("tells Windows 11 from the platform version", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0";
    expect(describePlatform(ua).label).toBe("Windows · Edge 147");
    expect(describePlatform(ua, { platformVersion: "19.0.0" }).label).toBe("Windows 11（19.0.0） · Edge 147");
    expect(describePlatform(ua, { platformVersion: "10.0.0" }).label).toBe("Windows 10（10.0.0） · Edge 147");
  });

  it("reads Mac Safari and iPad asking for the desktop site", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
    expect(describePlatform(ua).label).toBe("macOS · Safari 18.4");
    expect(describePlatform(ua, { maxTouchPoints: 5 }).label).toBe("iPadOS（電腦版網頁） · Safari 18.4");
  });
});

describe("fingerprint", () => {
  it("is the first 8 hex characters of SHA-256 and stable", async () => {
    // SHA-256("abc") = ba7816bf…
    const abc = new TextEncoder().encode("abc");
    expect(await fingerprint(abc)).toBe("ba7816bf");
    expect(await fingerprint(abc)).toBe(await fingerprint(new TextEncoder().encode("abc")));
    expect(await fingerprint(new TextEncoder().encode("abd"))).not.toBe("ba7816bf");
  });
});

describe("base64url", () => {
  it("round-trips without padding", () => {
    const bytes = Uint8Array.from([251, 255, 0, 1, 2, 62, 63]);
    const text = toBase64Url(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(Array.from(fromBase64Url(text))).toEqual(Array.from(bytes));
  });
});

describe("options", () => {
  it("asks for a resident key with user verification and PRF", () => {
    const pk = createOptions().publicKey!;
    expect(pk.rp.id).toBeUndefined();
    expect(pk.user.name).toBe("Zone2Mate 測試");
    expect(pk.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(pk.extensions?.prf).toEqual({});
  });

  it("evaluates the fixed salt, naming the stored passkey only when there is one", () => {
    const named = getOptions(toBase64Url(Uint8Array.from([1, 2, 3]))).publicKey!;
    expect(named.allowCredentials).toHaveLength(1);
    expect(named.extensions?.prf?.eval?.first).toBe(PRF_TEST_SALT);
    expect(getOptions(null).publicKey!.allowCredentials).toEqual([]);
  });
});

describe("errorInfo", () => {
  it("keeps the name and message and hides long id-like strings", () => {
    const e = new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
    expect(errorInfo(e)).toEqual({ name: "NotAllowedError", message: "The operation either timed out or was not allowed." });
    expect(redact("credential AbCdEfGhIjKlMnOpQrStUvWxYz0123 not found")).toBe("credential … not found");
  });
});

describe("pickCapabilities", () => {
  it("keeps only the passkey and PRF ones", () => {
    expect(pickCapabilities({ "extension:prf": true, "extension:credProps": true, hybridTransport: true, conditionalGet: true })).toEqual({
      "extension:prf": true,
      hybridTransport: true,
    });
  });
});

describe("getLine", () => {
  const ok = (fp: string | null) => ({ ok: true as const, fingerprint: fp, prfReported: true, attachment: "platform", sameAsCreated: true, pickedByUser: false });

  it("says which earlier try matches", () => {
    expect(getLine(ok("aaaa1111"), [])).toContain("指紋 aaaa1111");
    expect(getLine(ok("aaaa1111"), [null, "aaaa1111"])).toContain("（和第 2 次一樣）");
    expect(getLine(ok("bbbb2222"), ["aaaa1111"])).toContain("（和之前不一樣）");
  });

  it("says which passkey was used", () => {
    expect(getLine(ok("aaaa1111"), [])).toContain("這頁建立的那把");
    expect(getLine({ ...ok("aaaa1111"), pickedByUser: true, sameAsCreated: false }, [])).toContain("自己選了另一把");
    expect(getLine({ ...ok("aaaa1111"), pickedByUser: true, sameAsCreated: null }, [])).toContain("自己選的");
  });

  it("says when PRF is missing", () => {
    expect(getLine(ok(null), [])).toContain("拿不到 PRF");
    expect(getLine({ ...ok(null), prfReported: false }, [])).toContain("瀏覽器沒有回報");
  });
});

describe("buildReport", () => {
  const credentialId = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i * 7));
  const prfValue = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));

  it("lists the device, the create and each try, without the credential id or the PRF value", () => {
    const text = buildReport({
      version: "v0.8.0 Staging",
      at: new Date(2026, 10, 14, 9, 5),
      env: ENV,
      create: { ok: true, prfEnabled: true, prfResultOnCreate: false, attachment: "platform", credentialId },
      gets: [
        { ok: true, fingerprint: "ab12cd34", prfReported: true, attachment: "platform", sameAsCreated: true, pickedByUser: false },
        { ok: true, fingerprint: "ab12cd34", prfReported: true, attachment: "platform", sameAsCreated: true, pickedByUser: false },
        { ok: false, error: { name: "NotAllowedError", message: "cancelled" } },
      ],
    });
    expect(text).toContain("Zone2Mate passkey 測試（v0.8.0 Staging · 2026-11-14 09:05）");
    expect(text).toContain("裝置：iOS 18.5 · Safari 18.5");
    expect(text).toContain("瀏覽器回報的能力：extension:prf 有、hybridTransport 沒有");
    expect(text).toContain("建立：成功 · PRF 啟用 · 這台的驗證器");
    expect(text).toContain("第 2 次：成功 · 拿到 PRF · 指紋 ab12cd34（和第 1 次一樣）");
    expect(text).toContain("第 3 次：失敗 · NotAllowedError：cancelled");
    expect(text).not.toContain(credentialId);
    expect(text).not.toContain(prfValue);
    expect(text).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });

  it("says what was not tried", () => {
    const text = buildReport({ version: "v0.8.0", at: new Date(), env: { ...ENV, capabilities: null }, create: null, gets: [] });
    expect(text).toContain("瀏覽器沒有 getClientCapabilities");
    expect(text).toContain("建立：沒有試");
    expect(text).toContain("算一次：沒有試");
  });
});
