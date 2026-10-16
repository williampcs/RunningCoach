import { useEffect, useRef, useState } from "react";

import type { DailyCheckin, FeedAction, FeedItem } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { useSync } from "../use-sync";

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

/** 教練動態：打開 App 時教練主動提醒的事項，固定在對話上方 */
export function CoachFeed() {
  const { coach, revision, goTo, llmProblem } = useApp();
  const sync = useSync();
  const today = coach.today();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [state, setState] = useState(() => loadState(today));
  const [checkinOpen, setCheckinOpen] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void coach.feed().then(setItems);
  }, [coach, revision]);

  // 內容更新（例如存了自評、項目重新排序）後回到最上面，不停在原本捲動的位置
  useEffect(() => {
    if (sectionRef.current) sectionRef.current.scrollTop = 0;
  }, [items]);

  // 模擬日期改變或跨日時重置當天的狀態
  useEffect(() => {
    if (state.date !== today) setState(loadState(today));
  }, [today, state.date]);

  const update = (next: FeedState) => {
    setState(next);
    saveState(next);
  };
  const visible = items.filter((i) => !state.dismissed.includes(i.id));
  if (visible.length === 0) return null;
  const top = visible[0]!;

  function runAction(action: FeedAction) {
    switch (action.type) {
      case "checkin":
        setCheckinOpen(true);
        return;
      case "report":
        goTo("report");
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
        return sync.busy ? "同步中…" : "同步";
      case "ask":
        return action.label;
    }
  };

  if (state.collapsed) {
    return (
      <section className="feed collapsed">
        <button className="feed-summary" onClick={() => update({ ...state, collapsed: false })}>
          <span aria-hidden="true">{ICONS[top.kind]}</span>
          <span className="feed-summary-text">{top.title}</span>
          <span className="muted small">{visible.length > 1 ? `還有 ${visible.length - 1} 則 ▾` : "▾"}</span>
        </button>
      </section>
    );
  }

  return (
    <section className="feed" aria-label="教練動態" ref={sectionRef}>
      <div className="row between">
        <strong>教練動態</strong>
        <button className="link" onClick={() => update({ ...state, collapsed: true })}>
          收起
        </button>
      </div>
      <ul className="feed-list">
        {visible.map((item) => (
          <li key={item.id} className={`feed-item ${item.tone}`}>
            <span className="feed-icon" aria-hidden="true">
              {ICONS[item.kind]}
            </span>
            <div className="feed-body">
              <strong>{item.title}</strong>
              {item.detail && <span className="small">{item.detail}</span>}
              {item.actions.some((a) => a.type === "checkin") && checkinOpen ? (
                <CheckinForm onDone={() => setCheckinOpen(false)} />
              ) : (
                <div className="row">
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
                  <button className="link" onClick={() => update({ ...state, dismissed: [...state.dismissed, item.id] })}>
                    知道了
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {sync.message && <div className={`notice ${sync.message.kind}`}>{sync.message.text}</div>}
    </section>
  );
}
