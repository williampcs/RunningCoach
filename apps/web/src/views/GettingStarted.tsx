import { useEffect, useState, type ReactNode } from "react";

import { athleteSports, SPORT_LABELS, type Sport } from "@running-coach/core";

import { Check } from "lucide-react";

import { useApp } from "../app-context";
import { EmojiText, Icon } from "../ui";
import { featureEnabled } from "../environment";
import { useSync } from "../use-sync";
import { FirstSync } from "./FirstSync";
import { PhoneGuide, SyncNotice } from "./PhoneGuide";
import { PrivacyLink } from "./PrivacyLink";

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
          {done ? <Icon as={Check} size={16} /> : n}
        </span>
        <strong>{title}</strong>
        {done && <span className="muted small">完成</span>}
      </div>
      {!done && <div className="step-body">{children}</div>}
    </li>
  );
}

/** 新手引導的「你練哪些運動」：跑步、騎車（可以只選騎車；多運動，規格 12.24）；其他的在選手資料選 */
const ONBOARDING_SPORTS: Sport[] = ["run", "ride"];

function SportsStep({ profile, onSaved }: { profile: Record<string, string>; onSaved: () => void }) {
  const { coach } = useApp();
  const [picked, setPicked] = useState<Sport[]>(() => (profile.pref_sports ? athleteSports(profile) : ["run"]));
  const toggle = (sport: Sport) => setPicked((p) => (p.includes(sport) ? p.filter((s) => s !== sport) : [...p, sport]));
  // 選手資料裡選過的其他運動（游泳、肌力…）保留
  const save = async () => {
    const others = profile.pref_sports ? athleteSports(profile).filter((s) => !ONBOARDING_SPORTS.includes(s)) : [];
    await coach.db.setProfileKey("pref_sports", [...picked, ...others].join(","));
    onSaved();
  };
  return (
    <>
      <p className="small muted">教練只排你有練的運動；游泳、肌力等之後在選手資料加。</p>
      <fieldset className="choices row onboarding-sports" aria-label="你練哪些運動">
        {ONBOARDING_SPORTS.map((sport) => (
          <label key={sport} className="check">
            <input type="checkbox" checked={picked.includes(sport)} onChange={() => toggle(sport)} />
            {SPORT_LABELS[sport]}
          </label>
        ))}
      </fieldset>
      <button disabled={!picked.length} onClick={() => void save()}>
        儲存練的運動
      </button>
    </>
  );
}

/** 新手引導：AI 模型 → Intervals.icu →（多運動：練哪些運動）→ 同步最近 14 天 → 選手資料。必要的步驟完成後自動隱藏 */
export function GettingStarted() {
  const { coach, llmProblem, revision, goTo, openSettings, activitiesReady, testMode, touch } = useApp();
  const [counts, setCounts] = useState<{ workouts: number; others: number; profile: Record<string, string> } | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const sync = useSync();
  const multisport = featureEnabled("multisport");

  useEffect(() => {
    void Promise.all([coach.db.countWorkouts(), coach.db.countOtherActivities(), coach.db.getProfile()]).then(([workouts, others, profile]) =>
      setCounts({ workouts, others, profile }),
    );
  }, [coach, revision]);

  if (!counts || dismissed) return null;

  const llmReady = llmProblem === null;
  const intervalsReady = activitiesReady;
  // 多運動：只練騎車的人沒有跑步，抓到騎車等其他運動也算
  const sports = multisport ? athleteSports(counts.profile) : ["run"];
  const sportsReady = !multisport || !!counts.profile.pref_sports;
  const synced = counts.workouts > 0 || (multisport && counts.others > 0);
  const what = multisport && !sports.includes("run") ? "訓練" : multisport ? "跑步與騎車" : "跑步";

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // 無法寫入時只在這次隱藏
    }
  }

  if (llmReady && intervalsReady && synced && sportsReady) {
    // 剛在這裡完成同步時，留下結果與下一步，按「知道了」才關閉
    if (!sync.message) return null;
    return (
      <section className="card getting-started">
        <h2>準備好了</h2>
        <div className={`notice ${sync.message.kind}`}><span>
          <EmojiText text={sync.message.text} />
        </span></div>
        <p className="small">可以直接在下面和教練聊聊近況，或到「紀錄」看每次訓練的分析。</p>
        <div className="actions">
          <button onClick={() => goTo("history")}>查看訓練紀錄</button>
          <button className="text" onClick={dismiss}>
            知道了
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card getting-started">
      <div className="card-head">
        <h2>開始使用</h2>
        <button className="text" onClick={dismiss}>
          先略過
        </button>
      </div>
      <ol className="steps">
        <Step n={1} done={llmReady} title="設定 AI 模型">
          <p className="small muted">
            選 AI 供應商、填你自己的 API key，費用由你的帳號支付。資料存在你的裝置上，見 <PrivacyLink />。
          </p>
          <button className="primary" onClick={() => openSettings("ai")}>
            前往設定
          </button>
        </Step>
        <Step n={2} done={intervalsReady} title="連接 Intervals.icu">
          {testMode.enabled ? (
            <p className="small muted">測試模式使用假的跑步紀錄，不需要 Intervals.icu。</p>
          ) : (
            <>
              <p className="small muted">教練透過 Intervals.icu 讀取你手錶的{multisport ? "訓練" : "跑步"}紀錄。</p>
              <IntervalsGuide where="設定的「訓練紀錄」" />
              <PhoneGuide />
              <button className={llmReady ? "primary" : ""} onClick={() => openSettings("records")}>
                前往設定
              </button>
            </>
          )}
        </Step>
        {multisport && (
          <Step n={3} done={sportsReady} title="選擇你練的運動">
            <SportsStep profile={counts.profile} onSaved={touch} />
          </Step>
        )}
        <Step n={multisport ? 4 : 3} done={synced} title={multisport ? "抓進你的訓練紀錄" : "抓進你的跑步紀錄"}>
          <p className="small muted">教練要看你的{what}紀錄才知道近況。</p>
          {!(llmReady && intervalsReady) && <p className="small muted">先完成上面兩步才能同步。</p>}
          <FirstSync sync={sync} disabled={!llmReady || !intervalsReady} />
        </Step>
        <Step n={multisport ? 5 : 4} done={Object.keys(counts.profile).filter((k) => !multisport || k !== "pref_sports").length > 0} title="填寫選手資料（建議）">
          <p className="small muted">目標、個人最佳、最大心率等，建議會更貼近你；也可以「從其他 AI 帶入」。</p>
          <button onClick={() => goTo("profile")}>前往選手資料</button>
        </Step>
      </ol>
    </section>
  );
}
