/**
 * 換金鑰與移除別台（規格 12.27、12.10「換金鑰可以跨天完成」）. 放在 App 這一層：
 * - 移除馬上生效（伺服器先拒絕那台），換金鑰接著做；換金鑰的每日額度用完時停下，隔天自動接著做
 * - 打開 App（或頁面一直開著到了接著做的時間）時，有換到一半的就接著做，不用打開設定頁
 * - 完成時把新的同步金鑰留給設定頁的同步區塊顯示新的復原碼（移除時已經給過的不再給）
 * - 移除別台時先給新的復原碼（prepare），存好之後才移除；這台換到一半不見了，用新的復原碼還原的裝置自動接手完成（takeover）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SyncApiError, SyncRekeyPausedError, type PendingRekey, type RekeyProgress, type SyncDevice } from "@running-coach/core";

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
  /** 換好了，新的復原碼移除時已經給過（不再顯示第二組） */
  finishedQuietly: boolean;
  /** 用新的復原碼還原、接手換金鑰的進度（這台接手時）；沒有的話 null */
  takeover: { done: number; total: number; resumeAt: number } | null;
  /** 這台接手的換金鑰完成了 */
  takeoverDone: boolean;
  /** 移除之前：建立新空間、回傳新的同步金鑰（顯示新的復原碼）；失敗時 null（看 error） */
  prepare(remove: SyncDevice, expected: string[] | undefined): Promise<Uint8Array | null>;
  /** 另一台正在換金鑰（這台開始時伺服器上已經有一個換到一半的）：使用者可以選改由這台重新開始 */
  otherInProgress: boolean;
  start(remove: SyncDevice | null, expected: string[] | undefined): Promise<void>;
  /** 改由這台重新開始（取消另一台換到一半的） */
  replaceOther(): Promise<void>;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  clearFinished(): void;
  clearTakeoverDone(): void;
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
  const [finishedQuietly, setFinishedQuietly] = useState(false);
  const [takeover, setTakeover] = useState<{ done: number; total: number; resumeAt: number } | null>(null);
  const [takeoverDone, setTakeoverDone] = useState(false);
  const rekeyTarget = deviceSync.devices?.rekeyTarget === true;
  const [tick, setTick] = useState(0);
  const [otherInProgress, setOtherInProgress] = useState(false);
  const lastStart = useRef<{ remove: SyncDevice | null; expected: string[] | undefined } | null>(null);
  const running = useRef(false);
  /** 這次打開頁面自動接著做失敗過（連不上等）：不一直重試，等下次打開或使用者按 */
  const autoFailed = useRef(false);

  const refresh = useCallback(async () => {
    setPending(engine ? await engine.pendingRekey().catch(() => null) : null);
    setTakeover(engine ? await engine.takeoverStatus().catch(() => null) : null);
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
      setOtherInProgress(false);
      try {
        // 免費試用的帳號（規格 12.44）：換之前記下現在的復原密鑰，換好之後換一把新的（被移除的那台知道的舊的就不能用）
        const rotateTrial = await trialSync.beforeRekey();
        const codeGiven = (await engine.pendingRekey().catch(() => null))?.codeGiven === true;
        const root = await job(setProgress);
        if (root) {
          await rotateTrial(root);
          if (codeGiven) setFinishedQuietly(true);
          else setFinished(root);
          void deviceSync.run();
        }
      } catch (e) {
        // 今天的額度用完：不是錯誤，明天接著做（pending 會記著到哪裡、幾點之後）
        if (e instanceof SyncApiError && e.state === "rekey_in_progress") setOtherInProgress(true);
        else if (!(e instanceof SyncRekeyPausedError)) {
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

  const begin = useCallback(
    async (remove: SyncDevice | null, expected: string[] | undefined, replace: boolean) => {
      setRemoved(null);
      autoFailed.current = false;
      lastStart.current = { remove, expected };
      await run(async (onProgress) => {
        // 移除的那台在 rekey 一開始就被伺服器拒絕：之後即使停下來（明天接著做）它也已經不能同步
        const root = await engine!.rekey(
          remove ? [remove.id] : [],
          expected,
          (p) => {
            if (remove && p.step === "fetch") setRemoved(remove);
            onProgress(p);
          },
          { replace },
        );
        return root;
      });
    },
    [run, engine],
  );
  const start = useCallback((remove: SyncDevice | null, expected: string[] | undefined) => begin(remove, expected, false), [begin]);
  const replaceOther = useCallback(async () => {
    const last = lastStart.current;
    if (last) await begin(last.remove, last.expected, true);
  }, [begin]);

  const prepare = useCallback(
    async (remove: SyncDevice, expected: string[] | undefined) => {
      if (!engine || running.current) return null;
      running.current = true;
      setBusy(true);
      setError(null);
      setOtherInProgress(false);
      lastStart.current = { remove, expected };
      try {
        return await engine.prepareRekey([remove.id], expected);
      } catch (e) {
        if (e instanceof SyncApiError && e.state === "rekey_in_progress") setOtherInProgress(true);
        else setError(e);
        return null;
      } finally {
        running.current = false;
        setBusy(false);
        await refresh();
      }
    },
    [engine, refresh],
  );

  const runTakeover = useCallback(async () => {
    autoFailed.current = false;
    await run(async (onProgress) => {
      await engine!.takeover(onProgress);
      setTakeoverDone(true);
      return null;
    });
  }, [run, engine]);

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

  // 用新的復原碼還原、同步空間是換到一半的新空間：自動接手（額度用完時等到隔天）
  useEffect(() => {
    if (!engine || !rekeyTarget || busy || autoFailed.current) return;
    const wait = (takeover?.resumeAt ?? 0) - Date.now();
    if (wait <= 0) {
      void runTakeover();
      return;
    }
    const timer = wait + 5_000 <= MAX_TIMER_MS ? setTimeout(() => void runTakeover(), wait + 5_000) : setTimeout(() => setTick((n) => n + 1), MAX_TIMER_MS);
    return () => clearTimeout(timer);
  }, [engine, rekeyTarget, takeover, busy, runTakeover, tick]);

  // 有換到一半的：時間到了就接著做（打開 App 時、頁面一直開著到了隔天）.
  // 給了新的復原碼、還沒確認存好（還沒移除）的不自動做：等使用者重新開始或放棄
  useEffect(() => {
    if (!engine || !pending || busy || autoFailed.current) return;
    if (pending.codeGiven && pending.removed.length === 0) return;
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
      finishedQuietly,
      takeover: rekeyTarget ? takeover : null,
      takeoverDone,
      prepare,
      otherInProgress,
      start,
      replaceOther,
      resume,
      cancel,
      clearFinished: () => {
        setFinished(null);
        setFinishedQuietly(false);
      },
      clearTakeoverDone: () => setTakeoverDone(false),
      clearError: () => setError(null),
    }),
    [pending, busy, progress, error, removed, finished, finishedQuietly, rekeyTarget, takeover, takeoverDone, prepare, otherInProgress, start, replaceOther, resume, cancel],
  );
}
