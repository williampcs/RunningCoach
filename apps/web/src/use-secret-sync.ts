/**
 * API key 與 Intervals.icu 的連線跟著加密的同步（規格 12.47）：每次同步完、或這台的 key 變了，看一次要存上去還是套用別台的.
 * 規則見 secret-sync.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { fromBase64url, type Db } from "@running-coach/core";

import type { DeviceSyncState } from "./device-sync";
import { adoptedText, beforeSecretRekey, reconcileSecrets, setShare as saveShare, shareEnabled, withSecret } from "./secret-sync";
import { llmProblem, SECRET_NAMES, setSecretStamp, type AppSettings } from "./settings";

export interface SecretSyncState {
  /** 這個同步空間要不要帶 API key 與 Intervals.icu 的連線；還不知道（資料庫還沒讀到）時是 null */
  share: boolean | null;
  /** 改要不要帶（每台都照它）；關掉時刪掉雲端那筆 */
  setShare(on: boolean): Promise<void>;
  /** 換同步金鑰之前呼叫；換好之後用新的同步金鑰呼叫回傳的函式（重新加密） */
  beforeRekey(): Promise<(newRoot: Uint8Array) => Promise<void>>;
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
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const running = useRef(false);
  const again = useRef(false);

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
        const { wrote, adopt } = await reconcileSecrets(db, root, s);
        setShareState(await shareEnabled(db));
        if (wrote) touch();
        const names = SECRET_NAMES.filter((n) => adopt[n]);
        if (names.length) {
          const saved = await applySettings((current) => names.reduce((acc, n) => withSecret(acc, n, adopt[n]!.value), current));
          // 存設定時記成「現在改的」；改回別台改的時間，兩台一樣之後不再來回
          for (const n of names) setSecretStamp(n, adopt[n]!.at);
          const text = adoptedText(adopt);
          if (text) toast(adopt.llm && llmProblem(saved) ? `${text}到設定的「AI 教練」確認資料流向，就能開始對話。` : text);
        }
      } while (again.current);
    } catch {
      // 解不開、資料庫忙：下次同步完再試
    } finally {
      running.current = false;
    }
  }, [enabled, db, applySettings, touch, toast]);

  useEffect(() => {
    if (!db) return;
    void shareEnabled(db)
      .then(setShareState)
      .catch(() => undefined);
  }, [db, deviceSync.lastAt]);

  useEffect(() => {
    if (enabled) void check();
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
      await saveShare(db, on);
      setShareState(on);
      await check();
      touch();
    },
    [db, check, touch],
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

  return { share, setShare, beforeRekey };
}
