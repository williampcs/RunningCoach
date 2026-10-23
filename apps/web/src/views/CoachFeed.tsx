import { useEffect, useRef, useState } from "react";

import type { DailyCheckin, FeedAction, FeedItem } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { useSync } from "../use-sync";
import { SyncNotice } from "./PhoneGuide";

const STATE_KEY = "running-coach.feed.v1";

/** 「知道了」的項目與收合狀態只記當天，隔天重新顯示 */
interface FeedState {
  date: string;
  dismissed: string[];
  collapsed: boolean;
}

function loadState(today: string): FeedState {
  try {
    const stored = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null") as FeedState | null;
    if (stored?.date === today) return stored;
  } catch {
    // 無法存取時用預設值
  }
  return { date: today, dismissed: [], collapsed: false };
}

function saveState(state: FeedState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 無法存取時略過
  }
}

const ICONS: Record<FeedItem["kind"], string> = {
  checkin: "🙂",
  recovery: "💤",
  report: "📝",
  pending: "⏳",
  race: "🏁",
  plan: "📅",
  volume: "📈",
  gap: "🌱",
  duplicate: "🔁",
};

const SCALES = [
  { key: "energy", label: "精神", low: "很差", high: "很好" },
  { key: "soreness", label: "痠痛", low: "沒有", high: "很痠" },
  { key: "sleep", label: "睡眠", low: "很差", high: "很好" },
] as const;

/** 今天的身體狀況自評：三個 1–5 分加上備註 */
function CheckinForm({ onDone }: { onDone: () => void }) {
  const { coach, touch } = useApp();
  const [values, setValues] = useState({ energy: 3, soreness: 2, sleep: 3, notes: "" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void coach.db.getCheckin(coach.today()).then((c: DailyCheckin | null) => {
      if (c) setValues({ energy: c.energy, soreness: c.soreness, sleep: c.sleep, notes: c.notes ?? "" });
    });
  }, [coach]);

  async function save() {
    try {
      await coach.saveCheckin(values);
      touch();
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="checkin">
      {SCALES.map((s) => (
        <label key={s.key}>
          <span>
            {s.label}：<strong>{values[s.key]}</strong> / 5（1 {s.low} – 5 {s.high}）
          </span>
          <input
            type="range"
            min={1}
            max={5}
            value={values[s.key]}
            aria-label={s.label}
            onChange={(e) => setValues({ ...values, [s.key]: Number(e.target.value) })}
          />
        </label>
      ))}
      <label>
        備註
        <input value={values.notes} placeholder="例如：右小腿有點緊" onChange={(e) => setValues({ ...values, notes: e.target.value })} />
      </label>
      {error && <div className="notice error">{error}</div>}
      <div className="row">
        <button className="primary" onClick={() => void save()}>
          儲存
        </button>
        <button onClick={onDone}>取消</button>
      </div>
    </div>
  );
}

/** 今天的身體狀況（可以回報或修改自評的）一直留著，那是查看與修改自評的地方；其他的可以按「知道了」略過 */
function dismissible(item: FeedItem): boolean {
  return !item.actions.some((a) => a.type === "checkin");
}

/** 展開時先顯示幾則（手機的寬度放不下三則）；其餘按「顯示其餘」 */
function shownAtFirst(): number {
  try {
    return window.matchMedia("(max-width: 599px)").matches ? 2 : 3;
  } catch {
    return 3;
  }
}
/** 收起時輪播的間隔 */
const ROTATE_MS = 4500;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * 教練動態：打開 App 時教練主動提醒的事項，固定在對話上方。
 * collapseSignal 每次送出訊息時遞增：開始對話後收成一行，讓對話有空間。
 */
export function CoachFeed({ collapseSignal = 0 }: { collapseSignal?: number }) {
  const { coach, revision, goTo, openReport, llmProblem, touch } = useApp();
  const sync = useSync();
  const today = coach.today();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [state, setState] = useState(() => loadState(today));
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // 收起時輪播到第幾則；滑鼠移上去或鍵盤聚焦時暫停
  const [tick, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion] = useState(prefersReducedMotion);
  const [firstCount] = useState(shownAtFirst);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void coach.feed().then(setItems);
  }, [coach, revision]);

  // 內容更新（例如存了自評、項目重新排序）或切換顯示全部後回到最上面，不停在原本捲動的位置
  useEffect(() => {
    if (sectionRef.current) sectionRef.current.scrollTop = 0;
  }, [items, showAll]);

  // 模擬日期改變或跨日時重置當天的狀態
  useEffect(() => {
    if (state.date !== today) setState(loadState(today));
  }, [today, state.date]);

  useEffect(() => {
    if (collapseSignal === 0) return;
    setState((current) => {
      const next = { ...current, collapsed: true };
      saveState(next);
      return next;
    });
  }, [collapseSignal]);

  const update = (next: FeedState) => {
    setState(next);
    saveState(next);
  };
  const visible = items.filter((i) => !dismissible(i) || !state.dismissed.includes(i.id));
  const hidden = items.length - visible.length;
  const restore = () => update({ ...state, dismissed: [] });

  // 收起時一則一則輪播；偏好減少動態效果時不輪播
  const rotating = state.collapsed && visible.length > 1 && !paused && !reducedMotion;
  useEffect(() => {
    if (!rotating) return;
    const timer = setInterval(() => setTick((t) => t + 1), ROTATE_MS);
    return () => clearInterval(timer);
  }, [rotating]);

  if (visible.length === 0) {
    return hidden ? (
      <section className="feed" aria-label="教練動態">
        <button className="link feed-more" onClick={restore}>
          顯示略過的 {hidden} 則教練動態
        </button>
      </section>
    ) : null;
  }

  function runAction(action: FeedAction) {
    switch (action.type) {
      case "checkin":
        setCheckinOpen(true);
        return;
      case "report":
        openReport(action.workoutId);
        return;
      case "plan":
        goTo("plan");
        return;
      case "sync":
        void sync.run();
        return;
      case "ask":
        goTo("chat", action.message);
        return;
      case "merge":
        void coach.mergeWorkouts(action.keepId, action.dupId).then(touch);
        return;
      case "distinct":
        void coach.markDistinct(action.aId, action.bId).then(touch);
        return;
    }
  }

  const label = (action: FeedAction, item: FeedItem) => {
    switch (action.type) {
      case "checkin":
        return item.kind === "checkin" && item.tone === "info" ? "回報身體狀況" : "修改自評";
      case "report":
        return "前往跑後回報";
      case "plan":
        return "查看計畫";
      case "sync":
        return sync.busy ? "同步中…" : "同步最近 14 天";
      case "ask":
        return action.label;
      case "merge":
        return "合併";
      case "distinct":
        return "不是同一趟";
    }
  };

  if (state.collapsed) {
    const index = tick % visible.length;
    const current = visible[index]!;
    return (
      <section className="feed collapsed" aria-label="教練動態">
        <button
          className="feed-summary"
          aria-label={`教練動態（共 ${visible.length} 則）：${current.title}。點一下展開`}
          onClick={() => update({ ...state, collapsed: false })}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
        >
          <span key={current.id} className={reducedMotion ? "feed-ticker" : "feed-ticker animate"}>
            <span aria-hidden="true">{ICONS[current.kind]}</span>
            <span className="feed-summary-text">{current.title}</span>
          </span>
          <span className="muted small">
            {visible.length > 1 ? `${index + 1}/${visible.length} ` : ""}▾
          </span>
        </button>
      </section>
    );
  }

  const shown = showAll ? visible : visible.slice(0, firstCount);
  const more = visible.length - shown.length;
  return (
    <section className={showAll ? "feed all" : "feed"} aria-label="教練動態" ref={sectionRef}>
      <div className="feed-head">
        <strong>教練動態</strong>
        <button className="link" onClick={() => update({ ...state, collapsed: true })}>
          收起
        </button>
      </div>
      <ul className="feed-list">
        {shown.map((item) => (
          <li key={item.id} className={`feed-item ${item.tone}`}>
            <span className="feed-icon" aria-hidden="true">
              {ICONS[item.kind]}
            </span>
            <div className="feed-body">
              <div className="feed-text">
                <strong>{item.title}</strong>
                {item.detail && <span className="small">{item.detail}</span>}
              </div>
              {item.actions.some((a) => a.type === "checkin") && checkinOpen ? (
                <CheckinForm onDone={() => setCheckinOpen(false)} />
              ) : (
                <div className="feed-actions">
                  {item.actions.map((action, i) => (
                    <button
                      key={i}
                      className={i === 0 && item.tone !== "ok" ? "primary" : ""}
                      disabled={(action.type === "ask" && llmProblem !== null) || (action.type === "sync" && sync.busy)}
                      onClick={() => runAction(action)}
                    >
                      {label(action, item)}
                    </button>
                  ))}
                  {dismissible(item) && (
                    <button className="link" onClick={() => update({ ...state, dismissed: [...state.dismissed, item.id] })}>
                      知道了
                    </button>
                  )}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button className="link feed-more" onClick={() => setShowAll(true)}>
          顯示其餘 {more} 則
        </button>
      )}
      {showAll && visible.length > firstCount && (
        <button className="link feed-more" onClick={() => setShowAll(false)}>
          只顯示前 {firstCount} 則
        </button>
      )}
      {hidden > 0 && (
        <button className="link feed-more" onClick={restore}>
          顯示略過的 {hidden} 則
        </button>
      )}
      <SyncNotice message={sync.message} />
    </section>
  );
}
