/**
 * 從其他 AI 服務帶入選手資料（規格 6.5）.
 *
 * 使用者把 IMPORT_PROMPT 貼到原本的服務，取得整理好的文字後貼回來；
 * 這裡請摘要模型擷取成選手資料、賽事與訓練計畫的建議值，由使用者逐項確認後才寫入。
 * 原文不寫入資料庫。
 */
import { normalizeStartTime } from "./races";
import { matchTaiwanCities, type PlaceCandidate } from "./weather";

/** 選手資料的欄位與名稱（與 update_athlete_profile 工具可用的欄位相同） */
export const PROFILE_FIELDS: readonly { key: string; label: string; hint?: string }[] = [
  { key: "goal_long_term", label: "長期目標" },
  { key: "weekly_km_target", label: "每週目標里程（km）", hint: "只寫數字" },
  { key: "injuries", label: "傷病注意" },
  { key: "pb_5k", label: "5km 最佳", hint: "mm:ss 或 h:mm:ss" },
  { key: "pb_10k", label: "10km 最佳", hint: "mm:ss 或 h:mm:ss" },
  { key: "pb_half", label: "半馬最佳", hint: "h:mm:ss" },
  { key: "pb_full", label: "全馬最佳", hint: "h:mm:ss" },
  { key: "gender", label: "性別" },
  { key: "birth_year", label: "出生年（西元）", hint: "四位數字" },
  { key: "height_cm", label: "身高（cm）", hint: "只寫數字" },
  { key: "weight_kg", label: "體重（kg）", hint: "只寫數字" },
  { key: "body_fat_pct", label: "體脂（%）", hint: "只寫數字" },
  { key: "max_hr", label: "最大心率", hint: "只寫數字" },
  { key: "resting_hr", label: "靜息心率", hint: "只寫數字" },
  { key: "pref_long_run_day", label: "長跑日" },
  { key: "pref_rest_days", label: "休息日" },
  { key: "pref_train_time", label: "偏好時段" },
];

const PROFILE_KEYS = new Set(PROFILE_FIELDS.map((f) => f.key));

export interface ImportedRace {
  name: string;
  date: string;
  distance_km: number;
  target_time: string | null;
  notes: string | null;
  /** 起跑時間 HH:MM（原文有才有） */
  start_time?: string | null;
  /** 比賽地點：原文的縣市對得到台灣的縣市時才有（只用來查天氣；其他地方之後在賽事頁搜尋） */
  place?: PlaceCandidate | null;
}

export interface ImportSuggestion {
  profile: Record<string, string>;
  races: ImportedRace[];
  /** 每週課表（Markdown）；原文沒有具體課表時為 null */
  plan: string | null;
}

/** 使用者複製到原本的 AI 服務的提示詞 */
export const IMPORT_PROMPT = `請根據我們過去的對話與你對我的了解，整理我的跑步相關資料，我要帶到另一個跑步教練 App 使用。
只寫你確定的內容；不確定或沒提過的項目寫「不明」，不要猜測。不需要提供姓名或聯絡方式。

請用以下格式回覆：

【目標與狀況】
- 長期目標：
- 每週目標里程（km）：
- 傷病或身體狀況：

【個人最佳】（註明達成日期）
- 5km：
- 10km：
- 半馬：
- 全馬：

【生理資料】
- 性別：
- 出生年（西元）：
- 身高（cm）：
- 體重（kg）：
- 體脂（%）：
- 最大心率：
- 靜息心率：

【訓練偏好】
- 長跑日：
- 休息日：
- 偏好的訓練時段：

【未來賽事】（每場一行：賽事名稱、日期 YYYY-MM-DD、距離、目標時間；知道的話加上舉辦的縣市與起跑時間）

【目前的訓練計畫】（有固定的每週課表就逐日列出；沒有就寫「無」）`;

/**
 * 多運動開著時的提示詞（規格 12.24 的第 3 階段）：不限跑步，多問練哪些運動；擷取的欄位不變
 * （練哪些運動由選手在選手資料選，騎車的區間從 Intervals.icu 讀）
 */
export function importPrompt(options: { multisport?: boolean } = {}): string {
  if (!options.multisport) return IMPORT_PROMPT;
  return IMPORT_PROMPT.replace("整理我的跑步相關資料，我要帶到另一個跑步教練 App 使用。", "整理我的耐力運動（跑步、騎車等）相關資料，我要帶到另一個耐力運動教練 App 使用。")
    .replace("【訓練偏好】\n", "【訓練偏好】\n- 練哪些運動（例如跑步、騎車、肌力訓練）與各自的目標：\n");
}

/** 送給摘要模型的擷取指示 */
export function buildExtractionPrompt(text: string, today: string): string {
  const keys = PROFILE_FIELDS.map((f) => `- ${f.key}：${f.label}${f.hint ? `（${f.hint}）` : ""}`).join("\n");
  return `以下是使用者從其他服務整理來的跑步資料，可能是固定格式，也可能是對話摘錄。今天是 ${today}。
請擷取可以確定的資訊，只輸出一個 JSON 物件，不要其他文字：

{"profile": {"<key>": "<value>"}, "races": [{"name": "賽事名稱", "date": "YYYY-MM-DD", "distance_km": 21.0975, "target_time": "1:55:00", "notes": null, "city": null, "start_time": null}], "plan": null}

profile 可用的 key：
${keys}

規則：
- 只填原文明確提到的資訊；「不明」、空白或需要推測的項目不要輸出。
- 時間用 h:mm:ss 或 mm:ss；數字欄位只寫數字，不含單位。
- 同一項有多個值時（例如 PB 更新過）用最新的。
- races 只列今天以後、日期明確的賽事。半馬的 distance_km 是 21.0975，全馬是 42.195；target_time、notes、city（舉辦的縣市，例：台北市）、start_time（起跑時間 HH:MM）沒有就填 null。
- plan 只在原文有具體的每週課表時填寫，用 Markdown 逐日條列；沒有就填 null。
- 姓名、聯絡方式等可識別個人的資訊不要放進任何欄位。

原文：
"""
${text}
"""`;
}

/** 看得懂的起跑時間才帶入 */
function startTimeOf(value: unknown): string | null {
  try {
    return normalizeStartTime(cleanText(value, 10));
  } catch {
    return null;
  }
}

/** 縣市只在本機對照台灣的縣市（不送出去搜尋）；對到剛好一個才帶入 */
function placeOf(value: unknown): PlaceCandidate | null {
  const city = cleanText(value, 50);
  const found = city ? matchTaiwanCities(city) : [];
  return found.length === 1 ? found[0]! : null;
}

const UNKNOWN = /^(不明|未知|無|沒有|n\/?a|none|null|unknown|-+)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text || UNKNOWN.test(text)) return null;
  return text.slice(0, maxLength);
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value) ? value : null;
}

/**
 * 解讀模型的回覆：容許前後的說明文字與程式碼區塊，
 * 丟掉不認得的欄位、空值、過去或日期不明的賽事。
 */
export function parseExtraction(reply: string, today: string): ImportSuggestion {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  let data: unknown;
  try {
    data = start >= 0 && end > start ? JSON.parse(reply.slice(start, end + 1)) : null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object") throw new Error("無法解讀模型的整理結果，請再試一次。");
  const raw = data as { profile?: unknown; races?: unknown; plan?: unknown };

  const profile: Record<string, string> = {};
  if (raw.profile && typeof raw.profile === "object") {
    for (const [key, value] of Object.entries(raw.profile as Record<string, unknown>)) {
      const text = cleanText(value, 300);
      if (PROFILE_KEYS.has(key) && text) profile[key] = text;
    }
  }

  const races: ImportedRace[] = [];
  for (const item of Array.isArray(raw.races) ? raw.races : []) {
    if (!item || typeof item !== "object") continue;
    const race = item as Record<string, unknown>;
    const name = cleanText(race.name, 100);
    const date = validDate(race.date);
    const distance = Number(race.distance_km);
    if (!name || !date || date < today || !Number.isFinite(distance) || distance <= 0 || distance > 400) continue;
    races.push({
      name,
      date,
      distance_km: distance,
      target_time: cleanText(race.target_time, 20),
      notes: cleanText(race.notes, 300),
      start_time: startTimeOf(race.start_time),
      place: placeOf(race.city),
    });
  }
  races.sort((a, b) => a.date.localeCompare(b.date));

  return { profile, races, plan: cleanText(raw.plan, 5000) };
}
