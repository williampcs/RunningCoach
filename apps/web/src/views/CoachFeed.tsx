import { useEffect, useRef, useState } from "react";

import {
  Activity,
  CalendarDays,
  ChevronDown,
  CloudSun,
  CloudOff,
  Copy,
  Flag,
  Bandage,
  HeartPulse,
  Siren,
  Hourglass,
  Sprout,
  SquarePen,
  TrendingUp,
  X,
  type LucideIcon,
} from "lucide-react";

import { shortDateLabel, type FeedAction, type FeedItem } from "@running-coach/core";

import { useApp } from "../app-context";
import { Icon, SportIcon } from "../ui";
import { dismissRedFlags, useRedFlagAlert } from "../red-flag-alert";
import { redFlagFeedItem } from "./RedFlag";
import { useSync } from "../use-sync";
import { SyncNotice } from "./PhoneGuide";
import { SCOPED_KEYS, storageKey } from "../storage-scope";

// 測試模式用自己一份（storage-scope.ts）
const STATE_KEY = () => storageKey(SCOPED_KEYS.feed);

/** 「知道了」的項目與收合狀態只記當天，隔天重新顯示 */
interface FeedState {
  date: string;
  dismissed: string[];
  collapsed: boolean;
}

function loadState(today: string): FeedState {
  try {
    const stored = JSON.parse(localStorage.getItem(STATE_KEY()) ?? "null") as FeedState | null;
    if (stored?.date === today) return stored;
  } catch {
    // 無法存取時用預設值
  }
  return { date: today, dismissed: [], collapsed: true };
}

function saveState(state: FeedState): void {
  try {
    localStorage.setItem(STATE_KEY(), JSON.stringify(state));
  } catch {
    // 無法存取時略過
  }
}

const ICONS: Record<FeedItem["kind"], LucideIcon> = {
  checkin: HeartPulse,
  recovery: HeartPulse,
  report: SquarePen,
  pending: Hourglass,
  race: Flag,
  plan: CalendarDays,
  volume: TrendingUp,
  gap: Sprout,
  duplicate: Copy,
  weather: CloudSun,
  cross: Activity,
  medical: Siren,
  injury: Bandage,
  unavailable: CloudOff,
};

/**
 * 身體狀況的提醒（還沒回報、傷還沒分數、狀況不好的建議）一直留著，按「去回報」到「回報」分頁（2026-11-12 起表單在那裡）；
 * 就醫提示要按「我知道了」才收起；其他的可以按「知道了」略過
 */
function dismissible(item: FeedItem): boolean {
  return !item.actions.some((a) => a.type === "checkin" || a.type === "ack");
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
 * 呈現成「今天的重點」看板（12.16 的 A 版）：滿版的一條、淡的底色、每則一列，看起來是介面而不是訊息。
 * 展開就全部顯示，太多時在看板內捲動（最高約半個畫面）。
 * collapseSignal 每次送出訊息時遞增：開始對話後收成一行，讓對話有空間。
 */
export function CoachFeed({ collapseSignal = 0 }: { collapseSignal?: number }) {
  const { coach, settings, revision, goTo, openReport, openCheckin, llmProblem, touch } = useApp();
  const sync = useSync();
  const today = coach.today();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [state, setState] = useState(() => loadState(today));
  // 就醫提示（規格 12.33）：和畫面上方的那條同一份，放在看板的最前面
  const redFlag = useRedFlagAlert();
  // 收起時輪播到第幾則；滑鼠移上去或鍵盤聚焦時暫停
  const [tick, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion] = useState(prefersReducedMotion);
  const sectionRef = useRef<HTMLElement>(null);

  // 設定改了（例：清除天氣的城市、改時區）也重新整理：儲存設定只更新同一個 Coach，不會改 revision（KI-047）。
  // 先送出的比較慢時不蓋掉後來的
  useEffect(() => {
    let cancelled = false;
    void coach.feed().then((next) => !cancelled && setItems(next));
    return () => {
      cancelled = true;
    };
  }, [coach, revision, settings]);

  // 內容更新（例如存了自評、項目重新排序）後回到最上面，不停在原本捲動的位置
  useEffect(() => {
    if (sectionRef.current) sectionRef.current.scrollTop = 0;
  }, [items]);

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
  const all = redFlag ? [redFlagFeedItem(redFlag), ...items] : items;
  const visible = all.filter((i) => !dismissible(i) || !state.dismissed.includes(i.id));
  const hidden = all.length - visible.length;
  const restore = () => update({ ...state, dismissed: [] });

  // 收起時一則一則輪播；偏好減少動態效果時不輪播
  const rotating = state.collapsed && visible.length > 1 && !paused && !reducedMotion;
  useEffect(() => {
    if (!rotating) return;
    const timer = setInterval(() => setTick((t) => t + 1), ROTATE_MS);
    return () => clearInterval(timer);
  }, [rotating]);

  const dateLabel = `今天 ${shortDateLabel(today)}`;
  // 整張看板是一張卡，最多一顆實心按鈕（規格 12.28）：還沒回報身體狀況時只給身體狀況那列；
  // 回報過了，給排第一、要動手的那列（今天的課的「查看計畫」不算，課表頁才是做事的地方）
  const unreported = visible.find((i) => i.kind === "checkin" && i.tone === "info");
  const primaryId = (unreported ?? visible.find((i) => i.actions.length > 0 && i.tone !== "ok" && i.kind !== "plan"))?.id ?? null;

  if (visible.length === 0) {
    return hidden ? (
      <section className="feed" aria-label="教練動態">
        <div className="feed-head">
          <strong className="feed-date">{dateLabel}</strong>
          <button className="text feed-more" onClick={restore}>
            顯示略過的 {hidden} 則
          </button>
        </div>
      </section>
    ) : null;
  }

  function runAction(action: FeedAction, item: FeedItem) {
    switch (action.type) {
      case "checkin":
        // 身體狀況與傷的分數在「回報」分頁
        openCheckin();
        return;
      case "ack":
        dismissRedFlags();
        return;
      case "report":
        openReport(action.workoutId ?? action.intervalsId);
        return;
      case "plan":
        goTo("plan");
        // 賽事那列：捲到課表頁下面的賽事
        if (item.kind === "race") setTimeout(() => document.getElementById("races")?.scrollIntoView({ block: "start" }), 50);
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
      case "manual":
        // 回報頁下面有「手動記一趟」
        goTo("report");
        return;
      case "help":
        // 和教練回覆裡的說明連結一樣：#help/段落
        location.hash = `help/${action.topic}`;
        return;
    }
  }

  const label = (action: FeedAction, item: FeedItem) => {
    switch (action.type) {
      case "checkin":
        return "去回報";
      case "ack":
        return "我知道了";
      case "report":
        return "去回報";
      case "plan":
        return item.kind === "race" ? "查看賽事" : "查看計畫";
      case "sync":
        return sync.busy ? "同步中…" : "同步最近 14 天";
      case "ask":
        return action.label;
      case "merge":
        return "合併";
      case "distinct":
        return "不是同一趟";
      case "manual":
        return "手動記一趟";
      case "help":
        return action.label;
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
          <span className="feed-date" aria-hidden="true">
            {dateLabel}
          </span>
          <span key={current.id} className={reducedMotion ? "feed-ticker" : "feed-ticker animate"}>
            <Icon as={ICONS[current.kind]} size={18} />
            <span className="feed-summary-text">{[current.title, current.badge ?? current.lines?.map((l) => l.text).join(" · ")].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="feed-count">
            {visible.length > 1 ? `${index + 1}/${visible.length}` : ""}
            <Icon as={ChevronDown} size={18} />
          </span>
        </button>
      </section>
    );
  }

  return (
    <section className="feed" aria-label="教練動態" ref={sectionRef}>
      <div className="feed-head">
        <strong className="feed-date">{dateLabel}</strong>
        <button className="text" onClick={() => update({ ...state, collapsed: true })}>
          收起
        </button>
      </div>
      <ul className="feed-list">
        {visible.map((item) => (
          // 一列：圖示、標題與一行摘要、最多一顆主要按鈕（其他是外框）；「知道了」一律是右上角的 ✕（規格 12.28）
          <li key={item.id} className={`feed-item ${item.tone}`} data-kind={item.kind}>
            <span className="feed-icon">
              <Icon as={ICONS[item.kind]} />
            </span>
            <div className="feed-body">
              <div className="feed-text">
                <span className="feed-title">{item.title}</span>
                {/* Garmin 的標示（KI-048）：標題下方 */}
                {item.source && <span className="feed-source small muted">{item.source}</span>}
                {item.lines && (
                  <ul className="feed-lines">
                    {item.lines.map((line, i) => (
                      <li key={i}>
                        <SportIcon sport={line.sport} size={16} />
                        {line.text}
                      </li>
                    ))}
                  </ul>
                )}
                {item.tags && (
                  <span className="chips feed-tags">
                    {item.tags.map((t) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                  </span>
                )}
                {item.detail && (
                  <span className="feed-sub" title={item.detail}>
                    {item.detail}
                  </span>
                )}
                {item.credit && (
                  <a className="credit" href={item.credit.href} target="_blank" rel="noreferrer">
                    {item.credit.label}
                  </a>
                )}
              </div>
              <div className="feed-actions">
                {/* 整張看板最多一顆實心按鈕（primaryId）；其他列的第一個動作是外框，其餘是文字按鈕 */}
                {item.actions.map((action, i) => (
                  <button
                    key={i}
                    className={i > 0 ? "text" : item.id === primaryId ? "primary" : ""}
                    disabled={(action.type === "ask" && llmProblem !== null) || (action.type === "sync" && sync.busy)}
                    onClick={() => runAction(action, item)}
                  >
                    {label(action, item)}
                  </button>
                ))}
              </div>
            </div>
            {item.badge && <span className="feed-badge">{item.badge}</span>}
            {dismissible(item) ? (
              <button
                className="icon-button feed-dismiss"
                aria-label="知道了"
                title="知道了"
                onClick={() => update({ ...state, dismissed: [...state.dismissed, item.id] })}
              >
                <Icon as={X} />
              </button>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button className="text feed-more" onClick={restore}>
          顯示略過的 {hidden} 則
        </button>
      )}
      <SyncNotice message={sync.message} />
    </section>
  );
}
