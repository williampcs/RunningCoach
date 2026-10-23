/**
 * Context Manager — 組合送入模型的五層 Context.
 *
 * 層1 — System Prompt（日期時區 + 選手資料 + 動態注入近期賽事）
 * 層2 — 訓練歷史摘要（由 get_recent_workouts tool 按需載入）
 * 層3 — 當前訓練計畫（由 get_training_plan tool 按需載入）
 * 層4 — 對話摘要（summaries 最新一筆，對話壓縮後產生）
 * 層5 — Rolling Window（conversations 中所有尚未壓縮的對話）
 */
import { otherActivitiesText } from "./activity-labels";
import { COACHING_METHOD } from "./coaching-method";
import { daysBetween, localDate, localTime, utcOffsetLabel, weekdayName } from "./dates";
import { analyzeRecovery, describeCheckin, describeWatch, RECOVERY_RULES } from "./recovery";
import { MEMORY_MAX_ITEMS, REPLY_EXCERPT_CHARS, type Db } from "./db";
import type { ChatMessage } from "./llm";
import { DEFAULT_PREFERENCES, preferenceText } from "./planning";
import { heartRateInfo, SNAPSHOT_RUN_SETTINGS, zonesText } from "./training-values";
import { guideTopics } from "./app-guide";
import type { CoachSettings, ConversationRow, Race, ReplyRef, RunSettings } from "./types";

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

/** 每次對話才取得、不在資料庫裡的資料 */
export interface ContextExtra {
  weather?: string | null;
}

function weatherLines(weather: string | null | undefined, shell: CoachSettings["shell"]): string[] {
  if (weather === undefined) {
    return [
      "沒有天氣資料（選手沒有設定天氣的城市）。選手問天氣時請他看天氣預報" +
        (shell === "web" ? "，或到「設定」的「天氣」設定城市，之後你就看得到約略的天氣。" : "。"),
    ];
  }
  return [
    weather ? `今天的天氣（Open-Meteo 的預報，約略）：${weather}` : "今天的天氣：這次取不到（需要時用 get_weather 再試）。",
    "【天氣】天氣只是約略的預報，給你評估用：濕熱（露點約 20°C 以上，或體感 32°C 以上）時配速放慢、以心率或體感為準、提醒補水，" +
      "可以建議清晨或傍晚跑；大雨、強風或空氣品質差時考慮降低強度、改室內或換天；天氣普通時不必提。" +
      "排未來幾天的課、或選手問某天適不適合跑時，用 get_weather 看預報。你不知道選手在哪個城市，也不要問或猜。",
  ];
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

  /**
   * extra.weather：今天的約略天氣（todayWeatherLine）；null 是設定了天氣但這次取不到，undefined 是沒有設定.
   * 這裡只拿到天氣的文字，不知道選手在哪裡
   */
  async buildSystemPrompt(extra: ContextExtra = {}): Promise<string> {
    const { timeZone } = this.settings;
    const now = this.now();
    const today = localDate(now, timeZone);
    const year = Number(today.slice(0, 4));

    const profile = await this.db.getProfile();
    const lines = [
      `今天日期：${today}（${weekdayName(today)}）` +
        `｜時區：${timeZone}（${utcOffsetLabel(now, timeZone)}）｜以星期一為一週的第一天`,
      // 沒有傳送時間時，模型會把前幾天訊息裡的「今天」「明天」當成今天說的
      "對話中選手每則訊息的開頭標有傳送時間，格式為 [日期（星期）時:分，今天／昨天／N 天前]。" +
        "訊息裡的「今天」「明天」「這週」以那則訊息的傳送時間為準；回覆時不要加上這種標記。",
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

    // 心率資料與區間：Intervals.icu 有閾值心率與區間時用它的（和它算的區間時間一致），
    // 否則依實測或推算的最大心率；填了但不是數字時不顯示，也不用推算值蓋掉使用者的輸入
    const runSettings = (await this.db.getSnapshot<RunSettings | null>(SNAPSHOT_RUN_SETTINGS))?.value ?? null;
    const hr = heartRateInfo(profile, runSettings, today);
    if (hr?.maxHr) {
      const label = hr.source === "estimate" ? "推算，220－年齡" : toInt(profile.max_hr) ? "實測" : "Intervals.icu 的設定";
      lines.push(`最大心率：${hr.maxHr}bpm（${label}）`);
    }
    const restingHr = toInt(profile.resting_hr);
    if (restingHr) lines.push(`靜息心率：${restingHr}bpm`);
    if (hr?.source === "intervals") {
      lines.push(`閾值心率：${hr.lthr}bpm（Intervals.icu 的設定）`);
      lines.push(`心率區間（Intervals.icu）：${zonesText(hr)}`);
    } else if (hr?.maxHr) {
      // 以整數百分比計算；v1 用浮點數相乘（180 × 0.7 = 125.99…）會讓區間邊界少 1
      const max = hr.maxHr;
      const [z1, z2, z3, z4] = [60, 70, 80, 90].map((pct) => Math.floor((max * pct) / 100));
      lines.push(`心率區間：Z1 <${z1}  Z2 ${z1}–${z2}  Z3 ${z2}–${z3}  Z4 ${z3}–${z4}  Z5 >${z4}`);
    }

    // 訓練偏好
    const prefs: string[] = [];
    if (profile.pref_long_run_day) prefs.push(`長跑日：${profile.pref_long_run_day}`);
    if (profile.pref_rest_days) prefs.push(`休息日：${profile.pref_rest_days}`);
    if (profile.pref_train_time) prefs.push(`偏好時段：${profile.pref_train_time}`);
    prefs.push(...preferenceText(profile));
    if (prefs.length) lines.push("訓練偏好：" + prefs.join("｜"));

    // 記住的事：選手要教練記住、或教練記下的長期有效的事
    const memories = await this.db.getMemories();
    lines.push("", "【記住的事】（每則回覆都要考慮；[id] 給 remember 與 forget 用）");
    if (memories.length) {
      for (const m of memories) {
        const date = localDate(new Date(Date.parse(m.updated_at) || 0), this.settings.timeZone);
        lines.push(`- [${m.id}] ${m.content}（${date}，${m.source === "user" ? "選手記的" : "教練記的"}）`);
      }
    } else {
      lines.push("（還沒有）");
    }
    lines.push(
      `選手說「記住…」，或提到長期有效、而選手資料欄位放不下的事（固定的行程限制、裝備、身體的習慣反應、喜歡或不喜歡的課）時，用 remember 記成一句話，並在回覆裡說「已記下：…」。` +
        "內容變了用 remember 帶 replace_id 改寫；過時的用 forget 刪掉並說明。" +
        "不要記一次性的事（今天的課、這次跑步的數據，那些已經有紀錄），也不要記選手資料欄位有的（目標、PB、傷病、偏好用 update_athlete_profile）。" +
        `最多 ${MEMORY_MAX_ITEMS} 條，滿了先和選手商量刪哪些。`,
      "選手提到之前聊過、但對話摘要與最近的對話裡沒有的事時，用 search_conversations 依日期或關鍵字找；「昨天」「上週」先依今天的日期換算成日期。",
      "選手的訊息開頭有「（回覆…）」時，表示他在回覆那一則；需要更多前後文時，用 search_conversations 查那一天的對話。",
    );

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

    // 最近兩天的其他運動（騎車、游泳、肌力訓練等）：不算跑量，但會累積疲勞
    const recentOthers = await this.db.getOtherActivities(1);
    if (recentOthers.length) {
      lines.push("", otherActivitiesText(recentOthers, "昨天與今天的其他運動（不算跑量，但會累積疲勞，排強度課時要考慮）："));
    }

    // 今日身體狀況：選手自評與手錶的恢復資料；都沒有時不加，避免多餘的提示
    const [wellness, checkins] = await Promise.all([this.db.getWellness(36), this.db.getCheckins(1)]);
    const recovery = analyzeRecovery(wellness, checkins, today);
    const watchLine = describeWatch(recovery);
    if (recovery.checkin || watchLine) {
      lines.push("", "今日身體狀況：");
      lines.push(
        recovery.checkin
          ? `・選手自評：${describeCheckin(recovery.checkin)}`
          : "・選手今天還沒自評；需要判斷能不能練時，先問今天的精神、痠痛與睡眠",
      );
      if (watchLine) {
        // 手錶早上同步之前，最新的是昨天的資料：寫明，教練才不會當成今天的
        const date = recovery.latest!.date;
        lines.push(`・手錶（${date}，${date === today ? "今天" : "昨天的資料"}）：${watchLine}`);
      }
      lines.push(`【身體狀況的判讀】${RECOVERY_RULES}需要更多天的資料時呼叫 get_recovery_status。`);
    }

    lines.push("", ...weatherLines(extra.weather, this.settings.shell));

    lines.push(
      "",
      "請根據選手資料給予個人化的跑步訓練建議。回應使用繁體中文。",
      "",
      COACHING_METHOD,
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
      "get_training_values — 以下情況請主動呼叫：",
      "・制定或調整課表，或給配速、心率目標時",
      "・討論訓練強度、強度分配（80/20）、跑量或負荷時",
      "一般閒聊、賽事管理、個人資料更新等情況不需要呼叫以上三個 tool。",
      "",
      "【排課表】",
      "排課前先看選手的訓練偏好（目標、強度、每週次數、每次最多多久、固定或彈性）；沒有的先問，" +
        `選手不想回答時用預設（${DEFAULT_PREFERENCES}），並用 update_athlete_profile 記下。` +
        "用 save_training_plan 存成一堂一堂的課，目標寫代號；選手說太累、沒空或想改輕鬆時，用 update_planned_session 調整，並說明改了什麼。",
      "",
      "【數值與依據】",
      "課表與建議中的配速與心率一律用 get_training_values 的數值，不要自己推算。" +
        "給建議時附上一兩個依據（工具給的數字、選手回報的感受、賽事日期），例如「這週已跑 42 km，比前三週平均多 25%」。" +
        "依據是推算、可能低估或資料不完整時，要跟選手說，並說明怎麼讓數值更準（例如回報比賽成績、做一次計時跑、在 Intervals.icu 設定閾值）。" +
        "缺的資料不要猜：沒有心率時改看配速與體感。要改之前的建議或課表時，先說之前怎麼安排、這次為什麼改。",
      "",
      "【跑後回報】",
      "當使用者是在回報一次剛完成的跑步（例如「剛跑完 8K，體感 7/10，腿有點重」），" +
        "先呼叫 fetch_latest_activity 取得客觀數據。",
      "只是詢問訓練、心率或傷痛等問題，沒有回報這次跑步時，不需要呼叫。",
      "取得 Intervals.icu 資料後：",
      "・若活動日期 = 今天 → 呼叫 save_workout 合併主客觀資料並生成分析",
      "・若活動日期 ≠ 今天（手錶尚未同步至 Intervals.icu）→ 呼叫 save_pending_subjective 暫存主觀感受，" +
        (this.settings.shell === "web"
          ? "並告知使用者等手錶上傳到 Intervals.icu 後，到「跑後回報」按「同步最近 14 天」完成合併"
          : "並告知使用者手錶同步後輸入 /sync 完成合併"),
      "",
      "【App 的使用方式】",
      `選手問 App 怎麼用（某個分頁、按鈕、設定、同步或資料存在哪裡）時，先用 get_app_help 查，不要憑印象回答；只回答選手問的部分，${
        this.settings.shell === "web" ? "最後附上工具給的說明頁連結。" : "需要時說明網頁版的做法不同。"
      }可查的主題：${guideTopics(this.settings.shell)}`,
    );
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // 組合 Context
  // ---------------------------------------------------------------------------

  /**
   * 訊息的傳送時間，以選手的時區表示，例：[2026-10-09（星期五）21:30，昨天]。
   * today 為 null 時不加「昨天」這類相對說法（對話摘要會保留很多天）。時間無法解析時為 null。
   */
  messageTime(row: ConversationRow, today: string | null): string | null {
    const ms = row.timestamp ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(ms)) return null;
    const sent = new Date(ms);
    const date = localDate(sent, this.settings.timeZone);
    const ago = today === null ? -1 : daysBetween(date, today);
    const relative = ago === 0 ? "今天" : ago === 1 ? "昨天" : ago > 1 ? `${ago} 天前` : null;
    return `[${date}（${weekdayName(date)}）${localTime(sent, this.settings.timeZone)}${relative ? `，${relative}` : ""}]`;
  }

  /** 較早的訊息超過單則字元上限時截斷，標記附上 id，模型需要時以 get_full_message 讀取全文 */
  private truncate(row: ConversationRow): string {
    const limit = this.settings.conversationMsgMaxChars;
    if (row.content.length <= limit) return row.content;
    return (
      row.content.slice(0, limit) +
      `…（訊息過長，只帶入前 ${limit} 字；需要完整內容時以 get_full_message 讀取，message_id=${row.id}）`
    );
  }

  async getContextForApi(extra: ContextExtra = {}): Promise<ApiContext> {
    const system = await this.buildSystemPrompt(extra);
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
    // 最新的幾則完整帶入：剛送出的訊息已先存進資料庫，也在其中；較早的超長訊息才截斷。
    // 選手的訊息開頭加上傳送時間。教練的回覆不加：回覆緊接在選手的訊息之後，
    // 而且模型看到自己的回覆帶標記，會在新的回覆也加上
    const today = localDate(this.now(), this.settings.timeZone);
    const fullFrom = conversations.length - this.settings.conversationFullRecent;
    for (const [i, row] of conversations.entries()) {
      const body = i >= fullFrom ? row.content : this.truncate(row);
      const sentAt = row.role === "user" ? this.messageTime(row, today) : null;
      const quoted = row.role === "user" && row.reply_to ? this.replyText(row.reply_to, today) : null;
      const content = [sentAt, quoted, body].filter(Boolean).join("\n");
      layerChars.layer5 += content.length;
      messages.push({ role: row.role, content });
    }

    return { system, messages, layerChars };
  }

  /** 回覆的那一則：例「（回覆 [2026-10-18（星期六）21:30，5 天前] 教練的訊息：「…」）」 */
  replyText(reply: ReplyRef, today: string | null): string {
    const when = this.messageTime({ id: 0, role: reply.role, content: "", timestamp: reply.timestamp }, today);
    const who = reply.role === "user" ? "自己" : "教練";
    const text = reply.text.length >= REPLY_EXCERPT_CHARS ? `${reply.text}…` : reply.text;
    return `（回覆${when ? ` ${when}` : ""} ${who}的訊息：「${text}」）`;
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
