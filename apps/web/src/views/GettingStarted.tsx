import { useEffect, useState, type ReactNode } from "react";

import { athleteSports, recordWithOf, SPORT_LABELS, type RecordWith, type Sport } from "@running-coach/core";

import { Check, CircleCheck, PencilLine, Smartphone, Watch, type LucideIcon } from "lucide-react";

import { useApp } from "../app-context";
import { Disclosure, EmojiText, Icon } from "../ui";
import { featureEnabled } from "../environment";
import { useSync } from "../use-sync";
import { FirstSync } from "./FirstSync";
import { PhoneGuide, SyncNotice } from "./PhoneGuide";
import { PrivacyLink } from "./PrivacyLink";
import { TermsShort } from "./TermsLink";

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

/** 「你用什麼記錄跑步？」的三個選項（規格 12.36）：手錶照原本的路（Intervals.icu），其他的先手動記 */
const RECORD_CHOICES: { id: RecordWith; icon: LucideIcon; title: string; sub: string }[] = [
  { id: "watch", icon: Watch, title: "手錶", sub: "Garmin、Coros、Apple Watch 等" },
  { id: "phone", icon: Smartphone, title: "手機的跑步 App", sub: "Nike Run Club、Strava 等" },
  { id: "none", icon: PencilLine, title: "沒有在記錄", sub: "跑完在這裡記一筆就好" },
];

/** 選手怎麼記錄跑步：存在選手資料（跟著同步，教練也看得到） */
export function RecordWithPicker({ value, onPicked }: { value: RecordWith | null; onPicked: (v: RecordWith) => void }) {
  const { coach, touch } = useApp();
  const pick = async (v: RecordWith) => {
    await coach.db.setProfileKey("record_with", v);
    touch();
    onPicked(v);
  };
  return (
    <fieldset className="choices" aria-label="你用什麼記錄跑步">
      {RECORD_CHOICES.map((c) => (
        <label key={c.id} className={`choice${value === c.id ? " selected" : ""}`}>
          <input type="radio" name="record-with" checked={value === c.id} onChange={() => void pick(c.id)} />
          <span className="list-row-icon">
            <Icon as={c.icon} />
          </span>
          <span className="list-row-text">
            <span className="list-row-title">{c.title}</span>
            <span className="list-row-sub">{c.sub}</span>
          </span>
          {value === c.id && <Icon as={CircleCheck} className="icon choice-check" />}
        </label>
      ))}
    </fieldset>
  );
}

/** 用手機或沒有在記錄的人：現在可行的路（iPhone 可以經 Intervals.icu Companion 自動上傳；Android 誠實寫要手動記） */
function PhonePaths() {
  const { openSettings } = useApp();
  return (
    <Disclosure summary="想讓手機的紀錄自動進來？" className="small">
      <p>
        <strong>iPhone：</strong>可以用 Intervals.icu Companion 把「健康」裡的跑步上傳到 Intervals.icu，再連到這裡（要兩個帳號）。
      </p>
      <PhoneGuide />
      <button onClick={() => openSettings("records")}>連接 Intervals.icu</button>
      <p>
        <strong>Android：</strong>目前沒有好的路（要付費的第三方 App，我們還沒實測），先手動記。
      </p>
    </Disclosure>
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

/**
 * 新手引導（規格 12.36 起）：你用什麼記錄跑步 → AI 模型 →（手錶：Intervals.icu → 抓紀錄；手機或沒有在記錄：記第一筆）
 * →（多運動：練哪些運動）→ 選手資料. 必要的步驟完成後自動隱藏
 */
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
  const recordWith = recordWithOf(counts.profile);
  // 已經連好 Intervals.icu 或有紀錄的人（這一步之前就在用的）不用再問
  const recordReady = recordWith !== null || intervalsReady || counts.workouts > 0;
  // 沒有手錶、還沒連接 Intervals.icu：手動記（規格 12.36）
  const manual = !intervalsReady && recordWith !== null && recordWith !== "watch";
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

  if (recordReady && llmReady && (manual || intervalsReady) && synced && sportsReady) {
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

  // 步驟的編號依前面有幾步
  let n = 0;
  const next = () => ++n;
  return (
    <section className="card getting-started">
      <div className="card-head">
        <h2>開始使用</h2>
        <button className="text" onClick={dismiss}>
          先略過
        </button>
      </div>
      <ol className="steps">
        <Step n={next()} done={recordReady} title="你用什麼記錄跑步？">
          <RecordWithPicker value={recordWith} onPicked={() => undefined} />
        </Step>
        <Step n={next()} done={llmReady} title="設定 AI 模型">
          <p className="small muted">
            選 AI 供應商、填你自己的 API key，費用由你的帳號支付。資料存在你的裝置上，見 <PrivacyLink />。
          </p>
          <TermsShort className="small muted" />
          <button className={recordReady ? "primary" : ""} onClick={() => openSettings("ai")}>
            前往設定
          </button>
        </Step>
        {manual ? (
          <Step n={next()} done={synced} title="記第一筆">
            <p className="small muted">跑完在「回報」記日期、距離、時間和體感，教練就知道你的近況。沒有心率也可以。</p>
            <button className={llmReady ? "primary" : ""} onClick={() => goTo("report")}>
              記第一筆
            </button>
            <PhonePaths />
          </Step>
        ) : (
          <>
            <Step n={next()} done={intervalsReady} title="連接 Intervals.icu">
              {testMode.enabled ? (
                <p className="small muted">測試模式使用假的跑步紀錄，不需要 Intervals.icu。</p>
              ) : (
                <>
                  <p className="small muted">教練透過 Intervals.icu 讀取你手錶的{multisport ? "訓練" : "跑步"}紀錄。</p>
                  <IntervalsGuide where="設定的「訓練紀錄」" />
                  <PhoneGuide />
                  <button className={llmReady && recordReady ? "primary" : ""} onClick={() => openSettings("records")}>
                    前往設定
                  </button>
                </>
              )}
            </Step>
          </>
        )}
        {multisport && (
          <Step n={next()} done={sportsReady} title="選擇你練的運動">
            <SportsStep profile={counts.profile} onSaved={touch} />
          </Step>
        )}
        {!manual && (
          <Step n={next()} done={synced} title={multisport ? "抓進你的訓練紀錄" : "抓進你的跑步紀錄"}>
            <p className="small muted">教練要看你的{what}紀錄才知道近況。</p>
            {!(llmReady && intervalsReady) && <p className="small muted">先完成上面兩步才能同步。</p>}
            <FirstSync sync={sync} disabled={!llmReady || !intervalsReady} />
          </Step>
        )}
        <Step n={next()} done={Object.keys(counts.profile).filter((k) => (!multisport || k !== "pref_sports") && k !== "record_with").length > 0} title="填寫選手資料（建議）">
          <p className="small muted">
            {manual ? "目標、5 km 或 10 km 的個人最佳等，教練才算得出你的配速；" : "目標、個人最佳、最大心率等，建議會更貼近你；"}也可以「從其他 AI 帶入」。
          </p>
          <button onClick={() => goTo("profile")}>前往選手資料</button>
        </Step>
      </ol>
    </section>
  );
}
