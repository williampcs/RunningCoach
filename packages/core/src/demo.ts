/**
 * 「先看看」的範例（規格 12.35 的 B、12.37）：新的使用者還沒設定前，用假的資料逛課表、紀錄、看板與選手頁.
 *
 * 範例的資料只放在一個記憶體裡的資料庫（網頁版的 `:memory:`），和使用者真的資料庫完全分開，離開就清掉；
 * 對話放一段預先寫好的範例，不打 AI；不連任何外部服務（活動來源是 FakeActivitySource）.
 */
import type { Coach } from "./coach";
import { addDays, weekdayIndex } from "./dates";
import { generateActivities, generateWellness, fakeRunSettings, type FakeSpec } from "./fake-activities";
import { savePlanFromTool } from "./planning";
import { refreshTrainingSnapshots } from "./sync";
import type { Activity, ActivitySource, RunSettings, WellnessDay } from "./types";

/** 範例選手：一週跑 4 次、慢慢加量、手錶有心率 */
export function demoSpec(today: string): FakeSpec {
  return { scenario: "build", endDate: today, weeks: 10, runsPerWeek: 4, easyPaceSec: 400, maxHr: 188, seed: 2026, device: "garmin" };
}

export interface DemoSource {
  activities: Activity[];
  wellness: WellnessDay[];
  runSettings: RunSettings;
}

/** FakeActivitySource 用的範例資料 */
export function demoSource(today: string): DemoSource {
  const spec = demoSpec(today);
  return { activities: generateActivities(spec), wellness: generateWellness(spec), runSettings: fakeRunSettings(spec) };
}

/** 範例對話：選手問「這週怎麼練」，教練的回覆（預先寫好，不打 AI） */
export const DEMO_QUESTION = "這週怎麼練？";

export const DEMO_REPLY = `這週照計畫頁的課表練：兩堂輕鬆跑、一堂閾值、週日長跑，總量比上週多一點點。

## 為什麼這樣排
你最近四週穩定在每週 4 次，輕鬆跑的心率都在 Z2，身體已經適應了這個量，所以這週只加一點長跑的距離。

## 每一堂的重點
- **輕鬆跑**：能說完整的句子的速度，心率不超過輕鬆跑的上限。
- **閾值**：4 × 1 km，每一趟都在配速範圍內，中間慢跑 1 分鐘。
- **長跑**：前半段放慢，後半段配速不要掉。

## 狀況不好時
睡不好或腿很重，閾值那堂可以換成 40 分鐘輕鬆跑，在課卡上按「換成輕鬆」就好。`;

const DEMO_PROFILE: Record<string, string> = {
  goal_long_term: "明年三月完成第一場半馬，目標 1:55 內",
  pb_5k: "25:30",
  pb_10k: "53:40",
  pref_long_run_day: "週日",
  pref_rest_days: "週一",
  record_with: "watch",
};

const DEMO_SUMMARY =
  "穩定的有氧跑，配速和心率都在輕鬆的範圍。\n\n- 前後半段的配速差不多，控制得很好。\n- 心率在 Z2，適合累積跑量。";

/** 這週還剩下的日子不到 3 天時排下週，課都在今天以後（不會配對到已經跑過的紀錄） */
function demoPlan(today: string): Record<string, unknown> {
  const weekStart = addDays(today, -weekdayIndex(today));
  const start = 6 - weekdayIndex(today) >= 2 ? weekStart : addDays(weekStart, 7);
  const days = [1, 3, 5, 6].map((d) => addDays(start, d)).filter((d) => d >= today);
  const easy = { kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40, target: { hr: "easy" } }], purpose: "有氧基礎", success: "能說完整的句子", fallback: "" };
  const threshold = {
    kind: "threshold",
    title: "4 × 1 km 閾值",
    steps: [
      { duration_min: 15, target: { hr: "easy" } },
      { repeat: 4, steps: [{ distance_km: 1, target: { pace: "T" } }, { duration_min: 1, target: { hr: "easy" } }] },
      { duration_min: 10, target: { hr: "easy" } },
    ],
    purpose: "提高閾值",
    success: "每一趟都在配速範圍內",
    fallback: "改成 40 分鐘輕鬆跑",
  };
  const long = { kind: "long", title: "長跑", steps: [{ distance_km: 14, target: { pace: "E" } }], purpose: "耐力", success: "後半段配速不掉", fallback: "" };
  const kinds = [easy, threshold, { ...easy, title: "恢復跑", steps: [{ duration_min: 30, target: { hr: "easy" } }] }, long];
  // 剩下的日子比四天少時，從後面的課開始排（長跑一定在）
  const picked = kinds.slice(kinds.length - days.length);
  return {
    week_start: start,
    style: "fixed",
    reason: "範例：最近四週的量很穩定，這週只加一點長跑的距離。",
    outline: "- 下週：維持\n- 之後：每兩週加一點長跑，三月的半馬前三週減量",
    sessions: picked.map((s, i) => ({ ...s, date: days[i] })),
  };
}

/**
 * 把範例寫進 coach 的資料庫（要是記憶體裡的那個）：抓進 10 週的假跑步與恢復資料（不花 AI）、選手資料、
 * 一場半馬、這週的課表、最近兩趟的分析與一段範例對話
 */
export async function seedDemo(coach: Coach, source: ActivitySource): Promise<void> {
  const today = coach.today();
  await coach.importHistory();
  // 我的數字（閾值、區間、配速曲線）
  await refreshTrainingSnapshots(coach.db, source, { info: () => undefined, warn: () => undefined, error: () => undefined });
  await coach.refreshWellness(0);
  for (const [key, value] of Object.entries(DEMO_PROFILE)) await coach.db.setProfileKey(key, value);
  await coach.db.addRace({ name: "範例半馬", date: addDays(today, 120), distance_km: 21.1, target_time: "1:55:00", confirmed: 1 });
  const recent = await coach.db.getRecentWorkouts(14);
  for (const w of recent.slice(0, 2)) await coach.db.saveWorkoutSummary(w.id, DEMO_SUMMARY);
  const plan = demoPlan(today);
  const saved = await savePlanFromTool(coach.db, today, plan);
  // 檢查器有提醒時（範例的量和假資料對不上）照樣存：範例只是讓人看看長什麼樣子
  if (saved.startsWith("尚未儲存")) {
    await savePlanFromTool(coach.db, today, { ...plan, accept_warnings: true, warning_notes: "這是範例的課表" });
  }
  await coach.db.appendConversation("user", DEMO_QUESTION);
  await coach.db.appendConversation("assistant", DEMO_REPLY, ["課表", "最近的訓練"]);
}
