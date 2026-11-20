/**
 * API key 與 Intervals.icu 的連線跟著加密的同步（規格 12.47「使用者要保管的東西」第一段）.
 *
 * - 同步的 sk:llm（自己的 API key：供應商、key、服務網址、模型）與 sk:intervals（Intervals.icu 的 API key 或登入的 token）：
 *   內容用同步金鑰再加密一次（core 的 device-sync/synced-secret.ts），這台的資料庫只存密文. 清掉 key、中斷連結時存一筆「已清除」.
 * - sk:share：這個同步空間要不要帶 key（每台都照它）. 沒有這筆（這一版之前開的同步）或 off：不帶；關掉時刪掉 sk:llm、sk:intervals.
 * - 誰為準（每台記的時間與旗標見 settings.ts 的 SecretStamp）：
 *   - 這台改過、雲端在那之後沒變：送這台的（這台的修改不會被默默蓋掉）；
 *   - 雲端變了（另一台改過）：這台沒改過、而且送到同一個地方（同一個供應商與服務網址）時直接換並提示；
 *     兩台都改過、送到不同的地方、這台的 key 不知道什麼時候填的、或時間一樣時，問使用者（pending）.
 *   - 別台的時間最多算到這台的「現在＋幾分鐘」（時鐘不準或亂寫的不會一直贏），換金鑰時也照這個時間重新加密.
 * - 帶進來的「其他相容服務」的網址要是 https（只有在本機開發時，localhost 可以用 http）.
 * - 資料流向的同意不帶：綁在送到誰（settings.ts 的 consentKey），換了供應商或網址要在這台重新確認.
 * - 免費試用的憑證不放進來（每台一個，trial-sync.ts）；用著免費試用時不送、也不拿別台的 API key.
 * - 密碼鎖開著時：同步要先解鎖才會跑；帶進來的 key 照現在一樣用這台的密碼加密後才存（saveSettings）.
 * - 換了同步金鑰（移除某台、用新的復原碼接手）：用新的金鑰重新加密；被移除的那台照舊清掉 key（App.tsx 的 onRemoved）.
 * key 不印、不記，只在記憶體裡經過.
 */
import { openSyncedSecret, sealSyncedSecret, type Db, type Purpose } from "@running-coach/core";

import {
  PROVIDER_LABELS,
  PROVIDER_RECIPIENT,
  SECRET_NAMES,
  sameSecret,
  secretOf,
  secretSkipped,
  secretStamps,
  type AppSettings,
  type IntervalsSecret,
  type LlmSecret,
  type ProviderKind,
  type SecretName,
  type SecretStamp,
} from "./settings";

/** 不知道什麼時候改的（這個功能之前就填好的） */
export const UNKNOWN_STAMP = "1970-01-01T00:00:00.000Z";
/** 別台的時間最多算到這台的現在再加這麼多 */
export const MAX_SKEW_MS = 5 * 60_000;
const SHARE = "share";

/** 「已清除」：那一台清掉了 key 或中斷了連結 */
export interface ClearedSecret {
  cleared: true;
}
export type SecretValue = LlmSecret | IntervalsSecret;
type Content = SecretValue | ClearedSecret;
const isCleared = (v: Content | null | undefined): v is ClearedSecret => Boolean(v && "cleared" in v);

/** 這個同步空間要不要帶 key：明確開了才帶（沒有紀錄的舊空間不帶） */
export async function shareEnabled(db: Db): Promise<boolean> {
  return (await shareState(db)).on;
}

/**
 * 「提供分享」的狀態與那一筆的時間. 任何一台都能打開，所以每台第一次把自己的 key 送上去之前，
 * 要在那台同意一次（settings.ts 的 shareAgreement 記同意的是哪一次）；拿別台的照舊自動
 */
export async function shareState(db: Db): Promise<{ on: boolean; at: string | null }> {
  const row = (await db.listSyncedSecrets()).find((r) => r.name === SHARE);
  return { on: row?.box === "on", at: row?.updated_at ?? null };
}

/** 改要不要帶 key（每台都照它）；關掉時刪掉 sk:llm、sk:intervals（下次同步別台也刪掉） */
export async function setShare(db: Db, on: boolean, now = new Date()): Promise<void> {
  await db.saveSyncedSecret({ name: SHARE, box: on ? "on" : "off", updated_at: now.toISOString() });
  if (!on) for (const name of SECRET_NAMES) await db.deleteSyncedSecret(name);
}

/** 時間：讀不懂的當成不知道；比這台的現在加幾分鐘還晚的算成那個時間 */
export function clampStamp(at: string, now: Date): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return UNKNOWN_STAMP;
  const max = now.getTime() + MAX_SKEW_MS;
  return t > max ? new Date(max).toISOString() : new Date(t).toISOString();
}

/** 帶進來的服務網址可以用嗎：https；只有在本機開發（allowLocalHttp）時 localhost 可以用 http */
export function acceptableBaseUrl(url: string, allowLocalHttp: boolean): boolean {
  if (!url.trim()) return true;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return allowLocalHttp && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/** 這個頁面是在本機開的（開發、E2E）：帶進來的服務網址可以是 localhost 的 http */
export const pageIsLocal = () => typeof location !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

const isString = (v: unknown): v is string => typeof v === "string";
const PROVIDERS = Object.keys(PROVIDER_LABELS) as ProviderKind[];
const PURPOSES: Purpose[] = ["chat", "summary", "compress"];

/** 解開的內容檢查過形狀才用（別台的版本可能不同） */
function parse(name: SecretName, text: string | null, allowLocalHttp: boolean): Content | null {
  if (!text) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  if (v.cleared === true) return { cleared: true };
  if (name === "llm") {
    const models = (v.models ?? {}) as Record<string, unknown>;
    if (!PROVIDERS.includes(v.provider as ProviderKind) || !isString(v.apiKey) || !v.apiKey.trim() || !isString(v.baseURL)) return null;
    if (!PURPOSES.every((p) => isString(models[p]))) return null;
    // 只有「其他相容服務」用得到網址；其他的不帶網址
    const baseURL = v.provider === "openai-compatible" ? v.baseURL : "";
    if (!acceptableBaseUrl(baseURL, allowLocalHttp)) return null;
    return { provider: v.provider as ProviderKind, apiKey: v.apiKey, baseURL, models: Object.fromEntries(PURPOSES.map((p) => [p, models[p]])) as Record<Purpose, string> };
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

export interface Remote {
  value: Content;
  /** 雲端那份的時間（原樣，用來看雲端有沒有變） */
  raw: string;
  /** 比較用的時間（最多到這台的現在＋幾分鐘） */
  at: string;
}

/** 同步裡的內容（用現在的同步金鑰解得開、形狀對的） */
export async function syncedSecrets(db: Db, root: Uint8Array, now = new Date(), allowLocalHttp = false): Promise<Partial<Record<SecretName, Remote>>> {
  const out: Partial<Record<SecretName, Remote>> = {};
  for (const r of await db.listSyncedSecrets()) {
    const name = r.name as SecretName;
    if (!SECRET_NAMES.includes(name)) continue;
    const value = parse(name, await openSyncedSecret(root, name, r.box), allowLocalHttp);
    if (value) out[name] = { value, raw: r.updated_at, at: clampStamp(r.updated_at, now) };
  }
  return out;
}

async function store(db: Db, root: Uint8Array, name: SecretName, value: Content, at: string): Promise<void> {
  await db.saveSyncedSecret({ name, box: await sealSyncedSecret(root, name, JSON.stringify(value)), updated_at: at });
}

/** 送到哪裡（給提示與比較）：供應商；其他相容服務是它的網址 */
export function recipientOf(v: LlmSecret): string {
  return v.provider === "openai-compatible" ? v.baseURL.trim().replace(/\/+$/, "") || PROVIDER_RECIPIENT[v.provider] : PROVIDER_RECIPIENT[v.provider];
}

/** 把別台的內容套到這台的設定（呼叫的存起來）；「已清除」就清掉這台的 */
export function withSecret(s: AppSettings, name: SecretName, value: Content): AppSettings {
  if (name === "llm") {
    if (isCleared(value)) return { ...s, apiKey: "" };
    const v = value as LlmSecret;
    return { ...s, llmMode: "byok", provider: v.provider, apiKey: v.apiKey, baseURL: v.baseURL, models: { ...v.models } };
  }
  if (isCleared(value)) return { ...s, intervals: { apiKey: "", athleteId: s.intervals.athleteId, accessToken: "", account: null } };
  const v = value as IntervalsSecret;
  return { ...s, intervals: { apiKey: v.apiKey, athleteId: v.athleteId, accessToken: v.accessToken, account: v.account } };
}

export type AdoptKind = "added" | "replaced" | "cleared";

export interface Adoption {
  value: Content;
  remote: Remote;
  kind: AdoptKind;
}

/** 要問使用者的：為什麼 */
export type PendingReason = "recipient" | "both-changed" | "unknown";

export interface PendingSecret {
  /** 另一台的；「已清除」是另一台清掉了 */
  value: Content;
  remote: Remote;
  reason: PendingReason;
  /** llm：另一台的送到哪裡（畫面上顯示） */
  recipient?: string;
}

export interface ReconcileResult {
  wrote: boolean;
  /** 直接套用的 */
  adopt: Partial<Record<SecretName, Adoption>>;
  /** 要問使用者的 */
  pending: Partial<Record<SecretName, PendingSecret>>;
  /** 要記下的狀態（呼叫的在套用之後寫進 localStorage） */
  stamps: Partial<Record<SecretName, SecretStamp>>;
}

/**
 * 同步完、或這台的 key 變了之後看一次（規則見檔案開頭）. stamps 是這台每一樣的狀態（settings.ts 的 secretStamps）
 */
export async function reconcileSecrets(
  db: Db,
  root: Uint8Array,
  s: AppSettings,
  stamps: Partial<Record<SecretName, SecretStamp>> = secretStamps(),
  opts: { now?: Date; allowLocalHttp?: boolean; uploadAllowed?: boolean } = {},
): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  // 這台同意帶上去了嗎（沒同意：只拿別台的，這台的不送）
  const upload = opts.uploadAllowed ?? true;
  const nowIso = now.toISOString();
  const rows = await db.listSyncedSecrets();
  const result: ReconcileResult = { wrote: false, adopt: {}, pending: {}, stamps: {} };
  if (rows.find((r) => r.name === SHARE)?.box !== "on") {
    const stale = rows.filter((r) => SECRET_NAMES.includes(r.name as SecretName));
    for (const r of stale) await db.deleteSyncedSecret(r.name);
    result.wrote = stale.length > 0;
    return result;
  }
  const remote = await syncedSecrets(db, root, now, opts.allowLocalHttp ?? false);
  for (const name of SECRET_NAMES) {
    if (secretSkipped(s, name)) continue;
    const local = secretOf(s, name);
    const st = stamps[name];
    const there = remote[name];
    const push = async (value: Content, at: string) => {
      if (!upload) return;
      const when = clampStamp(at, now);
      await store(db, root, name, value, when);
      result.wrote = true;
      result.stamps[name] = { at: when, seen: when, edited: false };
    };

    if (!there) {
      // 雲端沒有（或用現在的同步金鑰解不開）：這台有就送
      if (local) await push(local, st?.at ?? nowIso);
      continue;
    }
    const remoteEmpty = isCleared(there.value);
    // 一樣：記下已經一致
    if ((local === null && remoteEmpty) || (local !== null && !remoteEmpty && sameSecret(local, there.value))) {
      if (!st || st.seen !== there.raw || st.edited) result.stamps[name] = { at: there.at, seen: there.raw, edited: false };
      continue;
    }
    const remoteChanged = st?.seen !== there.raw;
    // 這台改過，而且雲端在那之後沒變、或這台改得比較晚：送這台的（清掉的送「已清除」）
    if (st?.edited && (!remoteChanged || st.at > there.at)) {
      await push(local ?? { cleared: true }, st.at);
      continue;
    }
    // 這台改過（還沒送出）、另一台也改過（包括清掉）：問使用者，兩邊都不默默蓋掉
    if (st?.edited) {
      result.pending[name] = { value: there.value, remote: there, reason: "both-changed", ...(name === "llm" && !remoteEmpty ? { recipient: recipientOf(there.value as LlmSecret) } : {}) };
      continue;
    }
    if (!remoteChanged) {
      // 雲端沒變、這台也沒改過卻不一樣（例如忘記密碼清掉了 key）：這台沒有就拿回來；有的話問使用者，不默默蓋掉任何一邊
      if (local === null) {
        if (!remoteEmpty) result.adopt[name] = { value: there.value, remote: there, kind: "added" };
      } else if (!remoteEmpty) {
        const value = there.value as SecretValue;
        result.pending[name] = { value, remote: there, reason: "unknown", ...(name === "llm" ? { recipient: recipientOf(value as LlmSecret) } : {}) };
      }
      continue;
    }
    // 雲端變了（另一台改過）
    if (remoteEmpty) {
      // 另一台清掉了：這台也清（這台改過的在上面已經問使用者）
      result.adopt[name] = { value: there.value, remote: there, kind: "cleared" };
      continue;
    }
    const value = there.value as SecretValue;
    if (local === null) {
      result.adopt[name] = { value, remote: there, kind: "added" };
      continue;
    }
    const recipientChanged = name === "llm" && recipientOf(local as LlmSecret) !== recipientOf(value as LlmSecret);
    const reason: PendingReason | null = st?.edited
      ? "both-changed"
      : !st || st.at === UNKNOWN_STAMP || st.at === there.at
        ? "unknown"
        : recipientChanged
          ? "recipient"
          : null;
    if (reason) result.pending[name] = { value, remote: there, reason, ...(name === "llm" ? { recipient: recipientOf(value as LlmSecret) } : {}) };
    else result.adopt[name] = { value, remote: there, kind: "replaced" };
  }
  return result;
}

/** 套用之後要記的狀態 */
export const adoptedStamp = (remote: Remote): SecretStamp => ({ at: remote.at, seen: remote.raw, edited: false });

/** 使用者選「保留這台的」：這台這份當成最新的改動（比雲端那份晚），下次看的時候送出 */
export function keepLocalStamp(remote: Remote, now = new Date()): SecretStamp {
  const at = new Date(Math.max(now.getTime(), Date.parse(remote.at) + 1)).toISOString();
  return { at, seen: remote.raw, edited: true };
}

/** 換同步金鑰之前呼叫（root 是舊的），記下現在解得開的；之後用新的同步金鑰呼叫回傳的函式（重新加密；時間照比較用的，不原樣帶遠未來的） */
export async function beforeSecretRekey(db: Db, root: Uint8Array, now = new Date()): Promise<(newRoot: Uint8Array) => Promise<number>> {
  const before = await syncedSecrets(db, root, now, true).catch(() => ({}) as Partial<Record<SecretName, Remote>>);
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

/** 直接套用之後的提示 */
export function adoptedText(adopt: Partial<Record<SecretName, Adoption>>): string | null {
  const label: Record<SecretName, string> = { llm: "API key", intervals: "Intervals.icu 的連線" };
  const parts = SECRET_NAMES.filter((n) => adopt[n]).map((n) => {
    const kind = adopt[n]!.kind;
    return kind === "added" ? `已從另一台帶入 ${label[n]}` : kind === "replaced" ? `${label[n]} 已經更新成另一台設定的` : `另一台清掉了 ${label[n]}，這台也清掉了`;
  });
  return parts.length ? `${parts.join("；")}。` : null;
}
