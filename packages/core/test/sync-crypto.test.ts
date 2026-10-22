import { describe, expect, it } from "vitest";

import { deriveKeys, newPairKey, newRootKey, openRoot, pairSecrets, parseRecoveryCode, recoveryCode, sealRoot } from "../src";
import { open, paddedSize, recordId, seal } from "../src/device-sync/crypto";

describe("同步的加密", () => {
  it("同一把金鑰在各裝置導出一樣的 id 與憑證；不同的金鑰不一樣", async () => {
    const root = newRootKey();
    const [a, b, other] = await Promise.all([deriveKeys(root), deriveKeys(Uint8Array.from(root)), deriveKeys(newRootKey())]);
    expect(a.space).toMatch(/^[0-9a-f]{32}$/);
    expect(a.space).toBe(b.space);
    expect(a.token).toBe(b.token);
    expect(a.space).not.toBe(other.space);
    expect(await recordId(a, "p:pref_intensity")).toBe(await recordId(b, "p:pref_intensity"));
    expect(await recordId(a, "p:pref_intensity")).not.toContain("pref");
  });

  it("加密、解密；補齊大小；換了 id 或金鑰就解不開", async () => {
    const keys = await deriveKeys(newRootKey());
    const id = await recordId(keys, "c:abc");
    const value = { k: "c:abc", m: "2026-10-22T00:00:00Z", d: { content: "早安" } };
    const blob = await seal(keys, id, value);
    expect(await open(keys, id, blob)).toEqual(value);
    // 長度只透露級距：短的兩筆一樣長
    const short = await seal(keys, id, { a: 1 });
    expect(blob.length).toBe(short.length);
    expect(paddedSize(10)).toBe(256);
    expect(paddedSize(300)).toBe(512);
    expect(paddedSize(70_000)).toBe(131_072);
    await expect(open(keys, await recordId(keys, "c:other"), blob)).rejects.toThrow();
    await expect(open(await deriveKeys(newRootKey()), id, blob)).rejects.toThrow();
  });

  it("復原碼：可以讀回；容許小寫、空白與看錯的字；打錯會被發現", async () => {
    const root = newRootKey();
    const code = await recoveryCode(root);
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]$/);
    expect(await parseRecoveryCode(code)).toEqual(root);
    expect(await parseRecoveryCode(` ${code.toLowerCase().replace(/-/g, " ")} `)).toEqual(root);
    expect(await parseRecoveryCode(code.replace(/0/g, "O").replace(/1/g, "I"))).toEqual(root);
    const typo = code.slice(0, 5) + (code[5] === "A" ? "B" : "A") + code.slice(6);
    expect(await parseRecoveryCode(typo)).toBeNull();
    expect(await parseRecoveryCode("not a code")).toBeNull();
  });
});

describe("配對", () => {
  it("兩台算出同樣的數字，能傳遞同步金鑰；公開金鑰被換掉時數字不同", async () => {
    const [fresh, old, evil] = await Promise.all([newPairKey(), newPairKey(), newPairKey()]);
    const onNew = await pairSecrets(fresh, old.pub, fresh.pub, old.pub);
    const onOld = await pairSecrets(old, fresh.pub, fresh.pub, old.pub);
    expect(onNew.confirm).toMatch(/^\d{3} \d{3}$/);
    expect(onNew.confirm).toBe(onOld.confirm);

    const root = newRootKey();
    expect(await openRoot(onNew, await sealRoot(onOld, root))).toEqual(root);

    // 伺服器把舊裝置的公開金鑰換成自己的
    const tampered = await pairSecrets(fresh, evil.pub, fresh.pub, evil.pub);
    expect(tampered.confirm).not.toBe(onOld.confirm);
    await expect(openRoot(tampered, await sealRoot(onOld, root))).rejects.toThrow();
  });
});
