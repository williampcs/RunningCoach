/**
 * 測試與模擬服務用：照 Cloudflare Turnstile 官方的測試金鑰回答 siteverify，不連網路.
 * （正式的同步服務不用這個檔案）
 *
 * - secret 1x0000000000000000000000000000000AA：一定通過
 * - secret 2x0000000000000000000000000000000AA：一定失敗
 * - secret 3x0000000000000000000000000000000AA：token 已經用過
 * - 網頁版的測試 site key 1x00000000000000000000AA 給的 token 是 XXXX.DUMMY.TOKEN.XXXX
 */
export const TEST_SECRET_PASS = "1x0000000000000000000000000000000AA";
export const TEST_SECRET_FAIL = "2x0000000000000000000000000000000AA";
export const TEST_SECRET_SPENT = "3x0000000000000000000000000000000AA";
export const TEST_SITE_KEY_PASS = "1x00000000000000000000AA";
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** 假的 siteverify：calls 記下每次收到的欄位（測試用來確認沒有送 IP） */
export function fakeTurnstileFetch(calls: Record<string, string>[] = []): typeof fetch {
  return async (_input, init) => {
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    calls.push(form);
    const reply = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (!form.response) return reply({ success: false, "error-codes": ["missing-input-response"] });
    if (form.secret === TEST_SECRET_PASS) return reply({ success: true, "error-codes": [], hostname: "example.com", action: "" });
    if (form.secret === TEST_SECRET_FAIL) return reply({ success: false, "error-codes": ["invalid-input-response"] });
    if (form.secret === TEST_SECRET_SPENT) return reply({ success: false, "error-codes": ["timeout-or-duplicate"] });
    return reply({ success: false, "error-codes": ["invalid-input-secret"] });
  };
}
