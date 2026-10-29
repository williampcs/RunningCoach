import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { closeBrowserDb } from "../db/driver";
import { acquireAtStart, continueHere, takeOver, tabLockSupported, type HeldLock } from "../tab-lock";

/** 等另一個分頁交出來多久還沒回應，就提示可以關掉它（例如還開著舊版本的 App） */
const SLOW_TAKEOVER_MS = 5000;

type Phase = "starting" | "busy" | "waiting" | "owner" | "moved";

/**
 * 同一時間只有一個分頁用資料庫（KI-046）：拿到鎖才打開 App；另一個分頁在用時讓使用者選「在這裡使用」，
 * 被接手的分頁先收起 App、關好資料庫才放開鎖，之後可以「在這裡繼續」再拿回來
 */
export function TabGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(() => (tabLockSupported() ? "starting" : "owner"));
  const [slow, setSlow] = useState(false);
  const held = useRef<HeldLock | null>(null);
  const started = useRef(false);
  const onRequested = useCallback(() => setPhase("moved"), []);

  useEffect(() => {
    // StrictMode 在開發時會執行兩次 effect
    if (!tabLockSupported() || started.current) return;
    started.current = true;
    void acquireAtStart(onRequested).then((lock) => {
      held.current = lock;
      setPhase(lock ? "owner" : "busy");
    });
  }, [onRequested]);

  // App 已經收起（打到一半的查詢都不會再送）：關好資料庫再放開鎖，接手的分頁才打得開
  useEffect(() => {
    if (phase !== "moved" || !held.current) return;
    const lock = held.current;
    held.current = null;
    void closeBrowserDb().finally(() => lock.release());
  }, [phase]);

  useEffect(() => {
    if (phase !== "waiting") return;
    const timer = setTimeout(() => setSlow(true), SLOW_TAKEOVER_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const useHere = () => {
    setPhase("waiting");
    void takeOver(onRequested).then((lock) => {
      held.current = lock;
      setPhase("owner");
    });
  };

  if (phase === "owner") return children;
  if (phase === "starting") return <main className="page muted">載入中…</main>;
  return (
    <main className="page tab-gate">
      <section className="card" role="status">
        {phase === "moved" ? (
          <>
            <h2>已經在另一個分頁使用</h2>
            <p className="muted">Zone2Mate 移到另一個分頁或視窗了，資料都在。要回到這裡，按「在這裡繼續」。</p>
            <div className="actions full">
              <button className="primary" onClick={continueHere}>
                在這裡繼續
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>已經在另一個分頁開著</h2>
            <p className="muted">同一時間只能在一個分頁或視窗使用，資料才不會互相蓋掉。按「在這裡使用」，另一個分頁會交過來。</p>
            {phase === "waiting" && slow && <p className="small muted">另一個分頁沒有回應：把它關掉，這裡就會接著打開。</p>}
            <div className="actions full">
              <button className="primary" disabled={phase === "waiting"} onClick={useHere}>
                {phase === "waiting" ? "接手中…" : "在這裡使用"}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
