/** 主對話可用的工具：定義（供模型呼叫）與執行器. */
import { RECENT_WORKOUT_DAYS } from "./context";
import { addDays, isoWeekLabel, localDate, localDayStartUtc, localTime, weekdayName } from "./dates";
import { heartRateText } from "./format";
import { describeCheckin, formatRecoveryReport, recoveryNoteFor } from "./recovery";
import { changeSession, planNoteFor, planTextForTool, savePlanFromTool, type SessionAction } from "./planning";
import { computeTrainingValues, formatTrainingValues } from "./training-values";
import { MEMORY_MAX_CHARS, type Db, type RaceUpdate } from "./db";
import type { Llm, ToolDef } from "./llm";
import { otherActivitiesText } from "./activity-labels";
import type { Activity, ActivitySource, CoachSettings, Logger, Race } from "./types";

const RACE_ID_HINT =
  "race_id 為 system prompt 賽事清單（近期目標賽事、待記錄成績的賽事）中方括號內的數字；" +
  "清單中沒有該賽事時，再用 get_upcoming_races（可加大 days）查詢。";

/** 恢復狀況的判讀要和前幾天比較，查詢時多取幾天的手錶資料 */
const BASELINE_EXTRA_DAYS = 35;

/** search_conversations 最多回傳幾則、每則帶入多少字 */
const SEARCH_MAX = 20;
const SEARCH_EXCERPT = 200;

/** get_full_message 一次最多回傳的字數，避免貼上的超長內容撐爆單次請求 */
const FULL_MESSAGE_MAX_CHARS = 20_000;

export function buildTools(settings: CoachSettings): ToolDef[] {
  return [
    {
      name: "add_race",
      description:
        "新增目標賽事至 races table。" + "使用者說「我報名了 OOO 比賽」或「幫我記下 OOO 賽事」時呼叫。",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "賽事名稱，例：2026 萬金石馬拉松" },
          date: { type: "string", description: "比賽日期，ISO 格式 YYYY-MM-DD" },
          distance_km: { type: "number", description: "距離（公里），例：21.1" },
          target_time: { type: "string", description: "目標完賽時間，例：1:58:00。無具體目標時留空" },
          confirmed: { type: "integer", description: "1=已確認報名（預設），0=考慮中" },
          notes: { type: "string", description: "其他備注，例：山路賽，需練習爬坡" },
        },
        required: ["name", "date", "distance_km"],
      },
    },
    {
      name: "get_upcoming_races",
      description:
        "查詢距今 N 天內的賽事清單，並附上最近已結束、尚未記錄成績的賽事。" +
        "使用者詢問「我最近有什麼比賽」或需要列出賽事時呼叫。",
      input_schema: {
        type: "object",
        properties: {
          days: { type: "integer", description: `查詢範圍天數，預設 ${settings.raceLookaheadDays}` },
        },
        required: [],
      },
    },
    {
      name: "update_race_result",
      description: "更新賽事實際完賽時間與備注。" + "賽後使用者回報成績時呼叫。" + RACE_ID_HINT,
      input_schema: {
        type: "object",
        properties: {
          race_id: { type: "integer", description: "races table 的 id" },
          result_time: { type: "string", description: "實際完賽時間，例：1:55:30" },
          notes: { type: "string", description: "賽後備注，例：後半段配速不錯" },
        },
        required: ["race_id", "result_time"],
      },
    },
    {
      name: "update_athlete_profile",
      description:
        "更新選手固定資料（目標、PB、傷病、生理數據、訓練偏好等）。" +
        "使用者提供或更新個人資料、PB 有新紀錄、或提到生理數據與訓練偏好時呼叫。",
      input_schema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "資料欄位名稱，可用值：\n" +
              "・核心：goal_long_term、weekly_km_target、injuries\n" +
              "・PB：pb_5k、pb_10k、pb_half、pb_full\n" +
              "・生理：gender、birth_year、height_cm、weight_kg、" +
              "body_fat_pct、max_hr、resting_hr\n" +
              "・訓練偏好：pref_long_run_day、pref_rest_days、pref_train_time、" +
              "pref_goal（health 只想運動／speed 練速度／distance 加強長距離／race 準備比賽）、" +
              "pref_intensity（easy 輕鬆就好／moderate 適度／challenge 想要挑戰）、" +
              "pref_runs_per_week（每週最多幾次，整數）、pref_max_minutes（每次最多幾分鐘，整數）、" +
              "pref_schedule（fixed 固定／flexible 彈性）、pref_other（其他會做的運動，例：騎車、重訓）",
          },
          value: { type: "string", description: "欄位值" },
        },
        required: ["key", "value"],
      },
    },
    {
      name: "save_training_plan",
      description:
        "儲存一週的結構化課表（會停用舊計畫）。存檔前由程式依教練方法檢查；有問題時不存，回傳問題，" +
        "請修改，或設 accept_warnings=true 並在 warning_notes 寫理由再存。目標一律寫代號，由程式依訓練數值換算成配速或心率。",
      input_schema: {
        type: "object",
        properties: {
          week_start: { type: "string", description: "這週的星期一 YYYY-MM-DD；不是星期一時以那週的星期一為準" },
          style: { type: "string", enum: ["fixed", "flexible"], description: "fixed 照星期排（每堂要有日期）；flexible 一週的菜單（date 可以不填）" },
          reason: { type: "string", description: "這次排或改課表的原因（會保存並顯示給選手）" },
          sessions: {
            type: "array",
            description: "這週的每一堂課",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "YYYY-MM-DD；flexible 可以不填" },
                kind: {
                  type: "string",
                  enum: ["easy", "long", "marathon", "threshold", "interval", "repetition", "rest", "cross", "strength", "race"],
                  description: "cross 交叉訓練（騎車、游泳等）、strength 肌力訓練：steps 寫時間，動作寫在 note",
                },
                title: { type: "string", description: "簡短的標題，例：5×1 km 閾值" },
                steps: {
                  type: "array",
                  description:
                    "依序的步驟。一步：{distance_km 或 duration_min, target?, note?}；重複組：{repeat: 次數, steps: [...]}。" +
                    'target 寫代號：{"pace":"E|M|T|I|R"}、{"hr":"easy"}（輕鬆跑的心率上限）、{"zone":"Z2"}、{"rpe":[6,7]}',
                  items: { type: "object" },
                },
                purpose: { type: "string", description: "這堂課的目的" },
                success: { type: "string", description: "完成的標準，例：心率不超過輕鬆跑上限、最後一趟仍能保持配速" },
                fallback: { type: "string", description: "狀況不好時的替代，例：改成 40 分鐘輕鬆跑；強度課一定要有" },
              },
              required: ["kind", "title", "steps", "purpose", "success"],
            },
          },
          outline: { type: "string", description: "往後幾週的週期大綱（文字）" },
          accept_warnings: { type: "boolean", description: "檢查器有提醒、但有理由保留時設 true" },
          warning_notes: { type: "string", description: "保留的理由（accept_warnings=true 時必填）" },
        },
        required: ["style", "reason", "sessions"],
      },
    },
    {
      name: "update_planned_session",
      description:
        "調整目前課表中的一堂課：移到這週的別天、跳過、改用替代的課，或恢復原本的課。" +
        "選手說某天沒空、太累、想改輕鬆一點時呼叫；調整後會重新檢查整週。大幅修改時用 save_training_plan 重排。",
      input_schema: {
        type: "object",
        properties: {
          session_id: { type: "integer", description: "get_training_plan 列出的 session_id" },
          action: { type: "string", enum: ["move", "skip", "fallback", "restore"] },
          date: { type: "string", description: "move 時的新日期 YYYY-MM-DD" },
          reason: { type: "string", description: "調整的原因" },
        },
        required: ["session_id", "action", "reason"],
      },
    },
    {
      name: "fetch_latest_activity",
      description:
        "從 Intervals.icu 拉取最新一筆跑步活動（基本資料，不含 laps/streams）。" +
        "偵測到跑後回報意圖時呼叫，用於驗證日期是否為今天。",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "save_workout",
      description:
        "合併客觀活動資料（來自 fetch_latest_activity 的快取）" +
        "與使用者輸入的主觀感受，存入 workouts table 並生成 AI 分析摘要。" +
        "須在 fetch_latest_activity 確認日期為今天後才呼叫。",
      input_schema: {
        type: "object",
        properties: {
          perceived_effort: { type: "integer", description: "體感強度 1-10" },
          subjective_notes: { type: "string", description: "主觀感受，例：腿有點重，呼吸順，右膝無異狀" },
        },
        required: ["perceived_effort"],
      },
    },
    {
      name: "save_pending_subjective",
      description:
        "將主觀感受暫存至 pending_subjective table。" +
        "當手錶活動尚未同步至 Intervals.icu 時呼叫，使用者之後執行 /sync 時自動合併。",
      input_schema: {
        type: "object",
        properties: {
          date: { type: "string", description: "跑步日期 YYYY-MM-DD，通常是今天" },
          perceived_effort: { type: "integer", description: "體感強度 1-10" },
          subjective_notes: { type: "string", description: "主觀感受" },
        },
        required: ["date", "perceived_effort"],
      },
    },
    {
      name: "get_recent_workouts",
      description:
        "取得最近 N 天的訓練紀錄，包含客觀數據、主觀感受與 AI 分析摘要。" +
        "以下情況應主動呼叫：進行跑後分析（save_workout 後）、討論訓練狀態或疲勞、" +
        "制定或調整訓練計畫、使用者詢問過去訓練表現。" +
        "賽事管理、個人資料更新、一般閒聊等不需要呼叫。",
      input_schema: {
        type: "object",
        properties: {
          days: { type: "integer", description: `查詢天數，預設 ${RECENT_WORKOUT_DAYS}` },
        },
        required: [],
      },
    },
    {
      name: "get_pace_trend",
      description: "計算過去 N 週的週平均配速，用於趨勢分析。" + "使用者詢問「配速有沒有進步」時呼叫。",
      input_schema: {
        type: "object",
        properties: {
          weeks: { type: "integer", description: "查詢週數，預設 4" },
        },
        required: [],
      },
    },
    {
      name: "get_training_plan",
      description:
        "取得目前啟用中的訓練計畫內容。" +
        "以下情況應主動呼叫：制定、調整或審視訓練計畫；確認本週訓練安排；" +
        "將跑後表現與計畫目標對比時。賽事管理、閒聊等不需要呼叫。",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_training_values",
      description:
        "取得由程式計算的訓練數值與依據：心率區間與輕鬆跑的心率上限、Daniels 的配速（E/M/T/I/R）與推算的完賽時間、" +
        "臨界速度、最近幾週的跑量與負荷、最近 28 天的強度分配（80/20）、體能與疲勞，以及資料的完整度。" +
        "制定或調整課表、給配速或心率目標、討論訓練強度或負荷時呼叫；課表裡的數字一律用這裡的，不要自己推算。",
      input_schema: {
        type: "object",
        properties: { weeks: { type: "integer", description: "列出最近幾週的量，預設 4，最多 12" } },
        required: [],
      },
    },
    {
      name: "get_recovery_status",
      description:
        "取得最近幾天的恢復狀況：手錶的靜息心率、HRV、睡眠，以及選手每天的自評（精神、痠痛、睡眠）。" +
        "討論疲勞、恢復、今天能不能練或要不要調整課表時呼叫。手錶數據只是參考，與選手的自評不一致時以選手的感受為主。",
      input_schema: {
        type: "object",
        properties: { days: { type: "integer", description: "查詢天數，預設 7，最多 28" } },
        required: [],
      },
    },
    {
      name: "save_daily_checkin",
      description:
        "記錄選手今天的身體狀況自評。選手在對話中描述今天的精神、疲勞、痠痛或睡眠時呼叫；" +
        "依描述換算成 1–5 分，無法判斷的項目先詢問，不要猜。同一天再次記錄會覆蓋。",
      input_schema: {
        type: "object",
        properties: {
          energy: { type: "integer", description: "精神：1 很差 – 5 很好" },
          soreness: { type: "integer", description: "痠痛：1 沒有 – 5 很痠" },
          sleep: { type: "integer", description: "睡眠：1 很差 – 5 很好" },
          notes: { type: "string", description: "選手的原話或補充，例：右小腿緊" },
        },
        required: ["energy", "soreness", "sleep"],
      },
    },
    {
      name: "get_full_message",
      description:
        "讀取對話紀錄中一則訊息的完整內容。較早的長訊息在對話中只帶入前段，並標示 message_id；" +
        "需要後面的內容時才呼叫，例如使用者先前貼上的長文、你先前較長回覆中的某一點。" +
        "已整理成對話摘要的訊息也讀得到（message_id 可以從 search_conversations 取得）。",
      input_schema: {
        type: "object",
        properties: { message_id: { type: "integer", description: "截斷標記中的 message_id" } },
        required: ["message_id"],
      },
    },
    {
      name: "search_conversations",
      description:
        "找較早的對話（包括已整理成對話摘要的原文）。選手提到之前聊過、但對話摘要與最近的對話裡沒有的事時呼叫。" +
        "至少給一個條件：from、to（當地日期，「昨天」「上週」先依今天的日期換算）或 keyword（內容包含的字）。" +
        "回傳每則的 message_id、時間與前段文字；需要全文時用 get_full_message。",
      input_schema: {
        type: "object",
        properties: {
          from: { type: "string", description: "從哪一天（含），YYYY-MM-DD" },
          to: { type: "string", description: "到哪一天（含），YYYY-MM-DD" },
          keyword: { type: "string", description: "內容包含的字，例：小腿、間歇；一次一個詞" },
          limit: { type: "integer", description: `最多幾則，預設 10，最多 ${SEARCH_MAX}` },
        },
        required: [],
      },
    },
    {
      name: "remember",
      description:
        "記下一件要長期記住的事（每次對話都會帶給你，選手在「選手資料」頁看得到、改得了）。" +
        "選手說「記住…」，或提到長期有效、選手資料欄位放不下的事時呼叫；記完要在回覆裡說「已記下：…」。" +
        "給 replace_id 時改寫那一條。",
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", description: `一句話，${MEMORY_MAX_CHARS} 字以內，例：週三晚上要接小孩，不能練` },
          replace_id: { type: "integer", description: "要改寫的那一條的 id（【記住的事】裡的 [id]）" },
        },
        required: ["content"],
      },
    },
    {
      name: "forget",
      description: "刪掉一條已經過時或選手要你忘記的「記住的事」；刪完要在回覆裡說明。",
      input_schema: {
        type: "object",
        properties: { memory_id: { type: "integer", description: "【記住的事】裡的 [id]" } },
        required: ["memory_id"],
      },
    },
    {
      name: "update_race",
      description:
        "修改已存在賽事的內容（名稱、日期、距離、目標時間、報名狀態、備注）。" +
        "使用者說「把 OOO 目標改成 XXX」或「OOO 改期了」時呼叫。" +
        RACE_ID_HINT +
        "只需傳入要更新的欄位。",
      input_schema: {
        type: "object",
        properties: {
          race_id: { type: "integer", description: "races table 的 id" },
          name: { type: "string", description: "賽事名稱" },
          date: { type: "string", description: "比賽日期 YYYY-MM-DD" },
          distance_km: { type: "number", description: "距離（公里）" },
          target_time: { type: "string", description: "目標完賽時間，例：1:55:00" },
          confirmed: { type: "integer", description: "1=已確認報名，0=考慮中" },
          notes: { type: "string", description: "備注" },
        },
        required: ["race_id"],
      },
    },
    {
      name: "cancel_race",
      description:
        "將賽事標記為已取消（設定 cancelled=1，保留歷史紀錄，不刪除）。" +
        "使用者說「我退出 OOO」或「取消報名 OOO」時呼叫。" +
        RACE_ID_HINT,
      input_schema: {
        type: "object",
        properties: {
          race_id: { type: "integer", description: "races table 的 id" },
          notes: { type: "string", description: "取消原因（選填），例：傷病、時間衝突" },
        },
        required: ["race_id"],
      },
    },
  ];
}

/** 產生摘要用到的欄位；剛拉取的活動與已存檔的訓練都適用 */
export type WorkoutSummaryInput = Pick<
  Activity,
  "date" | "distance_km" | "duration_min" | "avg_pace" | "avg_hr" | "max_hr" | "elevation_m"
> & {
  perceived_effort: number | null;
  subjective_notes: string | null;
  /** 當天的身體狀況（recoveryNoteFor），沒有時不帶入 */
  recovery?: string | null;
  /** 這趟對應的課與程式的判斷（planNoteFor）；沒有結構化課表時不加 */
  plan?: string | null;
};

/** 生成 AI 跑步分析摘要 */
export async function generateWorkoutSummary(llm: Llm, workout: WorkoutSummaryInput): Promise<string> {
  const hasSubjective = workout.perceived_effort !== null && workout.perceived_effort !== undefined;
  const hasHeartRate = workout.avg_hr != null || workout.max_hr != null;
  const effortLine = hasSubjective
    ? `體感強度：${workout.perceived_effort}/10\n主觀感受：${workout.subjective_notes || "未記錄"}`
    : "體感資料：未記錄";
  const prompt =
    `請為以下跑步訓練生成一段簡潔分析摘要（150字以內，繁體中文）：\n\n` +
    `日期：${workout.date}\n` +
    `距離：${workout.distance_km}km\n` +
    `時長：${workout.duration_min}分鐘\n` +
    `配速：${workout.avg_pace || "未知"}\n` +
    (hasHeartRate
      ? `平均心率：${bpmOrMissing(workout.avg_hr)}\n最高心率：${bpmOrMissing(workout.max_hr)}\n`
      : "心率：沒有資料（只用手機記錄，或沒有配戴心率裝置）\n") +
    `爬升：${workout.elevation_m || 0}m\n` +
    `${effortLine}\n` +
    (workout.recovery ? `當天身體狀況：${workout.recovery}\n` : "") +
    (workout.plan ? `課表：${workout.plan}\n` : "") +
    // 網頁版以數字與圖顯示數據，摘要的第一行當結論顯示，其餘預設收起（規格 12.9）
    `\n格式：第一行是一句話的結論（例如「穩定的有氧跑，心率控制得很好」），不加標題、粗體，也不重複列出數據；` +
    `之後用 2–4 個條列說明。` +
    (hasSubjective ? "客觀數據與體感對比分析。" : "僅客觀數據，給出客觀評估。") +
    (hasHeartRate ? "" : "沒有心率資料：依配速、時長與體感評估，不要推測心率。") +
    (workout.recovery
      ? "可以參考當天的身體狀況解讀心率與體感；手錶的恢復數據只是參考，與選手的自評不一致時以選手的感受為主。"
      : "") +
    (workout.plan
      ? "對照課表說明這趟和計畫的差異；跑了不一樣的課或沒做完時，用「這次偏難／不一樣，下次怎麼調整」的說法，不要寫失敗。"
      : "");
  return (await llm.complete("summary", prompt, 2000)).text;
}

function bpmOrMissing(value: number | null | undefined): string {
  return value == null ? "未記錄" : `${value}bpm`;
}

function str(value: unknown, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

/** 與 v1 的 int() / float() 相同：無法轉換時丟出錯誤，由執行器回報「執行失敗」 */
function toNumber(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) {
    throw new Error(`${label} 不是有效的數字：${str(value)}`);
  }
  return n;
}

function toInt(value: unknown, label: string): number {
  return Math.trunc(toNumber(value, label));
}

function raceLine(r: Race): string {
  const target = r.target_time || "完賽即可";
  const result = r.result_time ? `｜實際成績：${r.result_time}` : "";
  return `- [id=${r.id}] ${r.date} ${r.name} ${r.distance_km}km 目標：${target}${result}`;
}

/** 回覆的依據：讀取資料的工具各對應一種說法；存檔、改賽事這類工具不算 */
const SOURCE_LABELS: Record<string, (input: Record<string, unknown>) => string> = {
  get_training_values: () => "訓練數值",
  get_recent_workouts: (input) => `最近 ${positiveInt(input.days) ?? RECENT_WORKOUT_DAYS} 天的訓練`,
  get_pace_trend: (input) => `最近 ${positiveInt(input.weeks) ?? 4} 週的配速`,
  get_training_plan: () => "目前的課表",
  get_recovery_status: (input) => `最近 ${Math.min(28, positiveInt(input.days) ?? 7)} 天的恢復狀況與自評`,
  fetch_latest_activity: () => "最新一筆跑步",
  fetch_latest_strava_activity: () => "最新一筆跑步",
  save_workout: () => "這次跑步的數據",
  get_upcoming_races: () => "賽事",
  get_full_message: () => "較早的對話",
  search_conversations: () => "較早的對話",
};

function positiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return value !== undefined && value !== null && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 這次回覆前讀過的資料，由實際呼叫成功的工具產生，不讓模型自己寫；同樣的說法只列一次。
 * 外殼顯示成「參考了：…」，讓選手知道建議根據什麼。
 */
export function sourcesOf(calls: { name: string; input: Record<string, unknown> }[]): string[] {
  const labels = calls.flatMap(({ name, input }) => (SOURCE_LABELS[name] ? [SOURCE_LABELS[name](input)] : []));
  return [...new Set(labels)];
}

/** 工具執行失敗時的回傳開頭（見 createToolExecutor） */
export const TOOL_FAILED_PREFIX = "執行失敗：";

export interface ToolExecutorDeps {
  db: Db;
  llm: Llm;
  activities: ActivitySource;
  settings: CoachSettings;
  today: () => string;
  logger: Logger;
}

export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<string>;

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  const { db, llm, activities, settings, today, logger } = deps;

  // 跑後回報流程中，暫存最近一次取回的跑步活動
  let activityCache: Activity | null = null;

  async function execute(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "fetch_latest_activity":
      case "fetch_latest_strava_activity": {
        const activity = await activities.fetchLatestActivity();
        if (!activity) return "Intervals.icu 上找不到跑步活動，請確認手錶已同步且 API Key 設定正確。";
        activityCache = activity;
        const dateNote =
          activity.date === today()
            ? "✅ 是今天的活動"
            : `⚠️ 活動日期為 ${activity.date}，非今天，手錶資料可能尚未同步至 Intervals.icu`;
        const loadNote = activity.training_load != null ? `｜負荷(Load)：${activity.training_load}` : "";
        return (
          `最新跑步活動：\n` +
          `日期：${activity.date}　${dateNote}\n` +
          `距離：${activity.distance_km}km｜時長：${activity.duration_min}分鐘\n` +
          `配速：${activity.avg_pace || "未知"}｜` +
          `心率：${heartRateText(activity.avg_hr, activity.max_hr, "未記錄") ?? "沒有資料"}\n` +
          `爬升：${activity.elevation_m || 0}m｜卡路里：${activity.calories || "未記錄"}${loadNote}`
        );
      }

      case "save_workout": {
        if (!activityCache) return "錯誤：請先呼叫 fetch_latest_activity 取得活動資料。";
        const activity = activityCache;
        const perceivedEffort =
          input.perceived_effort === undefined || input.perceived_effort === null
            ? null
            : toInt(input.perceived_effort, "perceived_effort");
        const subjectiveNotes = str(input.subjective_notes);
        const saved = await db.saveWorkoutChecked(activity, perceivedEffort, subjectiveNotes || null);
        if (saved.status === "duplicate") {
          activityCache = null;
          return `這筆活動和已存的訓練紀錄（id=${saved.id}）是同一趟（從不同來源上傳），已合併，不另外產生分析。`;
        }
        const workoutId = saved.id;
        const summary = await generateWorkoutSummary(llm, {
          ...activity,
          perceived_effort: perceivedEffort,
          subjective_notes: subjectiveNotes,
          recovery: await recoveryNoteFor(db, activity.date),
          plan: await planNoteFor(db, today(), workoutId),
        });
        await db.saveWorkoutSummary(workoutId, summary);
        activityCache = null;
        return `訓練紀錄已儲存（id=${workoutId}）。\n\n${summary}`;
      }

      case "save_pending_subjective": {
        const date = str(input.date);
        if (!date) throw new Error("缺少 date");
        await db.savePendingSubjective(
          date,
          toInt(input.perceived_effort, "perceived_effort"),
          str(input.subjective_notes),
        );
        return `主觀感受已暫存（${date}）。手錶同步至 Intervals.icu 後請執行 /sync 完成合併。`;
      }

      case "get_recent_workouts": {
        const days = toInt(input.days ?? RECENT_WORKOUT_DAYS, "days");
        const [workouts, others] = await Promise.all([db.getRecentWorkouts(days), db.getOtherActivities(days)]);
        if (!workouts.length && !others.length) return `最近 ${days} 天無訓練紀錄。`;
        const lines = [workouts.length ? `最近 ${days} 天的訓練紀錄（共 ${workouts.length} 筆）：` : `最近 ${days} 天沒有跑步。`];
        for (const w of workouts) {
          const subj = w.perceived_effort ? `｜體感 ${w.perceived_effort}/10` : "";
          lines.push(
            `\n【${w.date}】${w.distance_km}km｜${w.avg_pace ?? "?"}｜` +
              `${heartRateText(w.avg_hr, w.max_hr) ? `心率 ${heartRateText(w.avg_hr, w.max_hr)}` : "沒有心率"}${subj}`,
          );
          if (w.summary) lines.push(`  AI摘要：${w.summary}`);
        }
        if (others.length) lines.push("", otherActivitiesText(others));
        return lines.join("\n");
      }

      case "get_pace_trend": {
        const weeks = toInt(input.weeks ?? 4, "weeks");
        const records = await db.getWorkoutsForPaceTrend(weeks);
        if (!records.length) return `最近 ${weeks} 週無配速資料。`;
        // 依 ISO week 分組計算平均配速
        const weekly = new Map<string, number[]>();
        for (const r of records) {
          const match = /^(\d+):(\d+)/.exec(r.avg_pace);
          if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
          const week = isoWeekLabel(r.date);
          weekly.set(week, [...(weekly.get(week) ?? []), Number(match[1]) * 60 + Number(match[2])]);
        }
        const lines = [`過去 ${weeks} 週週平均配速：`];
        for (const week of [...weekly.keys()].sort()) {
          const paces = weekly.get(week)!;
          const avg = Math.floor(paces.reduce((a, b) => a + b, 0) / paces.length);
          lines.push(
            `  ${week}：${Math.floor(avg / 60)}:${String(avg % 60).padStart(2, "0")}/km（${paces.length} 筆）`,
          );
        }
        return lines.join("\n");
      }

      case "get_training_plan":
        return planTextForTool(db, today());

      case "get_training_values": {
        const weeks = Math.min(12, Math.max(1, input.weeks === undefined ? 4 : toInt(input.weeks, "weeks")));
        return formatTrainingValues(await computeTrainingValues(db, today(), weeks));
      }

      case "get_recovery_status": {
        const days = Math.min(28, Math.max(1, input.days === undefined ? 7 : toInt(input.days, "days")));
        const [wellness, checkins] = await Promise.all([db.getWellness(days + BASELINE_EXTRA_DAYS), db.getCheckins(days)]);
        return formatRecoveryReport(wellness, checkins, today(), days);
      }

      case "save_daily_checkin": {
        const score = (key: string) => {
          const value = toInt(input[key], key);
          if (value < 1 || value > 5) throw new Error(`${key} 必須是 1–5`);
          return value;
        };
        const checkin = {
          date: today(),
          energy: score("energy"),
          soreness: score("soreness"),
          sleep: score("sleep"),
          notes: str(input.notes).trim() || null,
        };
        await db.saveCheckin(checkin);
        return `已記錄今天（${checkin.date}）的身體狀況：${describeCheckin(checkin)}`;
      }

      case "get_full_message": {
        const id = toInt(input.message_id, "message_id");
        const row = await db.getConversation(id);
        if (!row) return `找不到 message_id=${id} 的訊息。`;
        const who = row.role === "user" ? "使用者" : "教練";
        const content =
          row.content.length > FULL_MESSAGE_MAX_CHARS
            ? row.content.slice(0, FULL_MESSAGE_MAX_CHARS) + `…（超過 ${FULL_MESSAGE_MAX_CHARS} 字，以下省略）`
            : row.content;
        return `訊息 ${id}（${who}）的完整內容：\n\n${content}`;
      }

      case "search_conversations": {
        const date = (key: "from" | "to") => {
          const value = str(input[key]).trim();
          if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${key} 要是 YYYY-MM-DD`);
          return value || null;
        };
        const [from, to] = [date("from"), date("to")];
        const keyword = str(input.keyword).trim().slice(0, 50);
        if (!from && !to && !keyword) throw new Error("至少要給 from、to 或 keyword");
        const limit = Math.min(SEARCH_MAX, positiveInt(input.limit) ?? 10);
        const tz = settings.timeZone;
        const rows = await db.searchConversations({
          fromUtc: from ? localDayStartUtc(from, tz) : undefined,
          toUtc: to ? localDayStartUtc(addDays(to, 1), tz) : undefined,
          keyword: keyword || undefined,
          limit: limit + 1,
        });
        if (!rows.length) return "找不到符合的對話。";
        const shown = rows.slice(-limit);
        const lines = shown.map((r) => {
          const at = r.timestamp ? new Date(Date.parse(r.timestamp)) : null;
          const when = at ? `${localDate(at, tz)}（${weekdayName(localDate(at, tz))}）${localTime(at, tz)}` : "";
          const text = r.content.length > SEARCH_EXCERPT ? `${r.content.slice(0, SEARCH_EXCERPT)}…` : r.content;
          return `[message_id=${r.id}] ${when} ${r.role === "user" ? "選手" : "教練"}：${text.replace(/\s+/g, " ")}`;
        });
        const more = rows.length > limit ? `（符合的超過 ${limit} 則，只列最新的；可以縮小日期或換關鍵字）\n` : "";
        return `找到的對話（舊的在前）：\n${more}${lines.join("\n")}`;
      }

      case "remember": {
        const content = str(input.content);
        if (input.replace_id !== undefined && input.replace_id !== null) {
          const id = toInt(input.replace_id, "replace_id");
          if (!(await db.updateMemory(id, content))) throw new Error(`找不到 id=${id} 的記住的事`);
          return `已改寫（id=${id}）：${content.trim()}`;
        }
        const id = await db.addMemory(content, "coach");
        return `已記下（id=${id}）：${content.trim()}`;
      }

      case "forget": {
        const id = toInt(input.memory_id, "memory_id");
        if (!(await db.deleteMemory(id))) throw new Error(`找不到 id=${id} 的記住的事`);
        return `已刪掉記住的事 id=${id}`;
      }

      case "add_race": {
        const raceName = str(input.name);
        const date = str(input.date);
        if (!raceName || !date) throw new Error("缺少 name 或 date");
        const raceId = await db.addRace({
          name: raceName,
          date,
          distance_km: toNumber(input.distance_km, "distance_km"),
          target_time: str(input.target_time),
          confirmed: toInt(input.confirmed ?? 1, "confirmed"),
          notes: str(input.notes),
        });
        return `賽事已新增（id=${raceId}）：${date} ${raceName}`;
      }

      case "get_upcoming_races": {
        const days = toInt(input.days ?? settings.raceLookaheadDays, "days");
        const races = await db.getUpcomingRaces(days);
        const pastRaces = await db.getPastRacesWithoutResult(settings.raceLookbackDays);
        const lines: string[] = [];
        if (races.length) {
          lines.push(`未來 ${days} 天內的賽事（共 ${races.length} 筆）：`, ...races.map(raceLine));
        } else {
          lines.push(`未來 ${days} 天內無已記錄賽事。`);
        }
        if (pastRaces.length) {
          lines.push(
            `\n最近 ${settings.raceLookbackDays} 天已結束、尚未記錄成績的賽事（共 ${pastRaces.length} 筆）：`,
            ...pastRaces.map(raceLine),
          );
        }
        return lines.join("\n");
      }

      case "update_race_result": {
        const raceId = toInt(input.race_id, "race_id");
        const resultTime = str(input.result_time);
        if (!resultTime) throw new Error("缺少 result_time");
        await db.updateRaceResult(raceId, resultTime, str(input.notes));
        return `賽事 id=${raceId} 成績已更新：${resultTime}`;
      }

      case "update_athlete_profile": {
        const key = str(input.key);
        if (!key) throw new Error("缺少 key");
        await db.setProfileKey(key, str(input.value));
        return `選手資料已更新：${key} = ${str(input.value)}`;
      }

      case "save_training_plan":
        return savePlanFromTool(db, today(), input);

      case "update_planned_session": {
        const action = str(input.action);
        if (!["move", "skip", "fallback", "restore"].includes(action)) throw new Error("action 只能是 move、skip、fallback、restore");
        return changeSession(db, today(), toInt(input.session_id, "session_id"), action as SessionAction, {
          date: input.date === undefined ? undefined : str(input.date) || null,
          reason: str(input.reason),
        });
      }

      case "update_race": {
        const raceId = toInt(input.race_id, "race_id");
        const fields: RaceUpdate = {};
        for (const key of ["name", "date", "distance_km", "target_time", "confirmed", "notes"] as const) {
          const value = input[key];
          if (typeof value === "string" || typeof value === "number") fields[key] = value;
        }
        await db.updateRace(raceId, fields);
        const changed = Object.entries(fields)
          .map(([k, v]) => `${k}=${v}`)
          .join("、");
        return `賽事 id=${raceId} 已更新：${changed}`;
      }

      case "cancel_race": {
        const raceId = toInt(input.race_id, "race_id");
        await db.cancelRace(raceId, str(input.notes));
        return `賽事 id=${raceId} 已標記為取消，紀錄保留於 DB。`;
      }

      default:
        return `未知的 tool：${name}`;
    }
  }

  return async (name, input) => {
    try {
      return await execute(name, input);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(`Tool execution error [${name}]: ${message}`);
      return `${TOOL_FAILED_PREFIX}${message}`;
    }
  };
}
