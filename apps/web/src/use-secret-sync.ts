/**
 * API key 與 Intervals.icu 的連線跟著加密的同步（規格 12.47）：每次同步完、或這台的 key 變了，看一次要存上去、直接套用，
 * 還是問使用者. 規則見 secret-sync.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { fromBase64url, type Db } from "@running-coach/core";

import type { DeviceSyncState } from "./device-sync";
import {
  adoptedStamp,
  adoptedText,
  beforeSecretRekey,
  keepLocalStamp,
  pageIsLocal,
  reconcileSecrets,
  setShare as saveShare,
  shareState,
  withSecret,
  type PendingSecret,
} from "./secret-sync";
import { llmProblem, markUserCleared, SECRET_NAMES, setSecretStamp, setShareAgreement, shareAgreement, type AppSettings, type SecretName } from "./settings";

export interface SecretSyncState {
  /** 這個同步空間要不要帶 API key 與 Intervals.icu 的連線；還不知道（資料庫還沒讀到）時是 null */
  share: boolean | null;
  /** 改要不要帶（每台都照它）；關掉時刪掉雲端那筆. 在這台打開也算這台同意帶上去 */
  setShare(on: boolean): Promise<void>;
  /** 另一台打開了「帶 key」、這台還沒決定要不要把自己的也帶上去（拿別台的照舊自動） */
  shareAsk: boolean;
  /** 這台決定了（帶上去／不帶） */
  answerShare(agree: boolean): Promise<void>;
  /** 這台同意把自己的 key 帶上去了 */
  shareAgreed: boolean;
  /** 使用者在畫面上清掉了 key 或中斷了連結（這台同意帶 key 時，別台也跟著清） */
  userCleared(name: SecretName): void;
  /** 另一台的和這台的不一樣、要使用者決定的 */
  pending: Partial<Record<SecretName, PendingSecret>>;
  /** 改用另一台的 */
  accept(name: SecretName): Promise<void>;
  /** 保留這台的（之後送出，別台照規則跟著換或問） */
  keep(name: SecretName): Promise<void>;
  /** 換同步金鑰之前呼叫；換好之後用新的同步金鑰呼叫回傳的函式（重新加密） */
  beforeRekey(): Promise<(newRoot: Uint8Array) => Promise<void>>;
  /** 用新的復原碼接手換金鑰之後：用換之前的同步金鑰解開、用現在的重新加密 */
  resealFrom(oldRoot: Uint8Array): Promise<void>;
}

export function useSecretSync(
  db: Db | null,
  settings: AppSettings,
  deviceSync: DeviceSyncState,
  /** 以目前最新的設定為底改設定並存起來 */
  applySettings: (change: (current: AppSettings) => AppSettings) => Promise<AppSettings>,
  touch: () => void,
  toast: (text: string) => void,
): SecretSyncState {
  const [share, setShareState] = useState<boolean | null>(null);
  /** sk:share 那一筆的時間（同意的是哪一次） */
  const [shareAt, setShareAt] = useState<string | null>(null);
  const [agreement, setAgreement] = useState<string | null>(shareAgreement);
  const [pending, setPending] = useState<Partial<Record<SecretName, PendingSecret>>>({});
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const running = useRef(false);
  const again = useRef(false);
  /** 這次打開頁面已經提示過要決定的（同一份不一直跳） */
  const told = useRef(new Set<string>());

  const key = settings.sync.key.trim();
  // 這次打開頁面後至少同步完一次才開始（剛加入的裝置先拿到別台的，不會用這台的蓋掉）
  const enabled = Boolean(db && key && deviceSync.engine && deviceSync.lastAt);

  const check = useCallback(async () => {
    if (!enabled || !db) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        const s = settingsRef.current;
        const root = fromBase64url(s.sync.key.trim());
        const state = await shareState(db);
        setShareState(state.on);
        setShareAt(state.at);
        const agreed = state.on && state.at !== null && shareAgreement() === state.at;
        const result = await reconcileSecrets(db, root, s, undefined, { allowLocalHttp: pageIsLocal(), uploadAllowed: agreed });
        const names = SECRET_NAMES.filter((n) => result.adopt[n]);
        let saved = s;
        if (names.length) saved = await applySettings((current) => names.reduce((acc, n) => withSecret(acc, n, result.adopt[n]!.value), current));
        // 存設定時記成「這台改的」；改成和雲端一致的狀態（套用之後才記：沒存成時下次再來）
        for (const n of names) setSecretStamp(n, adoptedStamp(result.adopt[n]!.remote));
        for (const n of SECRET_NAMES) if (result.stamps[n] && !result.adopt[n]) setSecretStamp(n, result.stamps[n]!);
        if (result.wrote) touch();
        const text = adoptedText(result.adopt);
        if (text) toast(result.adopt.llm && result.adopt.llm.kind !== "cleared" && llmProblem(saved) ? `${text}到設定的「AI 教練」確認資料流向，就能開始對話。` : text);
        setPending(result.pending);
        const fresh = SECRET_NAMES.filter((n) => result.pending[n] && !told.current.has(`${n}:${result.pending[n]!.remote.raw}`));
        for (const n of fresh) told.current.add(`${n}:${result.pending[n]!.remote.raw}`);
        if (fresh.length) toast("另一台的 key 和這台的不一樣，到設定決定要用哪一份。");
      } while (again.current);
    } catch {
      // 解不開、資料庫忙：下次同步完再試
    } finally {
      running.current = false;
    }
  }, [enabled, db, applySettings, touch, toast]);

  useEffect(() => {
    if (!db) return;
    void shareState(db)
      .then((state) => {
        setShareState(state.on);
        setShareAt(state.at);
      })
      .catch(() => undefined);
  }, [db, deviceSync.lastAt]);

  const agree = useCallback((value: string | null) => {
    setShareAgreement(value);
    setAgreement(value);
  }, []);

  useEffect(() => {
    if (enabled) void check();
    else setPending({});
  }, [
    enabled,
    check,
    deviceSync.lastAt,
    settings.llmMode,
    settings.provider,
    settings.apiKey,
    settings.baseURL,
    settings.models,
    settings.proxy.token,
    settings.intervals,
  ]);

  const setShare = useCallback(
    async (on: boolean) => {
      if (!db) return;
      const at = new Date();
      await saveShare(db, on, at);
      setShareState(on);
      setShareAt(at.toISOString());
      // 在這台打開：這台同意帶上去
      if (on) agree(at.toISOString());
      await check();
      touch();
    },
    [db, check, touch, agree],
  );

  const answerShare = useCallback(
    async (yes: boolean) => {
      if (!shareAt) return;
      agree(yes ? shareAt : `declined:${shareAt}`);
      if (yes) await check();
    },
    [shareAt, agree, check],
  );

  const userCleared = useCallback(
    (name: SecretName) => {
      // 這台同意帶 key 時才把「已清除」送出去；否則只清這台的
      if (share && shareAt && shareAgreement() === shareAt) markUserCleared(name);
    },
    [share, shareAt],
  );

  const shareAgreed = Boolean(share && shareAt && agreement === shareAt);
  const shareAsk = Boolean(enabled && share && shareAt && agreement !== shareAt && agreement !== `declined:${shareAt}`);
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (shareAsk && shareAt && asked.current !== shareAt) {
      asked.current = shareAt;
      toast("另一台打開了「帶 key 到其他裝置」：到設定決定這台的要不要也帶上去。");
    }
  }, [shareAsk, shareAt, toast]);

  const accept = useCallback(
    async (name: SecretName) => {
      const item = pendingRef.current[name];
      if (!item) return;
      await applySettings((current) => withSecret(current, name, item.value));
      setSecretStamp(name, adoptedStamp(item.remote));
      setPending((p) => ({ ...p, [name]: undefined }));
      toast(name === "llm" ? "已改用另一台的 API key。到設定的「AI 教練」確認資料流向，就能開始對話。" : "已改用另一台的 Intervals.icu 連線。");
    },
    [applySettings, toast],
  );

  const keep = useCallback(
    async (name: SecretName) => {
      const item = pendingRef.current[name];
      if (!item) return;
      setSecretStamp(name, keepLocalStamp(item.remote));
      setPending((p) => ({ ...p, [name]: undefined }));
      await check();
    },
    [check],
  );

  const beforeRekey = useCallback(async () => {
    if (!db || !key) return async () => undefined;
    const reseal = await beforeSecretRekey(db, fromBase64url(key));
    return async (newRoot: Uint8Array) => {
      try {
        if ((await reseal(newRoot)) > 0) touch();
      } catch {
        // 重新加密不了：留下的裝置下次同步時，解不開的會用它自己的重新存一筆
      }
    };
  }, [db, key, touch]);

  const resealFrom = useCallback(
    async (oldRoot: Uint8Array) => {
      const current = settingsRef.current.sync.key.trim();
      if (!db || !current) return;
      try {
        const reseal = await beforeSecretRekey(db, oldRoot);
        if ((await reseal(fromBase64url(current))) > 0) touch();
      } catch {
        // 同上
      }
    },
    [db, touch],
  );

  return { share, setShare, shareAsk, answerShare, shareAgreed, userCleared, pending, accept, keep, beforeRekey, resealFrom };
}
