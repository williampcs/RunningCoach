/**
 * 教練動態：打開 App 時，教練主動提醒的事項（規格 12.3）.
 *
 * 全部依本機資料的固定規則產生，不呼叫模型：沒有費用、打開就看得到。
 * 內容只有這一份；之後的通知（推播、LINE、Discord）只負責提醒使用者來看，不另外產生內容。
 */
import { daysBetween, weekdayName } from "./dates";
import type { Db } from "./db";
import { keepScore, maybeSameRun } from "./dedupe";
import { analyzeRecovery, describeCheckin } from "./recovery";
import type { CoachSettings } from "./types";

export type FeedAction =
  | { type: "checkin" }
  /** 前往跑後回報；有 workoutId 時預先選好那一筆 */
  | { type: "report"; workoutId?: number }
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
  kind: "checkin" | "recovery" | "report" | "pending" | "race" | "plan" | "volume" | "gap" | "duplicate";
  tone: "warn" | "info" | "ok";
  title: string;
  detail?: string;
  actions: FeedAction[];
}

/** 連續幾天沒跑才提醒 */
const GAP_DAYS = 5;
/** 近 7 天跑量比前三週平均多多少才提醒 */
const VOLUME_SPIKE = 1.3;
const RACE_SOON_DAYS = 30;

const ask = (label: string, message: string): FeedAction => ({ type: "ask", label, message });
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

export async function buildFeed(db: Db, today: string, settings: CoachSettings): Promise<FeedItem[]> {
  const [checkins, wellness, workouts, pending, races, pastRaces, plan, distinct] = await Promise.all([
    db.getCheckins(1),
    db.getWellness(36),
    db.getRecentWorkouts(28),
    db.getPendingSubjectiveByDate(today),
    db.getUpcomingRaces(RACE_SOON_DAYS),
    db.getPastRacesWithoutResult(settings.raceLookbackDays),
    db.getActiveTrainingPlan(),
    db.getDistinctPairs(),
  ]);
  const items: FeedItem[] = [];
  const recovery = analyzeRecovery(wellness, checkins, today);

  // 身體狀況：先問感受；手錶的數據只當參考
  if (!recovery.checkin) {
    items.push({
      id: `checkin-${today}`,
      kind: "checkin",
      tone: "info",
      title: "今天身體感覺如何？",
      detail: recovery.watchFlags.length
        ? `手錶顯示${recovery.watchFlags.join("、")}，但手錶不一定準，先說說你自己的感覺。`
        : recovery.latest
          ? "花 10 秒回報精神、痠痛與睡眠，教練會以你的感受為主，而不只看手錶。"
          : // 沒有手錶的恢復資料（例如只用 iPhone）：不提手錶
            "花 10 秒回報精神、痠痛與睡眠，教練會依你的感受調整建議。",
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
          (recovery.mismatch === "self_worse" ? "手錶數據看起來正常，但以你的感受為主。" : watch.length ? `手錶也顯示${watch.join("、")}。` : ""),
        actions: [
          ask("問教練怎麼調整", `我今天的狀況是${describeCheckin(recovery.checkin)}，今天的訓練該怎麼調整？`),
          { type: "checkin" },
        ],
      });
    } else if (watch.length) {
      items.push({
        id: `recovery-watch-${today}`,
        kind: "recovery",
        tone: "info",
        title: "手錶的恢復數據偏差，但你自評不錯",
        detail: `${watch.join("、")}。以你的感受為主，照計畫進行，過程中留意身體的反應。`,
        actions: [
          ask("問教練", `手錶顯示${watch.join("、")}，但我自己覺得還不錯（${describeCheckin(recovery.checkin)}），今天照課表跑可以嗎？`),
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
        detail: `${describe(a)}，和 ${describe(b)}。可能是手錶與手機都上傳了，或手動新增時重複了；合併後只算一次，之後可以再拆開。`,
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
      detail: "補上體感，教練的分析會更準。",
      actions: [{ type: "report", workoutId: latest.id }],
    });
  }

  if (pending) {
    items.push({
      id: `pending-${today}`,
      kind: "pending",
      tone: "info",
      title: "今天的跑後感受已暫存，等手錶同步",
      detail: "手錶同步到 Intervals.icu 後，按同步就會合併。",
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
      detail: `${race.date}，${race.distance_km} km${race.target_time ? `，目標 ${race.target_time}` : ""}`,
      actions:
        left <= 7 && left > 0
          ? [ask("安排賽前這幾天", `${race.name}還有 ${left} 天，幫我安排賽前這幾天的訓練、睡眠與補給。`)]
          : [{ type: "plan" }],
    });
  }
  for (const race of pastRaces) {
    items.push({
      id: `race-result-${race.id}`,
      kind: "race",
      tone: "info",
      title: `${race.name}的成績還沒記錄`,
      detail: `${race.date}，${daysBetween(race.date, today)} 天前`,
      actions: [ask("回報成績", `${race.name}跑完了，成績是 `)],
    });
  }

  // 今日課表：課表裡寫到今天星期幾的行
  if (plan) {
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
      detail: "跑量一下增加太多容易受傷，留意恢復。",
      actions: [ask("問教練", `我近 7 天跑了 ${km(recentKm)}，比前三週的平均（每週 ${km(priorKm)}）多 ${pct}%，需要調整嗎？`)],
    });
  }

  // 很久沒跑
  if (latest) {
    const gap = daysBetween(latest.date, today);
    if (gap >= GAP_DAYS) {
      items.push({
        id: `gap-${today}`,
        kind: "gap",
        tone: "info",
        title: `已經 ${gap} 天沒跑了`,
        detail: "休息也是訓練的一部分。想恢復節奏的話，可以請教練安排。",
        actions: [ask("聊聊恢復節奏", `我已經 ${gap} 天沒跑了，想慢慢恢復，該怎麼開始？`), { type: "sync" }],
      });
    }
  }

  // 需要注意的排前面
  // 「是不是同一趟」排最前面：沒合併的重複會讓跑量等其他提醒失準
  const order = { warn: 1, info: 2, ok: 3 } as const;
  const rank = (i: FeedItem) => (i.kind === "duplicate" ? 0 : order[i.tone]);
  return items.sort((a, b) => rank(a) - rank(b));
}
