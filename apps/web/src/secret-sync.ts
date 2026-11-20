/**
 * API key 與 Intervals.icu 的連線跟著加密的同步（規格 12.47「使用者要保管的東西」第一段）.
 *
 * - 同步的 sk:llm（自己的 API key：供應商、key、服務網址、模型）與 sk:intervals（Intervals.icu 的 API key 或登入的 token）：
 *   內容用同步金鑰再加密一次（core 的 device-sync/synced-secret.ts），這台的資料庫只存密文.
 * - sk:share：這個同步空間要不要帶 key（開始同步時勾選，預設勾；同步設定裡可以改，每台都照它）. 關掉時刪掉雲端的 sk:llm、sk:intervals.
 * - 兩台的不同：以最後改的那台為準（每台記下自己改的時間，settings.ts 的 secretStamps；這個功能之前就填好的當成最舊的）.
 *   另一台同步後跟著換，並提示.
 * - 免費試用的憑證不放進來（每台一個，trial-sync.ts）；這台用著免費試用時，不拿別台的 API key 蓋掉.
 * - 密碼鎖開著時：同步要先解鎖才會跑；帶進來的 key 照現在一樣用這台的密碼加密後才存（saveSettings）.
 * - 換了同步金鑰（移除某台）：換金鑰的那台用新的金鑰重新加密；被移除的那台照舊清掉 key（App.tsx 的 onRemoved）.
 * key 不印、不記，只在記憶體裡經過.
 */
import { openSyncedSecret, sealSyncedSecret, type Db, type Purpose } from "@running-coach/core";

import {
  PROVIDER_LABELS,
  SECRET_NAMES,
  sameSecret,
  secretOf,
  secretStamps,
  type AppSettings,
  type IntervalsSecret,
  type LlmSecret,
  type ProviderKind,
  type SecretName,
} from "./settings";

/** 這個功能之前就填好的（不知道什麼時候改的）：當成最舊的，兩台不同時以另一台的為準 */
export const UNKNOWN_STAMP = "1970-01-01T00:00:00.000Z";
const SHARE = "share";

export type SecretValue = LlmSecret | IntervalsSecret;

/** 這個同步空間要不要帶 key：沒有紀錄時是要（預設勾） */
export async function shareEnabled(db: Db): Promise<boolean> {
  const row = (await db.listSyncedSecrets()).find((r) => r.name === SHARE);
  return row?.box !== "off";
}

/** 改要不要帶 key（每台都照它）；關掉時刪掉 sk:llm、sk:intervals（下次同步別台也刪掉） */
export async function setShare(db: Db, on: boolean, now = new Date()): Promise<void> {
  await db.saveSyncedSecret({ name: SHARE, box: on ? "on" : "off", updated_at: now.toISOString() });
  if (!on) for (const name of SECRET_NAMES) await db.deleteSyncedSecret(name);
}

const isString = (v: unknown): v is string => typeof v === "string";
const PROVIDERS = Object.keys(PROVIDER_LABELS) as ProviderKind[];
const PURPOSES: Purpose[] = ["chat", "summary", "compress"];

/** 解開的內容檢查過形狀才用（別台的版本可能不同） */
function parse(name: SecretName, text: string | null): SecretValue | null {
  if (!text) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  if (name === "llm") {
    const models = (v.models ?? {}) as Record<string, unknown>;
    if (!PROVIDERS.includes(v.provider as ProviderKind) || !isString(v.apiKey) || !v.apiKey.trim() || !isString(v.baseURL)) return null;
    if (!PURPOSES.every((p) => isString(models[p]))) return null;
    return { provider: v.provider as ProviderKind, apiKey: v.apiKey, baseURL: v.baseURL, models: Object.fromEntries(PURPOSES.map((p) => [p, models[p]])) as Record<Purpose, string> };
  }
  if (!isString(v.apiKey) || !isString(v.athleteId) || !isString(v.accessToken) || (!v.apiKey.trim() && !v.accessToken)) return null;
  const account = v.account as { id?: unknown; name?: unknown } | null;
  return {
    apiKey: v.apiKey,
    athleteId: v.athleteId,
    accessToken: v.accessToken,
    account: account && typeof account === "object" ? { id: isString(account.id) ? account.id : null, name: isString(account.name) ? account.name : null } : null,
  };
}

/** 同步裡的內容（用現在的同步金鑰解得開的） */
export async function syncedSecrets(db: Db, root: Uint8Array): Promise<Partial<Record<SecretName, { value: SecretValue; at: string }>>> {
  const out: Partial<Record<SecretName, { value: SecretValue; at: string }>> = {};
  for (const r of await db.listSyncedSecrets()) {
    const name = r.name as SecretName;
    if (!SECRET_NAMES.includes(name)) continue;
    const value = parse(name, await openSyncedSecret(root, name, r.box));
    if (value) out[name] = { value, at: r.updated_at };
  }
  return out;
}

async function store(db: Db, root: Uint8Array, name: SecretName, value: SecretValue, at: string): Promise<void> {
  await db.saveSyncedSecret({ name, box: await sealSyncedSecret(root, name, JSON.stringify(value)), updated_at: at });
}

/** 這台用著免費試用（有憑證）：不拿別台的 API key 蓋掉 */
const trialInUse = (s: AppSettings) => s.llmMode === "proxy" && s.proxy.token.trim() !== "";

/** 把別台的內容套到這台的設定（呼叫的存起來） */
export function withSecret(s: AppSettings, name: SecretName, value: SecretValue): AppSettings {
  if (name === "llm") {
    const v = value as LlmSecret;
    return { ...s, llmMode: "byok", provider: v.provider, apiKey: v.apiKey, baseURL: v.baseURL, models: { ...v.models } };
  }
  const v = value as IntervalsSecret;
  return { ...s, intervals: { apiKey: v.apiKey, athleteId: v.athleteId, accessToken: v.accessToken, account: v.account } };
}

export interface Adopted {
  value: SecretValue;
  /** 別台改的時間：套用後記成這台的（之後兩台一樣，不再來回） */
  at: string;
  /** 這台原本有（換成另一台的）還是沒有（第一次帶進來） */
  replaced: boolean;
}

/**
 * 同步完、或這台的 key 變了之後看一次：
 * - 沒有要帶 key（sk:share 是 off）：雲端還有 sk:llm、sk:intervals 就刪掉；
 * - 雲端沒有（或用現在的同步金鑰解不開）、這台有：存一筆（改的時間用這台的）；
 * - 兩邊不同：這台改得比較晚就存這台的；否則回傳要套用的（呼叫的存進設定，記下那台改的時間）.
 */
export async function reconcileSecrets(
  db: Db,
  root: Uint8Array,
  s: AppSettings,
  stamps: Partial<Record<SecretName, string>> = secretStamps(),
): Promise<{ wrote: boolean; adopt: Partial<Record<SecretName, Adopted>> }> {
  const rows = await db.listSyncedSecrets();
  const adopt: Partial<Record<SecretName, Adopted>> = {};
  if (rows.find((r) => r.name === SHARE)?.box === "off") {
    const stale = rows.filter((r) => SECRET_NAMES.includes(r.name as SecretName));
    for (const r of stale) await db.deleteSyncedSecret(r.name);
    return { wrote: stale.length > 0, adopt };
  }
  const remote = await syncedSecrets(db, root);
  let wrote = false;
  for (const name of SECRET_NAMES) {
    const local = secretOf(s, name);
    const localAt = stamps[name] ?? UNKNOWN_STAMP;
    const there = remote[name];
    if (!there) {
      if (local) {
        await store(db, root, name, local, localAt);
        wrote = true;
      }
      continue;
    }
    if (local && sameSecret(local, there.value)) continue;
    if (local && localAt > there.at) {
      await store(db, root, name, local, localAt);
      wrote = true;
      continue;
    }
    if (name === "llm" && trialInUse(s)) continue;
    adopt[name] = { value: there.value, at: there.at, replaced: local !== null };
  }
  return { wrote, adopt };
}

/** 換同步金鑰之前呼叫，記下現在解得開的；換好之後用新的同步金鑰呼叫回傳的函式（重新加密，改的時間不變） */
export async function beforeSecretRekey(db: Db, root: Uint8Array): Promise<(newRoot: Uint8Array) => Promise<number>> {
  const before = await syncedSecrets(db, root).catch(() => ({}) as Awaited<ReturnType<typeof syncedSecrets>>);
  return async (newRoot) => {
    let n = 0;
    for (const name of SECRET_NAMES) {
      const item = before[name];
      if (!item) continue;
      await store(db, newRoot, name, item.value, item.at);
      n++;
    }
    return n;
  };
}

/** 被移除的那台：同步裡的密文也刪掉（解得開的金鑰已經清掉，留著也沒用） */
export async function forgetSyncedSecrets(db: Db): Promise<void> {
  for (const name of SECRET_NAMES) await db.deleteSyncedSecret(name);
}

/** 套用之後的提示 */
export function adoptedText(adopt: Partial<Record<SecretName, Adopted>>): string | null {
  const parts: string[] = [];
  if (adopt.llm) parts.push(adopt.llm.replaced ? "API key 已經更新成另一台設定的" : "已從另一台帶入 API key");
  if (adopt.intervals) parts.push(adopt.intervals.replaced ? "Intervals.icu 的連線已經更新成另一台設定的" : "已從另一台帶入 Intervals.icu 的連線");
  return parts.length ? `${parts.join("；")}。` : null;
}
