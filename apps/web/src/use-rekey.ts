/**
 * 換金鑰與移除別台（規格 12.27、12.10「換金鑰可以跨天完成」）. 放在 App 這一層：
 * - 移除馬上生效（伺服器先拒絕那台），換金鑰接著做；換金鑰的每日額度用完時停下，隔天自動接著做
 * - 打開 App（或頁面一直開著到了接著做的時間）時，有換到一半的就接著做，不用打開設定頁
 * - 完成時把新的同步金鑰留給設定頁的同步區塊顯示新的復原碼
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SyncRekeyPausedError, type PendingRekey, type RekeyProgress, type SyncDevice } from "@running-coach/core";

import type { DeviceSyncState } from "./device-sync";
import type { TrialSyncState } from "./use-trial-sync";

export interface RekeyState {
  /** 這台開始、還沒完成的換金鑰；沒有的話 null */
  pending: PendingRekey | null;
  busy: boolean;
  progress: RekeyProgress | null;
  /** 最後一次的錯誤（今天的額度用完不算錯誤，看 pending.resumeAt） */
  error: unknown;
  /** 這次移除的那台（移除之後馬上顯示「那台已經不能再同步」） */
  removed: SyncDevice | null;
  /** 換好了：新的同步金鑰（設定頁顯示新的復原碼後清掉） */
  finished: Uint8Array | null;
  start(remove: SyncDevice | null, expected: string[] | undefined): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  clearFinished(): void;
  clearError(): void;
}

/** 接著做的時間到了之後，頁面一直開著時最多等這麼久再檢查一次（setTimeout 的上限也在這附近） */
const MAX_TIMER_MS = 6 * 3600_000;

export function useRekey(deviceSync: DeviceSyncState, trialSync: TrialSyncState): RekeyState {
  const engine = deviceSync.devicesMode ? deviceSync.engine : null;
  const [pending, setPending] = useState<PendingRekey | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RekeyProgress | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [removed, setRemoved] = useState<SyncDevice | null>(null);
  const [finished, setFinished] = useState<Uint8Array | null>(null);
  const [tick, setTick] = useState(0);
  const running = useRef(false);
  /** 這次打開頁面自動接著做失敗過（連不上等）：不一直重試，等下次打開或使用者按 */
  const autoFailed = useRef(false);

  const refresh = useCallback(async () => {
    setPending(engine ? await engine.pendingRekey().catch(() => null) : null);
  }, [engine]);

  useEffect(() => {
    void refresh();
  }, [refresh, deviceSync.lastAt]);

  const run = useCallback(
    async (job: (onProgress: (p: RekeyProgress) => void) => Promise<Uint8Array | null>) => {
      if (!engine || running.current) return;
      running.current = true;
      setBusy(true);
      setError(null);
      try {
        // 免費試用的帳號（規格 12.44）：換之前記下現在的復原密鑰，換好之後換一把新的（被移除的那台知道的舊的就不能用）
        const rotateTrial = await trialSync.beforeRekey();
        const root = await job(setProgress);
        if (root) {
          await rotateTrial(root);
          setFinished(root);
          void deviceSync.run();
        }
      } catch (e) {
        // 今天的額度用完：不是錯誤，明天接著做（pending 會記著到哪裡、幾點之後）
        if (!(e instanceof SyncRekeyPausedError)) {
          setError(e);
          autoFailed.current = true;
        }
        // 清單變了、或移除生效了：重新取一次
        void deviceSync.run();
      } finally {
        running.current = false;
        setBusy(false);
        setProgress(null);
        await refresh();
      }
    },
    [engine, trialSync, deviceSync, refresh],
  );

  const start = useCallback(
    async (remove: SyncDevice | null, expected: string[] | undefined) => {
      setRemoved(null);
      autoFailed.current = false;
      await run(async (onProgress) => {
        // 移除的那台在 rekey 一開始就被伺服器拒絕：之後即使停下來（明天接著做）它也已經不能同步
        const root = await engine!.rekey(remove ? [remove.id] : [], expected, (p) => {
          if (remove && p.step === "fetch") setRemoved(remove);
          onProgress(p);
        });
        return root;
      });
    },
    [run, engine],
  );

  const resume = useCallback(async () => {
    autoFailed.current = false;
    await run((onProgress) => engine!.resumeRekey(onProgress));
  }, [run, engine]);

  const cancel = useCallback(async () => {
    if (!engine) return;
    try {
      await engine.cancelRekey();
      setRemoved(null);
      setError(null);
    } catch (e) {
      setError(e);
    }
    await refresh();
  }, [engine, refresh]);

  // 有換到一半的：時間到了就接著做（打開 App 時、頁面一直開著到了隔天）
  useEffect(() => {
    if (!engine || !pending || busy || autoFailed.current) return;
    const wait = pending.resumeAt - Date.now();
    if (wait <= 0) {
      void resume();
      return;
    }
    // 等太久的先醒來重新算（setTimeout 不適合等一整天）
    const timer = wait + 5_000 <= MAX_TIMER_MS ? setTimeout(() => void resume(), wait + 5_000) : setTimeout(() => setTick((n) => n + 1), MAX_TIMER_MS);
    return () => clearTimeout(timer);
  }, [engine, pending, busy, resume, tick]);

  return useMemo(
    () => ({
      pending,
      busy,
      progress,
      error,
      removed,
      finished,
      start,
      resume,
      cancel,
      clearFinished: () => setFinished(null),
      clearError: () => setError(null),
    }),
    [pending, busy, progress, error, removed, finished, start, resume, cancel],
  );
}
