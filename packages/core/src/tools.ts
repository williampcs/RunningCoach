/** 主對話可用的工具：定義（供模型呼叫）與執行器. */
import { RECENT_WORKOUT_DAYS } from "./context";
import { isoWeekLabel } from "./dates";
import type { Db, RaceUpdate } from "./db";
import type { Llm, ToolDef } from "./llm";
import type { Activity, ActivitySource, CoachSettings, Logger, Race } from "./types";

const RACE_ID_HINT =
  "race_id 為 system prompt 賽事清單（近期目標賽事、待記錄成績的賽事）中方括號內的數字；" +
  "清單中沒有該賽事時，再用 get_upcoming_races（可加大 days）查詢。";

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
              "・訓練偏好：pref_long_run_day、pref_rest_days、pref_train_time",
          },
          value: { type: "string", description: "欄位值" },
        },
        required: ["key", "value"],
      },
    },
    {
      name: "save_training_plan",
      description: "儲存訓練計畫到 DB（會停用舊計畫）。" + "制定或更新訓練計畫時呼叫。",
      input_schema: {
        type: "object",
        properties: {
          week_label: { type: "string", description: "週標籤，ISO 週（週一起算），例：2026-W14" },
          content: { type: "string", description: "訓練計畫完整內容" },
        },
        required: ["week_label", "content"],
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
      name: "get_full_message",
      description:
        "讀取對話紀錄中一則訊息的完整內容。較早的長訊息在對話中只帶入前段，並標示 message_id；" +
        "需要後面的內容時才呼叫，例如使用者先前貼上的長文、你先前較長回覆中的某一點。" +
        "已整理成對話摘要的訊息無法讀取。",
      input_schema: {
        type: "object",
        properties: { message_id: { type: "integer", description: "截斷標記中的 message_id" } },
        required: ["message_id"],
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
};

/** 生成 AI 跑步分析摘要 */
export async function generateWorkoutSummary(llm: Llm, workout: WorkoutSummaryInput): Promise<string> {
  const hasSubjective = workout.perceived_effort !== null && workout.perceived_effort !== undefined;
  const effortLine = hasSubjective
    ? `體感強度：${workout.perceived_effort}/10\n主觀感受：${workout.subjective_notes || "未記錄"}`
    : "體感資料：未記錄";
  const prompt =
    `請為以下跑步訓練生成一段簡潔分析摘要（150字以內，繁體中文）：\n\n` +
    `日期：${workout.date}\n` +
    `距離：${workout.distance_km}km\n` +
    `時長：${workout.duration_min}分鐘\n` +
    `配速：${workout.avg_pace || "未知"}\n` +
    `平均心率：${workout.avg_hr || "未記錄"}bpm\n` +
    `最高心率：${workout.max_hr || "未記錄"}bpm\n` +
    `爬升：${workout.elevation_m || 0}m\n` +
    `${effortLine}\n\n` +
    `格式：一行數據摘要 ＋ AI評估。` +
    (hasSubjective ? "客觀數據與體感對比分析。" : "僅客觀數據，給出客觀評估。");
  return (await llm.complete("summary", prompt, 2000)).text;
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
          `心率：${activity.avg_hr || "未記錄"}/${activity.max_hr || "未記錄"}bpm\n` +
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
        const workoutId = await db.saveWorkout(activity, perceivedEffort, subjectiveNotes || null);
        const summary = await generateWorkoutSummary(llm, {
          ...activity,
          perceived_effort: perceivedEffort,
          subjective_notes: subjectiveNotes,
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
        const workouts = await db.getRecentWorkouts(days);
        if (!workouts.length) return `最近 ${days} 天無訓練紀錄。`;
        const lines = [`最近 ${days} 天的訓練紀錄（共 ${workouts.length} 筆）：`];
        for (const w of workouts) {
          const subj = w.perceived_effort ? `｜體感 ${w.perceived_effort}/10` : "";
          lines.push(
            `\n【${w.date}】${w.distance_km}km｜${w.avg_pace ?? "?"}｜` +
              `心率 ${w.avg_hr ?? "?"}/${w.max_hr ?? "?"}bpm${subj}`,
          );
          if (w.summary) lines.push(`  AI摘要：${w.summary}`);
        }
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

      case "get_training_plan": {
        const plan = await db.getActiveTrainingPlan();
        if (!plan) return "目前沒有啟用中的訓練計畫。";
        return `當前訓練計畫（${plan.week_label}）：\n\n${plan.content}`;
      }

      case "get_full_message": {
        const id = toInt(input.message_id, "message_id");
        const row = await db.getConversation(id);
        if (!row) return `找不到 message_id=${id} 的訊息，可能已整理成對話摘要。`;
        const who = row.role === "user" ? "使用者" : "教練";
        const content =
          row.content.length > FULL_MESSAGE_MAX_CHARS
            ? row.content.slice(0, FULL_MESSAGE_MAX_CHARS) + `…（超過 ${FULL_MESSAGE_MAX_CHARS} 字，以下省略）`
            : row.content;
        return `訊息 ${id}（${who}）的完整內容：\n\n${content}`;
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

      case "save_training_plan": {
        const weekLabel = str(input.week_label);
        if (!weekLabel) throw new Error("缺少 week_label");
        await db.saveTrainingPlan(weekLabel, str(input.content));
        return `訓練計畫已儲存（${weekLabel}）`;
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
      return `執行失敗：${message}`;
    }
  };
}
