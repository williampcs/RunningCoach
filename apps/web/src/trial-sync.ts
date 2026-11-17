/**
 * 免費試用的帳號掛進加密的同步（規格 12.44 第 1 步）.
 *
 * - 這台用著免費試用、又開著同步：同步裡沒有這個帳號的紀錄（ta:<帳號>）就向代理要一把復原密鑰，用同步金鑰加密後存一筆.
 * - 新的裝置拿到這筆（配對、復原碼還原、平常的同步都算），而且這台還沒有試用的憑證：
 *   - 這台沒有設定 AI：自動取回（向代理換一個這台自己的憑證），改成免費試用；
 *   - 這台用自己的 API key、或被使用者在試用的裝置清單移除過：不自動，在設定的「AI 教練」按了才取回；
 *   - 紀錄的代理網址和這個建置的不同（例如 staging 的資料到正式版）：不取回.
 * - 同步換了金鑰（移除某台）：留下的這台換一把新的復原密鑰（舊的作廢），被移除的那台知道的舊的就不能用了.
 * - 刪除試用帳號：刪掉這筆.
 * 復原密鑰不印、不記，只在記憶體裡經過；這台的資料庫只存密文（device-sync/trial-account.ts）.
 */
import { normalizeProxyUrl, openTrialSecret, sealTrialSecret, type Db } from "@running-coach/core";

import type { AppSettings } from "./settings";
import { createRecoverySecret, fetchTrialUsage, recoverTrial, TRIAL_MODEL } from "./trial";

/** 這台被移除過（自己按「移除這台」）的試用帳號：不再自動取回 */
const DECLINED_KEY = "zone2mate.trial.declined";
/** 換同步金鑰的途中：換完要換新的復原密鑰（中途關掉頁面，下次打開再換） */
const ROTATE_KEY = "zone2mate.trial.rotate";
/** 同步裡這個帳號的紀錄用現在的同步金鑰解不開，從什麼時候開始（換金鑰的那台應該很快會換新；太久沒換，這台自己換） */
const STALE_KEY = "zone2mate.trial.stale";
/** 解不開多久之後，有憑證的這台自己換一把 */
export const STALE_MS = 10 * 60_000;

/** 同步裡的一個試用帳號（解得開的） */
export interface SyncedTrial {
  account: string;
  secret: string;
  updatedAt: string;
}

function readList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]): void {
  try {
    if (list.length) localStorage.setItem(key, JSON.stringify(list));
    else localStorage.removeItem(key);
  } catch {
    // 記不住就照預設（下次可能再自動取回）
  }
}

export const isDeclined = (account: string) => readList(DECLINED_KEY).includes(account);
export const markDeclined = (account: string) => writeList(DECLINED_KEY, [...new Set([...readList(DECLINED_KEY), account])]);
export const clearDeclined = (account: string) => writeList(DECLINED_KEY, readList(DECLINED_KEY).filter((a) => a !== account));

export const rotationPending = () => {
  try {
    return localStorage.getItem(ROTATE_KEY) !== null;
  } catch {
    return false;
  }
};
export const setRotationPending = (pending: boolean) => {
  try {
    if (pending) localStorage.setItem(ROTATE_KEY, "1");
    else localStorage.removeItem(ROTATE_KEY);
  } catch {
    // 記不住就算了：換金鑰的這一次已經在換
  }
};

function staleSince(account: string): number | null {
  try {
    const value = JSON.parse(localStorage.getItem(STALE_KEY) ?? "null") as { account?: string; since?: number } | null;
    return value?.account === account && typeof value.since === "number" ? value.since : null;
  } catch {
    return null;
  }
}

function setStale(account: string | null, since = Date.now()): void {
  try {
    if (account) localStorage.setItem(STALE_KEY, JSON.stringify({ account, since }));
    else localStorage.removeItem(STALE_KEY);
  } catch {
    // 記不住就下次重算
  }
}

const hasToken = (s: AppSettings) => s.proxy.token.trim() !== "";

/** 這台用著免費試用（有憑證） */
export const trialActive = (s: AppSettings) => s.llmMode === "proxy" && hasToken(s);

/** 同步裡、這個建置的代理的試用帳號（用現在的同步金鑰解得開的），新的在前 */
export async function syncedTrials(db: Db, root: Uint8Array, proxyUrl: string): Promise<SyncedTrial[]> {
  const url = normalizeProxyUrl(proxyUrl);
  if (!url) return [];
  const out: SyncedTrial[] = [];
  for (const r of await db.listTrialAccounts()) {
    if (normalizeProxyUrl(r.proxy_url) !== url) continue;
    const secret = await openTrialSecret(root, url, r.account, r.box);
    if (secret) out.push({ account: r.account, secret, updatedAt: r.updated_at });
  }
  return out;
}

/** 這台的憑證屬於哪個帳號：設定裡記得的，或問代理 */
export async function accountOf(s: AppSettings, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (s.proxy.account) return s.proxy.account;
  return (await fetchTrialUsage(s, fetchImpl)).account;
}

async function store(db: Db, root: Uint8Array, url: string, account: string, secret: string): Promise<void> {
  await db.saveTrialAccount({ account, proxy_url: url, box: await sealTrialSecret(root, url, account, secret) });
}

/**
 * 這台用著免費試用、開著同步：同步裡沒有這個帳號的紀錄就存一筆（換一把新的復原密鑰）.
 * 紀錄在但解不開（換金鑰之前的）：換金鑰的那台會換新；過了 STALE_MS 還解不開，這台自己換.
 * 回傳這台的帳號（設定裡沒有時給呼叫的存起來）與有沒有寫入
 */
export async function ensureTrialRecord(
  db: Db,
  root: Uint8Array,
  s: AppSettings,
  proxyUrl: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ account: string | null; wrote: boolean }> {
  const url = normalizeProxyUrl(proxyUrl);
  if (!url || !trialActive(s) || normalizeProxyUrl(s.proxy.url) !== url) return { account: s.proxy.account ?? null, wrote: false };
  const account = await accountOf(s, fetchImpl);
  if (!account) return { account: null, wrote: false };
  const existing = (await db.listTrialAccounts()).find((r) => r.account === account && normalizeProxyUrl(r.proxy_url) === url);
  if (existing) {
    if (await openTrialSecret(root, url, account, existing.box)) {
      setStale(null);
      return { account, wrote: false };
    }
    const since = staleSince(account);
    if (since === null) {
      setStale(account, now);
      return { account, wrote: false };
    }
    if (now - since < STALE_MS) return { account, wrote: false };
  }
  const created = await createRecoverySecret(url, { token: s.proxy.token }, fetchImpl);
  await store(db, root, url, created.account, created.secret);
  setStale(null);
  return { account, wrote: true };
}

/**
 * 換了同步金鑰之後（規格 12.27）：同步裡這個代理的每個試用帳號都換一把新的復原密鑰，用新的同步金鑰加密.
 * before 是換金鑰之前解得開的（沒有這台憑證的帳號用它向代理證明）. 回傳換了幾個；換不了的留著（換金鑰的那台以外，
 * 有那個帳號憑證的裝置過一陣子會自己換）
 */
export async function rotateTrialSecrets(
  db: Db,
  newRoot: Uint8Array,
  s: AppSettings,
  proxyUrl: string,
  before: SyncedTrial[],
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const url = normalizeProxyUrl(proxyUrl);
  if (!url) return 0;
  const own = trialActive(s) && normalizeProxyUrl(s.proxy.url) === url ? await accountOf(s, fetchImpl).catch(() => null) : null;
  let rotated = 0;
  for (const r of await db.listTrialAccounts()) {
    if (normalizeProxyUrl(r.proxy_url) !== url) continue;
    const previous = before.find((b) => b.account === r.account);
    const auth = r.account === own ? { token: s.proxy.token } : previous ? { account: r.account, secret: previous.secret } : null;
    if (!auth) continue;
    try {
      const created = await createRecoverySecret(url, auth, fetchImpl);
      await store(db, newRoot, url, created.account, created.secret);
      rotated++;
    } catch {
      // 帳號已經刪了或暫停、密鑰已經被換過：這一筆不動
    }
  }
  return rotated;
}

/** 這台的設定：沒有試用的憑證（新的裝置、或這台的被移除了） */
export const needsTrial = (s: AppSettings) => !hasToken(s);

/**
 * 可以自動取回嗎：這台沒有設定 AI（沒有試用的憑證、也沒有自己的 API key），而且這台沒有被移除過這個帳號.
 * 用自己的 API key 的不自動（要在設定裡按）
 */
export function autoRecoverable(s: AppSettings, trial: SyncedTrial): boolean {
  if (hasToken(s)) return false;
  if (s.llmMode === "byok" && s.apiKey.trim() !== "") return false;
  return !isDeclined(trial.account);
}

/** 取回：向代理換一個這台自己的憑證，回傳改成免費試用的設定（呼叫的存起來） */
export async function recoverFromSync(s: AppSettings, trial: SyncedTrial, proxyUrl: string, fetchImpl: typeof fetch = fetch): Promise<AppSettings> {
  const url = normalizeProxyUrl(proxyUrl);
  const issued = await recoverTrial(url, trial.account, trial.secret, fetchImpl);
  clearDeclined(trial.account);
  return {
    ...s,
    llmMode: "proxy",
    proxy: { url, token: issued.token, account: issued.account ?? trial.account },
    models: { chat: TRIAL_MODEL, summary: TRIAL_MODEL, compress: TRIAL_MODEL },
  };
}

/** 刪除試用帳號之後：同步裡的這筆一起刪（下次同步別台也刪掉） */
export async function forgetTrialRecord(db: Db, account: string | null | undefined): Promise<void> {
  if (account) await db.deleteTrialAccount(account);
}
