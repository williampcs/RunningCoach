/**
 * 免費試用的帳號掛進加密的同步（規格 12.44 第 1 步）：每次同步完、或這台的試用憑證變了，看一次要不要存紀錄或取回.
 * 規則見 trial-sync.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { fromBase64url, type Db } from "@running-coach/core";

import { errorText } from "./app-context";
import type { DeviceSyncState } from "./device-sync";
import { llmProblem, type AppSettings } from "./settings";
import { TRIAL_PROXY_URL, trialAvailable } from "./trial";
import {
  autoRecoverable,
  ensureTrialRecord,
  forgetTrialRecord,
  markDeclined,
  needsTrial,
  recoverFromSync,
  rotateTrialSecrets,
  rotationPending,
  setRotationPending,
  syncedTrials,
  trialActive,
  type SyncedTrial,
} from "./trial-sync";

export interface TrialSyncState {
  /** 同步裡、這台可以取回的試用帳號（最新的一個）；沒有時是 null */
  candidate: SyncedTrial | null;
  busy: boolean;
  error: string | null;
  /** 在這台也用免費試用（設定裡按的） */
  recover(): Promise<void>;
  /** 換同步金鑰之前呼叫，記下現在解得開的；換好之後用新的同步金鑰呼叫回傳的函式（換新的復原密鑰） */
  beforeRekey(): Promise<(newRoot: Uint8Array) => Promise<void>>;
  /** 刪除了試用帳號：同步裡的那筆一起刪 */
  forget(account: string | null | undefined): Promise<void>;
  /** 這台自己按了「移除這台」：之後不再自動取回這個帳號 */
  decline(account: string | null | undefined): void;
}

export function useTrialSync(
  db: Db | null,
  settings: AppSettings,
  deviceSync: DeviceSyncState,
  /** 以目前最新的設定為底改設定並存起來 */
  applySettings: (change: (current: AppSettings) => AppSettings) => Promise<AppSettings>,
  touch: () => void,
  toast: (text: string) => void,
): TrialSyncState {
  const [candidate, setCandidate] = useState<SyncedTrial | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // 這次打開頁面試過自動取回的（失敗了不一直重試）
  const tried = useRef(new Set<string>());
  const running = useRef(false);

  const key = settings.sync.key.trim();
  const enabled = Boolean(db && key && deviceSync.engine && trialAvailable());

  const check = useCallback(async () => {
    if (!enabled || !db || running.current) return;
    running.current = true;
    try {
      const root = fromBase64url(settingsRef.current.sync.key.trim());
      let s = settingsRef.current;
      let wrote = false;
      // 換同步金鑰的途中關掉了頁面：這台有憑證就換新的復原密鑰
      if (rotationPending() && trialActive(s)) {
        wrote = (await rotateTrialSecrets(db, root, s, TRIAL_PROXY_URL, [])) > 0 || wrote;
        setRotationPending(false);
      }
      if (trialActive(s)) {
        const ensured = await ensureTrialRecord(db, root, s, TRIAL_PROXY_URL);
        wrote = ensured.wrote || wrote;
        if (ensured.account && s.proxy.account !== ensured.account) {
          const account = ensured.account;
          s = await applySettings((current) => ({ ...current, proxy: { ...current.proxy, account } }));
        }
      }
      if (wrote) touch();
      const trials = await syncedTrials(db, root, TRIAL_PROXY_URL);
      const first = trials[0] ?? null;
      setCandidate(first);
      if (first && needsTrial(s) && autoRecoverable(s, first)) {
        const attempt = `${first.account}:${first.updatedAt}`;
        if (tried.current.has(attempt)) return;
        tried.current.add(attempt);
        try {
          const next = await applySettings((current) => current);
          if (!needsTrial(next) || !autoRecoverable(next, first)) return;
          const recovered = await recoverFromSync(next, first, TRIAL_PROXY_URL);
          const saved = await applySettings((current) => ({ ...current, llmMode: recovered.llmMode, proxy: recovered.proxy, models: recovered.models }));
          toast(llmProblem(saved) ? "已取回免費試用。到設定的「AI 教練」確認資料流向，就能開始對話。" : "已取回免費試用。");
        } catch {
          // 取回不了（帳號刪了、暫停、密鑰換了）：留在設定裡讓使用者自己按，看得到原因
        }
      }
    } catch {
      // 連不上代理等：下次同步完再試
    } finally {
      running.current = false;
    }
  }, [enabled, db, applySettings, touch, toast]);

  useEffect(() => {
    if (!enabled) {
      setCandidate(null);
      return;
    }
    void check();
  }, [enabled, check, deviceSync.lastAt, settings.proxy.token, settings.llmMode, settings.apiKey]);

  const recover = useCallback(async () => {
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      const recovered = await recoverFromSync(settingsRef.current, candidate, TRIAL_PROXY_URL);
      await applySettings((current) => ({ ...current, llmMode: recovered.llmMode, proxy: recovered.proxy, models: recovered.models }));
      toast("已在這台啟用免費試用。");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [candidate, applySettings, toast]);

  const beforeRekey = useCallback(async () => {
    if (!db || !trialAvailable() || !key) return async () => undefined;
    const before = await syncedTrials(db, fromBase64url(key), TRIAL_PROXY_URL).catch(() => [] as SyncedTrial[]);
    const any = before.length > 0 || trialActive(settingsRef.current);
    if (any) setRotationPending(true);
    return async (newRoot: Uint8Array) => {
      if (!any) return;
      try {
        await rotateTrialSecrets(db, newRoot, settingsRef.current, TRIAL_PROXY_URL, before);
        setRotationPending(false);
        touch();
      } catch {
        // 留著標記：下次打開時這台有憑證就再換
      }
    };
  }, [db, key, touch]);

  const forget = useCallback(
    async (account: string | null | undefined) => {
      if (!db) return;
      await forgetTrialRecord(db, account);
      touch();
    },
    [db, touch],
  );

  const decline = useCallback((account: string | null | undefined) => {
    if (account) markDeclined(account);
  }, []);

  return { candidate, busy, error, recover, beforeRekey, forget, decline };
}
