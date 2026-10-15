import { describe, expect, it } from "vitest";

import { createLock, openLock, sealSecrets, WrongPasswordError, type Secrets } from "../src/key-lock";

// 測試用較少的迭代次數；正式值見 PBKDF2_ITERATIONS
const ITERATIONS = 1000;
const SECRETS: Secrets = { apiKey: "sk-test-123", proxyToken: "proxy-token", intervalsApiKey: "intervals-key" };

describe("key-lock", () => {
  it("decrypts with the right password", async () => {
    const { sealed } = await createLock("correct horse", SECRETS, ITERATIONS);
    const { secrets } = await openLock(sealed, "correct horse");
    expect(secrets).toEqual(SECRETS);
  });

  it("does not store the secrets in readable form", async () => {
    const { sealed } = await createLock("correct horse", SECRETS, ITERATIONS);
    const stored = JSON.stringify(sealed);
    for (const value of Object.values(SECRETS)) expect(stored).not.toContain(value);
    expect(sealed.iterations).toBe(ITERATIONS);
  });

  it("rejects a wrong password", async () => {
    const { sealed } = await createLock("correct horse", SECRETS, ITERATIONS);
    await expect(openLock(sealed, "wrong horse")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("rejects tampered data", async () => {
    const { sealed } = await createLock("correct horse", SECRETS, ITERATIONS);
    const bytes = Uint8Array.from(atob(sealed.data), (c) => c.charCodeAt(0));
    bytes[0] ^= 1;
    const tampered = { ...sealed, data: btoa(String.fromCharCode(...bytes)) };
    await expect(openLock(tampered, "correct horse")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("re-seals with the unlocked session and a fresh IV", async () => {
    const { sealed, session } = await createLock("correct horse", SECRETS, ITERATIONS);
    const changed = { ...SECRETS, apiKey: "sk-new" };
    const resealed = await sealSecrets(session, changed);
    expect(resealed.iv).not.toBe(sealed.iv);
    expect(resealed.salt).toBe(sealed.salt);
    expect((await openLock(resealed, "correct horse")).secrets).toEqual(changed);
  });

  it("keeps the derived key non-extractable", async () => {
    const { session } = await createLock("correct horse", SECRETS, ITERATIONS);
    expect(session.key.extractable).toBe(false);
  });
});
