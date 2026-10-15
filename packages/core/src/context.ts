/**
 * Context Manager — 組合送入模型的五層 Context.
 *
 * 層1 — System Prompt（日期時區 + 選手資料 + 動態注入近期賽事）
 * 層2 — 訓練歷史摘要（由 get_recent_workouts tool 按需載入）
 * 層3 — 當前訓練計畫（由 get_training_plan tool 按需載入）
 * 層4 — 對話摘要（summaries 最新一筆，對話壓縮後產生）
 * 層5 — Rolling Window（conversations 中所有尚未壓縮的對話）
 */
import { daysBetween, localDate, utcOffsetLabel, weekdayName } from "./dates";
import type { Db } from "./db";
import type { ChatMessage } from "./llm";
import type { CoachSettings, ConversationRow, Race } from "./types";

/** get_recent_workouts tool 的預設查詢天數 */
export const RECENT_WORKOUT_DAYS = 14;

const PB_LABELS: [string, string][] = [
  ["pb_5k", "5km"],
  ["pb_10k", "10km"],
  ["pb_half", "半馬"],
  ["pb_full", "全馬"],
];

export interface LayerChars {
  layer1: number;
  layer4: number;
  layer5: number;
}

export interface ApiContext {
  system: string;
  messages: ChatMessage[];
  /** 各層字元數，供 token 用量估算 */
  layerChars: LayerChars;
}

export interface StatusSummary {
  profileKeys: number;
  upcomingRaces: number;
  unrecordedRaces: number;
  recentWorkouts: number;
  totalWorkouts: number;
  pendingSubjective: number;
  trainingPlanLabel: string | null;
  convSummaryChars: number;
  conversationCount: number;
  conversationMax: number;
}

/** 純整數字串才視為數字（與 v1 的 int() 行為一致，轉換失敗時略過該欄位） */
function toInt(value: string | undefined): number | null {
  return value !== undefined && /^\s*-?\d+\s*$/.test(value) ? Number(value) : null;
}

function targetLabel(race: Race): string {
  return race.target_time ? `｜目標 ${race.target_time}` : "｜目標完賽";
}

export class ContextManager {
  constructor(
    private readonly db: Db,
    private readonly settings: CoachSettings,
    private readonly now: () => Date,
  ) {}

  // ---------------------------------------------------------------------------
  // 層1：System Prompt
  // ---------------------------------------------------------------------------

  async buildSystemPrompt(): Promise<string> {
    const { timeZone } = this.settings;
    const now = this.now();
    const today = localDate(now, timeZone);
    const year = Number(today.slice(0, 4));

    const profile = await this.db.getProfile();
    const lines = [
      `今天日期：${today}（${weekdayName(today)}）` +
        `｜時區：${timeZone}（${utcOffsetLabel(now, timeZone)}）｜以星期一為一週的第一天`,
      "",
      "你是一位專業跑步教練，以下是選手資料：",
      "",
    ];

    if (profile.goal_long_term) lines.push(`長期目標：${profile.goal_long_term}`);

    const pbs = PB_LABELS.filter(([key]) => key in profile).map(([key, label]) => `${label} ${profile[key]}`);
    if (pbs.length) lines.push(`個人最佳：${pbs.join(" / ")}`);

    if (profile.injuries) lines.push(`傷病注意：${profile.injuries}`);
    if (profile.weekly_km_target) lines.push(`每週目標里程：${profile.weekly_km_target}km`);

    // 生理資料
    const birthYear = toInt(profile.birth_year);
    const age = birthYear !== null ? year - birthYear : null;
    const phys: string[] = [];
    if (profile.gender) phys.push(`性別：${profile.gender}`);
    if (age !== null) phys.push(`年齡：${age}歲`);
    if (profile.height_cm) phys.push(`身高：${profile.height_cm}cm`);
    if (profile.weight_kg) phys.push(`體重：${profile.weight_kg}kg`);
    if (profile.body_fat_pct) phys.push(`體脂：${profile.body_fat_pct}%`);
    if (phys.length) lines.push("生理資料：" + phys.join("｜"));

    // 心率資料與區間
    let maxHr: number | null = null;
    if (profile.max_hr) {
      // 填了但不是數字時不顯示，也不用推算值蓋掉使用者的輸入
      maxHr = toInt(profile.max_hr);
      if (maxHr) lines.push(`最大心率：${maxHr}bpm（實測）`);
    } else if (age !== null) {
      maxHr = 220 - age;
      lines.push(`最大心率：${maxHr}bpm（推算，220－年齡）`);
    }
    const restingHr = toInt(profile.resting_hr);
    if (restingHr) lines.push(`靜息心率：${restingHr}bpm`);
    if (maxHr) {
      // 以整數百分比計算；v1 用浮點數相乘（180 × 0.7 = 125.99…）會讓區間邊界少 1
      const hr = maxHr;
      const [z1, z2, z3, z4] = [60, 70, 80, 90].map((pct) => Math.floor((hr * pct) / 100));
      lines.push(`心率區間：Z1 <${z1}  Z2 ${z1}–${z2}  Z3 ${z2}–${z3}  Z4 ${z3}–${z4}  Z5 >${z4}`);
    }

    // 訓練偏好
    const prefs: string[] = [];
    if (profile.pref_long_run_day) prefs.push(`長跑日：${profile.pref_long_run_day}`);
    if (profile.pref_rest_days) prefs.push(`休息日：${profile.pref_rest_days}`);
    if (profile.pref_train_time) prefs.push(`偏好時段：${profile.pref_train_time}`);
    if (prefs.length) lines.push("訓練偏好：" + prefs.join("｜"));

    // 動態注入近期賽事（距今 N 天內）
    const races = await this.db.getUpcomingRaces(this.settings.raceLookaheadDays);
    if (races.length) {
      lines.push("", "近期目標賽事：");
      for (const r of races) {
        const status = r.confirmed ? "已確認報名" : "考慮中";
        lines.push(
          `- [${r.id}] ${r.date} ${r.name} ${r.distance_km}km` +
            `${targetLabel(r)}｜距今 ${daysBetween(today, r.date)} 天（${status}）`,
        );
      }
    }

    // 已結束、尚未記錄成績的賽事（保留 N 天，讓賽後隔幾天回報成績時仍取得到 id）
    const pastRaces = await this.db.getPastRacesWithoutResult(this.settings.raceLookbackDays);
    if (pastRaces.length) {
      lines.push("", "待記錄成績的賽事（已結束、尚未回報成績）：");
      for (const r of pastRaces) {
        lines.push(
          `- [${r.id}] ${r.date} ${r.name} ${r.distance_km}km${targetLabel(r)}｜${daysBetween(r.date, today)} 天前`,
        );
      }
    }

    lines.push(
      "",
      "請根據選手資料給予個人化的跑步訓練建議。回應使用繁體中文。",
      "",
      "【訓練歷史載入時機】",
      "以下情況請主動呼叫 get_recent_workouts 取得訓練歷史與分析摘要：",
      "・進行跑後回饋分析（save_workout 後）",
      "・討論訓練狀態、疲勞程度、體能趨勢",
      "・使用者詢問過去訓練內容或表現",
      "get_training_plan — 以下情況請主動呼叫：",
      "・制定、調整或審視訓練計畫",
      "・需要確認本週計畫安排或訓練目標時",
      "・與當前計畫進行對比分析時",
      "一般閒聊、賽事管理、個人資料更新等情況不需要呼叫以上兩個 tool。",
      "",
      "【跑後回報】",
      "當使用者是在回報一次剛完成的跑步（例如「剛跑完 8K，體感 7/10，腿有點重」），" +
        "先呼叫 fetch_latest_activity 取得客觀數據。",
      "只是詢問訓練、心率或傷痛等問題，沒有回報這次跑步時，不需要呼叫。",
      "取得 Intervals.icu 資料後：",
      "・若活動日期 = 今天 → 呼叫 save_workout 合併主客觀資料並生成分析",
      "・若活動日期 ≠ 今天（手錶尚未同步至 Intervals.icu）→ 呼叫 save_pending_subjective 暫存主觀感受，" +
        "並告知使用者手錶同步後輸入 /sync 完成合併",
    );
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // 組合 Context
  // ---------------------------------------------------------------------------

  /** 較早的訊息超過單則字元上限時截斷，標記附上 id，模型需要時以 get_full_message 讀取全文 */
  private truncate(row: ConversationRow): string {
    const limit = this.settings.conversationMsgMaxChars;
    if (row.content.length <= limit) return row.content;
    return (
      row.content.slice(0, limit) +
      `…（訊息過長，只帶入前 ${limit} 字；需要完整內容時以 get_full_message 讀取，message_id=${row.id}）`
    );
  }

  async getContextForApi(): Promise<ApiContext> {
    const system = await this.buildSystemPrompt();
    const messages: ChatMessage[] = [];
    const layerChars: LayerChars = { layer1: system.length, layer4: 0, layer5: 0 };

    // 已壓縮的對話會從 DB 刪除，因此帶入全部剩餘對話即可與層4摘要無縫銜接；
    // 若只取最近 KEEP 筆，KEEP~MAX 之間的訊息會既不在視窗也不在摘要中。
    // 上限 MAX*2 為保險：壓縮持續失敗時避免 context 無限增長。
    const { summary, conversations } = await this.db.getMemorySnapshot(this.settings.conversationMax * 2);

    // 層4 — 對話摘要（壓縮後的歷史重點）
    if (summary) {
      const content = `以下是之前對話的重點摘要：\n\n${summary.content}`;
      layerChars.layer4 = content.length;
      messages.push({ role: "user", content });
      messages.push({ role: "assistant", content: "已閱讀對話摘要，我會記住這些重要資訊。" });
    }

    // 層5 — Rolling Window（所有尚未壓縮的原始對話）。
    // 最新的幾則完整帶入：剛送出的訊息已先存進資料庫，也在其中；較早的超長訊息才截斷
    const fullFrom = conversations.length - this.settings.conversationFullRecent;
    for (const [i, row] of conversations.entries()) {
      const content = i >= fullFrom ? row.content : this.truncate(row);
      layerChars.layer5 += content.length;
      messages.push({ role: row.role, content });
    }

    return { system, messages, layerChars };
  }

  // ---------------------------------------------------------------------------
  // 壓縮相關
  // ---------------------------------------------------------------------------

  async shouldCompress(): Promise<boolean> {
    return (await this.db.countConversations()) > this.settings.conversationMax;
  }

  /** 應被壓縮的舊對話（最舊的 total − KEEP 筆） */
  async getConversationsToCompress(): Promise<ConversationRow[]> {
    const compressCount = (await this.db.countConversations()) - this.settings.conversationKeep;
    return compressCount > 0 ? this.db.getOldestConversations(compressCount) : [];
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /** 層1、層4、層5 每次都帶入 context；層2、層3 由 tool 按需載入，這裡只回報 DB 中的資料量 */
  async getStatusSummary(): Promise<StatusSummary> {
    const plan = await this.db.getActiveTrainingPlan();
    const summary = await this.db.getLatestSummary();
    return {
      profileKeys: Object.keys(await this.db.getProfile()).length,
      upcomingRaces: (await this.db.getUpcomingRaces(this.settings.raceLookaheadDays)).length,
      unrecordedRaces: (await this.db.getPastRacesWithoutResult(this.settings.raceLookbackDays)).length,
      recentWorkouts: await this.db.countWorkouts(RECENT_WORKOUT_DAYS),
      totalWorkouts: await this.db.countWorkouts(),
      pendingSubjective: await this.db.countPendingSubjective(),
      trainingPlanLabel: plan?.week_label ?? null,
      convSummaryChars: summary?.content.length ?? 0,
      conversationCount: await this.db.countConversations(),
      conversationMax: this.settings.conversationMax,
    };
  }
}
