/**
 * 教練動態：打開 App 時，教練主動提醒的事項（規格 12.3）.
 *
 * 全部依本機資料的固定規則產生，不呼叫模型：沒有費用、打開就看得到。
 * 內容只有這一份；之後的通知（推播、LINE、Discord）只負責提醒使用者來看，不另外產生內容。
 */
import { addDays, daysBetween, shortDateLabel, weekdayName } from "./dates";
import type { Db } from "./db";
import { keepScore, maybeSameRun } from "./dedupe";
import { activityLabel, STRENGTH_TYPES } from "./activity-labels";
import { featureOn } from "./features";
import { distanceText } from "./training-values";
import { isHardOther, QUALITY_KINDS, RIDE_QUALITY_KINDS } from "./plan";
import { athleteSports, sportOfType } from "./sports";
import { activePlan, type ActivePlan } from "./planning";
import { analyzeRecovery, describeCheckin } from "./recovery";
import type { CoachSettings } from "./types";
import { WEATHER_CREDIT, weatherNotice, type WeatherForecast } from "./weather";

export type FeedAction =
  | { type: "checkin" }
  /** 前往跑後回報；有 workoutId 時預先選好那一筆（騎車等其他運動是 intervalsId，多運動） */
  | { type: "report"; workoutId?: number; intervalsId?: string }
  | { type: "sync" }
  | { type: "plan" }
  /** 帶著這段文字開始和教練對話 */
  | { type: "ask"; label: string; message: string }
  /** 兩筆看起來是同一趟：合併（dupId 併進 keepId）或標記不是同一趟 */
  | { type: "merge"; keepId: number; dupId: number }
  | { type: "distinct"; aId: number; bId: number };

export interface FeedItem {
  /** 同一天內固定，用於「知道了」之後不再顯示 */
  id: string;
  kind: "checkin" | "recovery" | "report" | "pending" | "race" | "plan" | "volume" | "gap" | "duplicate" | "weather" | "cross";
  tone: "warn" | "info" | "ok";
  title: string;
  detail?: string;
  actions: FeedAction[];
  /** 資料來源的標示（天氣：Open-Meteo 的授權要求） */
  credit?: { label: string; href: string };
}

/** 連續幾天沒跑才提醒 */
const GAP_DAYS = 5;
/** 近 7 天跑量比前三週平均多多少才提醒 */
const VOLUME_SPIKE = 1.3;
const RACE_SOON_DAYS = 30;

const ask = (label: string, message: string): FeedAction => ({ type: "ask", label, message });

/** 可以直接當動詞的（「今天騎車了」）；其他的寫「今天做了…」 */
const VERB_LABELS = new Set(["騎車", "游泳", "走路", "健行", "划船"]);

/** 課表外的運動要多大才提醒調整：時間或負荷（走路要更久；我們的門檻） */
const NOTABLE_OTHER = { minutes: 30, load: 25, walkMinutes: 90 };

/**
 * 做了課表外的運動，或用別的運動取代了課表上的課（規格 12.24 的第 4 項，多運動開著時）：
 * 今天與昨天、沒有配到課的其他運動，這週還有沒上的課時，主動問要不要調整接下來的課（A → A'）
 */
function crossItems(active: ActivePlan, today: string): FeedItem[] {
  const yesterday = addDays(today, -1);
  const upcoming = active.sessions.filter((s) => s.kind !== "rest" && s.status !== "skipped" && (!s.date || s.date >= today) && s.result?.outcome !== "achieved");
  if (!upcoming.length) return [];
  const items: FeedItem[] = [];
  for (const a of active.extraOthers) {
    if (a.date !== today && a.date !== yesterday) continue;
    // 肌力訓練沒有排進課表時不提醒（不影響接下來的課）；太短的也不提
    if (STRENGTH_TYPES.has(a.type)) continue;
    const minutes = a.duration_min ?? 0;
    const load = a.training_load ?? 0;
    const walk = a.type === "Walk";
    if (load < NOTABLE_OTHER.load && minutes < (walk ? NOTABLE_OTHER.walkMinutes : NOTABLE_OTHER.minutes)) continue;
    const label = activityLabel(a.type);
    const day = a.date === today ? "今天" : "昨天";
    // 那天課表上的跑步課沒跑（昨天的）：當成用這項運動取代了那堂課；今天的還可能晚點跑，問要照跑還是調整
    const sameDay = active.sessions.find(
      (s) => s.date === a.date && s.isRun && s.status === "planned" && (s.result?.outcome === "missed" || s.result?.outcome === "pending"),
    );
    const replaced = sameDay?.result?.outcome === "missed" ? sameDay : null;
    const stillToday = sameDay && !replaced ? sameDay : null;
    const hard = isHardOther(a);
    const facts = [`${Math.round(minutes)} 分鐘`, a.avg_hr != null ? `平均心率 ${a.avg_hr}` : null, a.training_load != null ? `負荷 ${a.training_load}` : null]
      .filter(Boolean)
      .join("、");
    const heavy = minutes >= 90 || load >= 60;
    items.push({
      id: `cross-${a.intervals_id}`,
      kind: "cross",
      tone: "info",
      title: replaced
        ? `${day}用${label}取代了「${replaced.title}」`
        : stillToday
          ? `今天${VERB_LABELS.has(label) ? `${label}了` : `做了${label}`}，課表上還有「${stillToday.title}」`
          : `${day}有一趟課表外的${label}`,
      // 看板只放摘要（規格 12.28）：數字加一句
      detail:
        `${facts}${hard ? "，強度不低" : ""}。` +
        (heavy || hard ? "接下來的強度課可能要延後或減量。" : replaced ? "取代掉的課不必補。" : "可以請教練依這趟調整。"),
      actions: [
        ask(
          "請教練調整",
          `${day}（${a.date}）我${replaced ? `沒有跑「${replaced.title}」，改做了` : "做了課表外的"}${label}：${facts}。` +
            (stillToday ? `今天課表上還有「${stillToday.title}」。` : "") +
            "請依這趟調整這週接下來的課。",
        ),
        { type: "plan" },
      ],
    });
  }
  return items;
}

/** 結構化課表的提醒：課表是建議，不是考核——沒跑的跳過即可，跑了不一樣的課問要不要調整 */
async function planItems(db: Db, today: string, multisport: boolean): Promise<FeedItem[]> {
  const active = await activePlan(db, today);
  if (!active?.plan.week_start) return [];
  const items: FeedItem[] = [];
  const yesterday = addDays(today, -1);
  // 今天還沒做的課合成一列，只放摘要（時間或距離、目標）；步驟與替代留在課表頁（規格 12.28）
  const todo = active.sessions.filter(
    (s) => s.date === today && s.status !== "skipped" && s.kind !== "rest" && (!s.result || s.result.outcome === "pending"),
  );
  if (todo.length) {
    const amount = (s: (typeof todo)[number]) => s.brief[0] ?? null;
    const name = (s: (typeof todo)[number]) => {
      const a = amount(s);
      if (!a || s.title.includes(a)) return s.title;
      // 課名已經有數字（例：20 分鐘 T）時，時間放在括號裡，不連在一起讀
      return /\d/.test(s.title) ? `${s.title}（${a}）` : `${s.title} ${a}`;
    };
    const targets = [...new Set(todo.map((s) => s.target).filter((t): t is string => !!t))];
    // 「想改輕鬆一點」只給跑步與騎車的課（肌力等沒有強度可以降）
    const easier = todo.filter((s) => s.isRun || s.sport === "ride");
    items.push({
      id: `plan-today-${todo.map((s) => s.id).join("-")}`,
      kind: "plan",
      tone: "info",
      title: `今天：${todo.map(name).join(" · ")}`,
      detail: targets.length ? targets.join(" · ") : undefined,
      actions: [
        { type: "plan" },
        ...(easier.length ? [ask("想改輕鬆一點", `今天的${easier.map((s) => s.title).join("、")}我想改輕鬆一點，可以怎麼調整？`)] : []),
      ],
    });
  }
  for (const s of active.sessions) {
    const r = s.result;
    if (s.date === today && s.status !== "skipped" && s.kind !== "rest") {
      if (r?.outcome === "different") {
        items.push({
          id: `plan-different-${s.id}`,
          kind: "plan",
          tone: "info",
          title: "今天跑的和課表不同",
          detail: `${r.reasons.join("、")}。不算失敗；要調整這週剩下的課嗎？`,
          actions: [ask("請教練調整", `今天的${s.title}我跑得不一樣（${r.reasons.join("、")}），這週剩下的課要怎麼調整？`), { type: "plan" }],
        });
      }
    }
    if (s.date === yesterday && r?.outcome === "missed" && (QUALITY_KINDS.has(s.kind) || (multisport && RIDE_QUALITY_KINDS.has(s.kind)))) {
      items.push({
        id: `plan-missed-${s.id}`,
        kind: "plan",
        tone: "info",
        title: `昨天的${s.title}${RIDE_QUALITY_KINDS.has(s.kind) ? "沒騎" : "沒跑"}`,
        detail: "跳過即可，不要補，照課表繼續。",
        actions: [{ type: "plan" }],
      });
    }
  }
  if (multisport) items.push(...crossItems(active, today));
  // 這週的最後一天，或課表已經過了：提醒排下週（已經排好的不提醒）
  const weekEnd = addDays(active.plan.week_start, 6);
  if (today >= weekEnd && !(await db.getNextTrainingPlan())) {
    items.push({
      id: `plan-next-${weekEnd}`,
      kind: "plan",
      tone: "info",
      title: today > weekEnd ? "這週還沒有課表" : "下週的課表要排了嗎？",
      detail: "教練會參考這週實際跑的與體感。",
      actions: [ask("請教練排課表", today > weekEnd ? "幫我排這週的課表" : "幫我排下週的課表")],
    });
  }
  return items;
}
const km = (n: number) => `${Math.round(n * 10) / 10} km`;

/** 課表裡寫到今天星期幾的行，例：「週四：節奏跑 8km」 */
function todaysPlanLines(content: string, today: string): string[] {
  const day = weekdayName(today).slice(-1); // 星期四 → 四
  const pattern = new RegExp(`(週|周|星期|禮拜)${day}`);
  return content
    .split("\n")
    .map((l) => l.replace(/^[\s>*\-+#]+|\*\*/g, "").trim())
    .filter((l) => l && pattern.test(l))
    .slice(0, 2);
}

/** weather：今天起的預報（設定了天氣且取得到時），用來提醒濕熱、下雨與空氣品質 */
export async function buildFeed(db: Db, today: string, settings: CoachSettings, weather: WeatherForecast | null = null): Promise<FeedItem[]> {
  const multisport = featureOn(settings, "multisport");
  const [checkins, wellness, workouts, pending, races, pastRaces, plan, distinct, profile, others] = await Promise.all([
    db.getCheckins(1),
    db.getWellness(36),
    db.getRecentWorkouts(28),
    db.getPendingSubjectiveByDate(today),
    db.getUpcomingRaces(RACE_SOON_DAYS),
    db.getPastRacesWithoutResult(settings.raceLookbackDays),
    db.getActiveTrainingPlan(),
    db.getDistinctPairs(),
    db.getProfile(),
    multisport ? db.getOtherActivities(28) : Promise.resolve([]),
  ]);
  // 多運動：只練騎車的人不提醒「很久沒跑」；騎車有自己的回報與提醒
  const sports = multisport ? athleteSports(profile) : ["run"];
  const rides = others.filter((a) => sportOfType(a.type) === "ride");
  const items: FeedItem[] = [];
  const recovery = analyzeRecovery(wellness, checkins, today);
  // 手錶早上同步之前，最新的恢復資料是昨天的：寫明是昨天的
  const watchSays = recovery.latest && recovery.latest.date !== today ? "手錶昨天的資料顯示" : "手錶顯示";

  // 身體狀況：先問感受；手錶的數據只當參考
  if (!recovery.checkin) {
    items.push({
      id: `checkin-${today}`,
      kind: "checkin",
      tone: "info",
      title: "今天身體感覺如何？",
      detail: recovery.watchFlags.length
        ? `${watchSays}${recovery.watchFlags.join("、")}，但手錶不一定準，先說說你的感覺。`
        : "花 10 秒回報精神、痠痛與睡眠。",
      actions: [{ type: "checkin" }],
    });
  } else {
    const self = recovery.selfFlags;
    const watch = recovery.watchFlags;
    if (self.length) {
      items.push({
        id: `recovery-self-${today}`,
        kind: "recovery",
        tone: "warn",
        title: "今天狀況不太好，建議降低強度",
        detail:
          `${self.join("、")}。` +
          (recovery.mismatch === "self_worse" ? "手錶數據看起來正常，但以你的感受為主。" : watch.length ? `${watchSays.replace("顯示", "也顯示")}${watch.join("、")}。` : ""),
        actions: [
          ask("問教練調整", `我今天的狀況是${describeCheckin(recovery.checkin)}，今天的訓練該怎麼調整？`),
          { type: "checkin" },
        ],
      });
    } else if (watch.length) {
      items.push({
        id: `recovery-watch-${today}`,
        kind: "recovery",
        tone: "info",
        title: "手錶的恢復數據偏差，但你自評不錯",
        detail: `${watchSays}${watch.join("、")}。以你的感受為主，照計畫進行，過程中留意身體的反應。`,
        actions: [
          ask("問教練", `${watchSays}${watch.join("、")}，但我自己覺得還不錯（${describeCheckin(recovery.checkin)}），今天照課表跑可以嗎？`),
          { type: "checkin" },
        ],
      });
    } else {
      items.push({
        id: `checkin-done-${today}`,
        kind: "checkin",
        tone: "ok",
        title: "今天的身體狀況已記錄",
        detail: describeCheckin(recovery.checkin),
        actions: [{ type: "checkin" }],
      });
    }
  }

  // 兩筆看起來是同一趟，但沒有時間可以確定（例如其中一筆是手動新增的）：問選手要不要合併
  const recentRuns = workouts.filter((w) => daysBetween(w.date, today) <= 7);
  let asked = 0;
  for (let i = 0; i < recentRuns.length && asked < 2; i++) {
    for (let j = i + 1; j < recentRuns.length && asked < 2; j++) {
      const [a, b] = [recentRuns[i]!, recentRuns[j]!];
      const pair = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
      if (distinct.has(pair) || !maybeSameRun(a, b)) continue;
      // 保留資料較完整的；一樣完整時保留先進來的
      const [keep, dup] = keepScore(b) > keepScore(a) || (keepScore(b) === keepScore(a) && b.id < a.id) ? [b, a] : [a, b];
      const day = a.date === today ? "今天" : daysBetween(a.date, today) === 1 ? "昨天" : a.date;
      const describe = (w: typeof a) => `${km(w.distance_km ?? 0)}・${Math.round(w.duration_min ?? 0)} 分`;
      items.push({
        id: `duplicate-${pair}`,
        kind: "duplicate",
        tone: "info",
        title: `${day}的兩筆跑步看起來是同一趟`,
        detail: `${describe(a)} 和 ${describe(b)}；合併後只算一次，之後可以再拆開。`,
        actions: [
          { type: "merge", keepId: keep.id, dupId: dup.id },
          { type: "distinct", aId: Math.min(a.id, b.id), bId: Math.max(a.id, b.id) },
        ],
      });
      asked += 1;
    }
  }

  // 最近一次跑步還沒回報感受（今天或昨天）
  const latest = workouts[0];
  if (latest && latest.perceived_effort == null && daysBetween(latest.date, today) <= 1) {
    items.push({
      id: `report-${latest.id}`,
      kind: "report",
      tone: "info",
      title: `${latest.date === today ? "今天" : "昨天"}的 ${km(latest.distance_km ?? 0)} 還沒回報感受`,
      detail: "補上體感，分析會更準。",
      actions: [{ type: "report", workoutId: latest.id }],
    });
  }

  // 多運動：最近一次騎車還沒回報感受（今天或昨天，練騎車的人）
  const latestRide = rides[0];
  if (sports.includes("ride") && latestRide && latestRide.perceived_effort == null && daysBetween(latestRide.date, today) <= 1) {
    items.push({
      id: `report-ride-${latestRide.intervals_id}`,
      kind: "report",
      tone: "info",
      title: `${latestRide.date === today ? "今天" : "昨天"}的騎車（${Math.round(latestRide.duration_min ?? 0)} 分鐘）還沒回報感受`,
      detail: "補上體感，分析會更準。",
      actions: [{ type: "report", intervalsId: latestRide.intervals_id }],
    });
  }

  if (pending) {
    items.push({
      id: `pending-${today}`,
      kind: "pending",
      tone: "info",
      title: "今天的跑後感受已暫存，等手錶同步",
      detail: "手錶同步後按同步就會合併。",
      actions: [{ type: "sync" }],
    });
  }

  // 賽事：倒數與賽後成績
  for (const race of races) {
    const left = daysBetween(today, race.date);
    items.push({
      id: `race-${race.id}`,
      kind: "race",
      tone: left <= 7 ? "warn" : "info",
      title: left === 0 ? `今天是${race.name}，加油！` : `距離${race.name}還有 ${left} 天`,
      detail: [shortDateLabel(race.date), distanceText(race.distance_km * 1000), race.target_time && `目標 ${race.target_time}`].filter(Boolean).join(" · "),
      actions:
        left <= 7 && left > 0
          ? [ask("排賽前幾天", `${race.name}還有 ${left} 天，幫我安排賽前這幾天的訓練、睡眠與補給。`)]
          : [{ type: "plan" }],
    });
  }
  for (const race of pastRaces) {
    items.push({
      id: `race-result-${race.id}`,
      kind: "race",
      tone: "info",
      title: `${race.name}的成績還沒記錄`,
      detail: `${shortDateLabel(race.date)} · ${daysBetween(race.date, today)} 天前`,
      actions: [ask("回報成績", `${race.name}跑完了，成績是 `)],
    });
  }

  // 結構化的課表：今天的課、昨天沒跑的課、跑了不一樣的課、該排下週了
  if (plan?.week_start) {
    items.push(...(await planItems(db, today, multisport)));
  } else if (plan) {
    // 文字課表：課表裡寫到今天星期幾的行
    const lines = todaysPlanLines(plan.content, today);
    if (lines.length) {
      items.push({
        id: `plan-${today}`,
        kind: "plan",
        tone: "info",
        title: `今日課表（${weekdayName(today)}）`,
        detail: lines.join("；"),
        actions: [{ type: "plan" }],
      });
    }
  }

  // 跑量暴增：近 7 天對比前三週的週平均
  const recentKm = workouts.filter((w) => daysBetween(w.date, today) < 7).reduce((s, w) => s + (w.distance_km ?? 0), 0);
  const priorKm =
    workouts.filter((w) => daysBetween(w.date, today) >= 7 && daysBetween(w.date, today) < 28).reduce((s, w) => s + (w.distance_km ?? 0), 0) / 3;
  if (priorKm >= 10 && recentKm >= priorKm * VOLUME_SPIKE) {
    const pct = Math.round((recentKm / priorKm - 1) * 100);
    items.push({
      id: `volume-${today}`,
      kind: "volume",
      tone: "warn",
      title: `近 7 天跑了 ${km(recentKm)}，比前三週平均多 ${pct}%`,
      detail: "增加太多容易受傷，留意恢復。",
      actions: [ask("問教練", `我近 7 天跑了 ${km(recentKm)}，比前三週的平均（每週 ${km(priorKm)}）多 ${pct}%，需要調整嗎？`)],
    });
  }

  // 很久沒跑（不跑步的選手不提醒；只練騎車的人看騎車）
  if (!sports.includes("run") && sports.includes("ride")) {
    const gap = latestRide ? daysBetween(latestRide.date, today) : null;
    if (gap !== null && gap >= GAP_DAYS) {
      items.push({
        id: `gap-${today}`,
        kind: "gap",
        tone: "info",
        title: `已經 ${gap} 天沒騎車了`,
        detail: "想恢復節奏，可以請教練安排。",
        actions: [ask("聊聊恢復節奏", `我已經 ${gap} 天沒騎車了，想慢慢恢復，該怎麼開始？`), { type: "sync" }],
      });
    }
  } else if (latest && sports.includes("run")) {
    const gap = daysBetween(latest.date, today);
    if (gap >= GAP_DAYS) {
      items.push({
        id: `gap-${today}`,
        kind: "gap",
        tone: "info",
        title: `已經 ${gap} 天沒跑了`,
        detail: "想恢復節奏，可以請教練安排。",
        actions: [ask("聊聊恢復節奏", `我已經 ${gap} 天沒跑了，想慢慢恢復，該怎麼開始？`), { type: "sync" }],
      });
    }
  }

  // 天氣：只在會影響訓練時提醒；濕熱、下雨、空氣差合成一則
  const notice = weather ? weatherNotice(weather, today) : null;
  if (notice) {
    items.push({
      id: `weather-${today}`,
      kind: "weather",
      tone: notice.tone,
      title: notice.title,
      detail: notice.detail,
      actions: [ask("請教練調整", `${notice.title}，我今天的訓練要怎麼調整？`)],
      credit: { ...WEATHER_CREDIT },
    });
  }

  // 需要注意的排前面
  // 「是不是同一趟」排最前面：沒合併的重複會讓跑量等其他提醒失準
  const order = { warn: 1, info: 2, ok: 3 } as const;
  const rank = (i: FeedItem) => (i.kind === "duplicate" ? 0 : order[i.tone]);
  return items.sort((a, b) => rank(a) - rank(b));
}
