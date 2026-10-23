import { useEffect, useState, type ReactNode } from "react";

import { useApp } from "../app-context";
import { useSync } from "../use-sync";
import { FirstSync } from "./FirstSync";
import { PhoneGuide, SyncNotice } from "./PhoneGuide";

const DISMISS_KEY = "running-coach.getting-started.dismissed";

/** 讓新手引導重新出現（重置時使用） */
export function resetGettingStarted(): void {
  try {
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    // 無法存取時略過
  }
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** 從 Intervals.icu 取得 API key 並填進這個 App 的步驟（新手引導與設定頁共用）；where 是貼上 key 的位置 */
export function IntervalsGuide({ where }: { where: string }) {
  return (
    <ol className="guide small">
      <li>
        登入 Intervals.icu，打開{" "}
        <a href="https://intervals.icu/settings" target="_blank" rel="noreferrer">
          Settings 頁面
        </a>
        。
      </li>
      <li>在 Developer Settings 區塊產生 API key，複製起來。</li>
      <li>貼到{where}；Athlete ID 可以留空。</li>
    </ol>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: ReactNode }) {
  return (
    <li className={done ? "step done" : "step"}>
      <div className="step-head">
        <span className="step-mark" aria-hidden="true">
          {done ? "✓" : n}
        </span>
        <strong>{title}</strong>
        {done && <span className="muted small">完成</span>}
      </div>
      {!done && <div className="step-body">{children}</div>}
    </li>
  );
}

/** 新手引導：AI 模型 → Intervals.icu → 同步最近 14 天 → 選手資料。必要的三步完成後自動隱藏 */
export function GettingStarted() {
  const { coach, settings, llmProblem, revision, goTo, activitiesReady, testMode } = useApp();
  const [counts, setCounts] = useState<{ workouts: number; profile: number } | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const sync = useSync();

  useEffect(() => {
    void Promise.all([coach.db.countWorkouts(), coach.db.getProfile()]).then(([workouts, profile]) =>
      setCounts({ workouts, profile: Object.keys(profile).length }),
    );
  }, [coach, revision]);

  if (!counts || dismissed) return null;

  const llmReady = llmProblem === null;
  const intervalsReady = activitiesReady;
  const synced = counts.workouts > 0;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // 無法寫入時只在這次隱藏
    }
  }

  if (llmReady && intervalsReady && synced) {
    // 剛在這裡完成同步時，留下結果與下一步，按「知道了」才關閉
    if (!sync.message) return null;
    return (
      <section className="card getting-started">
        <h2>準備好了</h2>
        <div className={`notice ${sync.message.kind}`}>{sync.message.text}</div>
        <p className="small">可以直接在下面和教練聊聊近況，或到「紀錄」看每次訓練的分析。</p>
        <div className="row">
          <button onClick={() => goTo("history")}>查看訓練紀錄</button>
          <button className="link" onClick={dismiss}>
            知道了
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card getting-started">
      <div className="row between">
        <h2>開始使用</h2>
        <button className="link small" onClick={dismiss}>
          先略過
        </button>
      </div>
      <ol className="steps">
        <Step n={1} done={llmReady} title="設定 AI 模型">
          <p className="small muted">選擇 AI 供應商並填入你自己的 API key，費用由你的帳號支付。</p>
          <button onClick={() => goTo("settings")}>前往設定</button>
        </Step>
        <Step n={2} done={intervalsReady} title="連接 Intervals.icu">
          {testMode.enabled ? (
            <p className="small muted">測試模式使用假的跑步紀錄，不需要 Intervals.icu。</p>
          ) : (
            <>
              <p className="small muted">教練透過 Intervals.icu 讀取你手錶的跑步紀錄。</p>
              <IntervalsGuide where="設定頁的「Intervals.icu」區塊" />
              <PhoneGuide />
              <button onClick={() => goTo("settings")}>前往設定</button>
            </>
          )}
        </Step>
        <Step n={3} done={synced} title="抓進你的跑步紀錄">
          <p className="small muted">教練要看你的跑步紀錄才知道近況。</p>
          {!(llmReady && intervalsReady) && <p className="small muted">先完成上面兩步才能同步。</p>}
          <FirstSync sync={sync} disabled={!llmReady || !intervalsReady} />
        </Step>
        <Step n={4} done={counts.profile > 0} title="填寫選手資料（建議）">
          <p className="small muted">
            目標、個人最佳、最大心率等，教練的建議會更貼近你。已經跟其他 AI 聊過訓練的話，可以在選手資料頁「從其他 AI 帶入」。
          </p>
          <button onClick={() => goTo("profile")}>前往選手資料</button>
        </Step>
      </ol>
    </section>
  );
}
