/**
 * 本機開發用的模擬上游 — 不需要任何金鑰、不花 token 就能把整條流程跑起來.
 *
 *   POST /v1/messages                         模擬 Anthropic Messages API（依規則回覆，會呼叫工具；支援串流）
 *   POST /v1/chat/completions                 模擬 OpenAI 相容的 Chat Completions（同一套規則；支援串流）
 *   GET  /intervals/athlete/:id/activities    模擬 Intervals.icu（今天與三天前各一筆跑步；匯入完整歷史時另有 2024 年起的舊紀錄）
 *   GET  /intervals/athlete/:id/wellness      恢復資料、體能與疲勞
 *   GET  /intervals/athlete/:id               選手與運動設定（跑步與騎車的閾值心率與區間，騎車的 FTP 與功率區間）
 *   GET  /intervals/athlete/:id/pace-curves.json  最近 90 天的最佳配速曲線與臨界速度
 *   *    /sync/v1/...                          多裝置同步服務（apps/sync，資料只在記憶體裡）
 *   GET  /weather/v1/forecast|air-quality|search  模擬 Open-Meteo（濕熱、午後可能下雨、空氣品質普通）
 *   GET  /_mock/requests                      最近送到模擬服務的模型請求（與回傳的用量）、天氣查詢（E2E 檢查送出了什麼）
 *
 * 請求帶快取標記（cache_control）時模擬 Prompt Caching，回傳快取的讀與寫（見 cachedUsage）。
 *
 * 回覆前先停頓一段時間模擬思考；串流時思考內容不回傳（同新模型的預設），之後逐段送出文字。
 *
 * 搭配方式見 README 的「本機開發」。
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { openNodeSqlite } from "@running-coach/sqlite-node";

import { createSyncHandler } from "../apps/sync/src/handler";
import { SyncStore } from "../apps/sync/src/store";

const PORT = Number(process.env.MOCK_PORT ?? 8788);
// 模擬思考的停頓與串流時每段文字的間隔（毫秒）
const THINK_MS = Number(process.env.MOCK_THINK_MS ?? 800);
const CHUNK_MS = Number(process.env.MOCK_CHUNK_MS ?? 25);
// 長回覆寫慢一點（約 10 秒）：E2E 要在串流中點開段落、看「寫作中」（規格 12.30）
const chunkMs = (text: string) => (text === LONG_REPLY ? CHUNK_MS * 4 : CHUNK_MS);

type Block = { type: string; [key: string]: unknown };
type Message = { role: string; content: string | Block[] };

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
const daysAgo = (n: number) => new Date(Date.parse(today()) - n * 86_400_000).toISOString().slice(0, 10);

/** 最近 14 天的恢復資料；最近兩天靜息心率偏高、HRV 偏低，方便看到教練動態的提醒 */
function wellness() {
  return Array.from({ length: 14 }, (_, i) => {
    const tired = i <= 1;
    return {
      id: daysAgo(i),
      restingHR: tired ? 58 : 51 + (i % 3),
      hrv: tired ? 46 : 60 + (i % 4),
      sleepSecs: tired ? 21_600 : 26_000 + (i % 3) * 600,
      sleepScore: tired ? 62 : 80,
      ctl: 38 - i * 0.2,
      atl: tired ? 52 : 40,
      rampRate: 2.1,
    };
  });
}

/** 跑步的閾值心率與 Intervals.icu 預設的 7 區（各區的上限） */
const LTHR = 170;
const HR_ZONES = [144, 151, 160, 168, 173, 180, 190];
/** 騎車自己的閾值心率與區間（比跑步低一些）、FTP 與 Coggan 的 7 區（FTP 的百分比）：交叉訓練的目標換算用（規格 12.24） */
const RIDE_LTHR = 160;
const RIDE_HR_ZONES = [135, 142, 150, 158, 163, 170, 185];
const RIDE_FTP = 200;
const POWER_ZONES = [55, 75, 90, 105, 120, 150, 999];

/**
 * 匯入完整歷史用的舊紀錄：2024-01 起每 4 天一趟，到 45 天前為止（一般的同步只抓 14 天，碰不到）；
 * 另有一筆從 Strava 匯入的空殼（Intervals.icu 不經 API 提供內容）
 */
function history() {
  const runs: Record<string, unknown>[] = [];
  const end = daysAgo(45);
  for (let date = "2024-01-05", i = 0; date <= end; date = new Date(Date.parse(date) + 4 * 86_400_000).toISOString().slice(0, 10), i++) {
    const km = [6, 8, 10, 6, 12, 8, 21.1][i % 7]!;
    const secs = Math.round(km * (330 + (i % 5) * 10));
    runs.push({
      id: `i-hist-${i}`,
      type: "Run",
      start_date_local: `${date}T06:30:00`,
      distance: km * 1000,
      moving_time: secs,
      average_speed: (km * 1000) / secs,
      average_heartrate: 145 + (i % 6) * 3,
      max_heartrate: 165 + (i % 6) * 3,
      total_elevation_gain: 30 + (i % 4) * 25,
      icu_training_load: Math.round(km * 6),
    });
  }
  runs.push({ id: "i-strava-1", start_date_local: "2023-06-01T07:00:00", source: "STRAVA", _note: "STRAVA activities are not available via the API" });
  return runs;
}

function activities() {
  return [
    {
      id: "i-mock-today",
      type: "Run",
      start_date_local: `${today()}T06:30:00`,
      distance: 10021.4,
      moving_time: 3306,
      average_speed: 3.0303,
      average_heartrate: 152,
      max_heartrate: 171,
      total_elevation_gain: 48,
      calories: 640,
      icu_training_load: 72,
      lthr: LTHR,
      icu_hr_zones: HR_ZONES,
      icu_hr_zone_times: [420, 1500, 1100, 286, 0, 0, 0],
      icu_ctl: 38,
      icu_atl: 52,
    },
    // 今天傍晚一趟課表外的騎車（輕鬆，心率區間是騎車自己的）：多運動的「要不要調整接下來的課」（規格 12.24）；
    // 放在今天，不論星期幾都在這週的課表裡
    {
      id: "i-mock-ride",
      type: "Ride",
      start_date_local: `${today()}T17:30:00`,
      distance: 30000,
      moving_time: 3600,
      average_heartrate: 128,
      icu_training_load: 38,
      lthr: RIDE_LTHR,
      icu_hr_zones: RIDE_HR_ZONES,
      icu_hr_zone_times: [2400, 1200, 0, 0, 0, 0, 0],
    },
    // 之前的騎車（多運動的第 3 階段）：紀錄頁的騎車、長騎的增幅有依據；都不到 90 分鐘、負荷 60 以下
    // （不觸發「前一天騎很久」，開關關著的腳本不受影響）
    {
      id: "i-mock-ride-4d",
      type: "Ride",
      start_date_local: `${daysAgo(4)}T07:00:00`,
      distance: 32000,
      moving_time: 4500,
      average_heartrate: 141,
      icu_training_load: 58,
      icu_eftp: 205,
      lthr: RIDE_LTHR,
      icu_hr_zones: RIDE_HR_ZONES,
      icu_hr_zone_times: [900, 1200, 1500, 900, 0, 0, 0],
    },
    {
      id: "i-mock-ride-8d",
      type: "VirtualRide",
      start_date_local: `${daysAgo(8)}T20:00:00`,
      distance: 38000,
      moving_time: 5100,
      average_heartrate: 130,
      icu_training_load: 52,
      // 訓練台：有踏頻與功率（騎車卡有資料才顯示踏頻、功率與標準化功率，規格 12.31）
      average_cadence: 88,
      icu_average_watts: 172,
      icu_weighted_avg_watts: 181,
      lthr: RIDE_LTHR,
      icu_hr_zones: RIDE_HR_ZONES,
      icu_hr_zone_times: [2400, 2400, 300, 0, 0, 0, 0],
    },
    {
      id: "i-mock-3d",
      type: "Run",
      start_date_local: `${daysAgo(3)}T19:10:00`,
      distance: 8000,
      moving_time: 2760,
      average_heartrate: 141,
      max_heartrate: 158,
      total_elevation_gain: 12,
      icu_training_load: 41,
      lthr: LTHR,
      icu_hr_zones: HR_ZONES,
      icu_hr_zone_times: [1900, 860, 0, 0, 0, 0, 0],
    },
  ];
}

/**
 * 範例課表（這週或下週）：週二輕鬆跑加 20 秒的加速跑與肌力、週四 T、週日長跑；有檢查器的提醒時也存（附上理由）.
 * multisport：工具有交叉訓練的 sport 時（多運動的開關開著），週六加一堂 Z2 的騎車，今天加一堂肌力（回報做完了用）
 */
function samplePlan(text: string, multisport = false) {
  const weekday = (new Date(`${today()}T00:00:00Z`).getUTCDay() + 6) % 7;
  // 「下週」排在下週，課都在今天以後；否則排這週，今天以前的課會配對到已經跑的紀錄
  const start = /下週/.test(text) ? 7 : 0;
  const day = (offset: number) => daysAgo(weekday - start - offset);
  return {
    week_start: day(0),
    style: "fixed",
    reason: `（模擬）依最近的跑量排${start ? "下週" : "這週"}`,
    accept_warnings: true,
    warning_notes: "（模擬）測試用的課表",
    outline: "- 下週：維持跑量\n- 之後：每兩週加一點",
    sessions: [
      {
        date: day(1),
        kind: "easy",
        title: "輕鬆跑",
        steps: [{ duration_min: 40, target: { hr: "easy" } }, { repeat: 4, steps: [{ duration_min: 1 / 3, target: { rpe: [8, 9] }, note: "加速" }, { duration_min: 1 }] }],
        purpose: "有氧基礎",
        success: "心率不超過輕鬆跑上限",
      },
      { date: day(1), kind: "strength", title: "肌力", steps: [{ duration_min: 20, note: "深蹲、臀橋、核心" }], purpose: "減少受傷", success: "動作確實" },
      {
        date: day(3),
        kind: "threshold",
        title: "4×1 km 閾值",
        steps: [
          { duration_min: 15, target: { hr: "easy" } },
          { repeat: 4, steps: [{ distance_km: 1, target: { pace: "T" } }, { duration_min: 1, target: { hr: "easy" } }] },
          { duration_min: 10, target: { hr: "easy" } },
        ],
        purpose: "提高閾值",
        success: "每一趟都在配速範圍內",
        fallback: "改成 40 分鐘輕鬆跑",
      },
      { date: day(6), kind: "long", title: "長跑", steps: [{ distance_km: 10, target: { pace: "E" } }], purpose: "耐力", success: "後半段配速不掉" },
      ...(multisport
        ? [
            {
              date: day(5),
              kind: "cross",
              sport: "ride",
              title: "輕鬆騎車",
              steps: [{ duration_min: 45, target: { zone: "Z2" } }, { duration_min: 10, target: { power: "Z3" } }],
              purpose: "不增加衝擊的有氧量",
              success: "心率維持在騎車的 Z2",
            },
            ...(start === 0
              ? [{ date: today(), kind: "strength", title: "今天的肌力", steps: [{ duration_min: 20, note: "深蹲、弓箭步、單腳提踵" }], purpose: "減少受傷", success: "動作確實" }]
              : []),
          ]
        : []),
    ],
  };
}

/**
 * 跑步＋騎車（或只騎車）的課表（多運動的第 3 階段）：今天一堂耐力騎（配對今天傍晚的騎車）、相鄰兩天甜蜜點與 T、
 * 再一堂最大攝氧間歇——第一次不設 accept_warnings，檢查器會回跨運動的警告（兩項合計的數量、不連排）。
 * rideOnly：只練騎車（耐力、甜蜜點、長騎），照規則排、沒有警告
 */
function cyclingPlan(rideOnly: boolean, accept = false) {
  const t = (new Date(`${today()}T00:00:00Z`).getUTCDay() + 6) % 7;
  const at = (index: number) => daysAgo(t - index);
  const zone = (z: string, minutes: number) => ({ duration_min: minutes, target: { zone: z } });
  const endurance = { date: today(), kind: "ride_endurance", title: "耐力騎", steps: [zone("Z2", 60)], purpose: "有氧基礎", success: "心率大多在騎車的 Z2" };
  const sweetspot = (date: string) => ({
    date,
    kind: "ride_sweetspot",
    title: "甜蜜點 2 × 15 分鐘",
    steps: [zone("Z2", 15), { repeat: 2, steps: [zone("SS", 15), { duration_min: 5 }] }, zone("Z1", 10)],
    purpose: "提高 FTP",
    success: "第二組仍能維持",
    fallback: "改成 60 分鐘耐力騎",
  });
  if (rideOnly) {
    const [a, b] = t <= 3 ? [t + 2, 6] : [t - 3, t === 6 ? 5 : 6];
    return {
      week_start: at(0),
      style: "fixed",
      reason: "（模擬）只練騎車：耐力為主，一堂甜蜜點",
      // 週五以後甜蜜點會排在今天以前（past_date 的提醒）：一律寫理由存
      accept_warnings: true,
      warning_notes: "（模擬）測試用的課表",
      sessions: [endurance, sweetspot(at(a)), { date: at(b), kind: "ride_long", title: "長騎", steps: [zone("Z2", 95)], purpose: "耐力", success: "補給與心率穩定" }],
    };
  }
  const [a, b] = t <= 4 ? [t + 1, t + 2] : [t - 2, t - 1];
  const free = [0, 1, 2, 3, 4, 5, 6].filter((i) => ![t, a, b].includes(i));
  return {
    week_start: at(0),
    style: "fixed",
    reason: "（模擬）跑步＋騎車",
    ...(accept ? { accept_warnings: true, warning_notes: "（模擬）測試跨運動的警告" } : {}),
    sessions: [
      endurance,
      sweetspot(at(a)),
      {
        date: at(b),
        kind: "threshold",
        title: "20 分鐘 T",
        steps: [{ duration_min: 15, target: { hr: "easy" } }, { duration_min: 20, target: { pace: "T" } }, { duration_min: 10, target: { hr: "easy" } }],
        purpose: "提高閾值",
        success: "配速穩定",
        fallback: "改成 40 分鐘輕鬆跑",
      },
      {
        date: at(free.find((i) => Math.abs(i - a) > 1 && Math.abs(i - b) > 1 && i !== t) ?? free[0]!),
        kind: "ride_vo2",
        title: "5 × 4 分鐘",
        steps: [zone("Z2", 15), { repeat: 5, steps: [zone("Z5", 4), { duration_min: 4 }] }, zone("Z1", 10)],
        purpose: "最大攝氧量",
        success: "最後一趟仍能完成",
        fallback: "改成 60 分鐘耐力騎",
      },
      { date: at(free.at(-1)!), kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40, target: { hr: "easy" } }], purpose: "有氧基礎", success: "心率不超過輕鬆跑上限" },
    ],
  };
}

/** 上一次模擬的 edit_planned_session（檢查器退回時寫理由再送） */
let lastEdit: Record<string, unknown> | null = null;

/** edit_planned_session 的一堂課（完整的內容，沒有日期） */
const EDITED_SESSION = {
  kind: "interval",
  title: "8×400 m",
  steps: [
    { duration_min: 15, target: { hr: "easy" } },
    { repeat: 8, steps: [{ distance_km: 0.4, target: { pace: "I" } }, { duration_min: 1.5, note: "慢跑恢復" }] },
    { duration_min: 10, target: { hr: "easy" } },
  ],
  purpose: "最大攝氧量",
  success: "最後一趟仍能保持配速",
  fallback: "改成 40 分鐘輕鬆跑",
};

/** 工具清單有單車的課（多運動的第 3 階段） */
const hasCycling = (tools: unknown[] | undefined) => JSON.stringify(tools ?? []).includes("ride_sweetspot");

/** 工具清單有交叉訓練的 sport（多運動的開關開著） */
const hasMultisport = (tools: unknown[] | undefined) => JSON.stringify(tools ?? []).includes("交叉訓練（kind=cross）是哪種運動");

const textOf = (m: Message | undefined) =>
  !m ? "" : typeof m.content === "string" ? m.content : m.content.map((b) => String(b.text ?? b.content ?? "")).join("\n");

const toolUse = (name: string, input: Record<string, unknown> = {}): Block => ({
  type: "tool_use",
  id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
  name,
  input,
});

/** 依對話內容決定模擬教練的下一步 */
/** 模擬的長回覆：結論＋三個小標（程式碼區塊裡的 ## 不算小標） */
const LONG_REPLY =
  "（模擬回覆）**週四的閾值課縮短成 3 × 1.5 km，週末長跑照排。**這週量比平常多一成，先保留強度、少一組。\n\n" +
  "## 這週的狀況\n這週跑了 32 km，比前三週平均多 12%；長跑後段的心率漂移有點大。\n\n" +
  "## 週四的閾值課\n改成 3 × 1.5 km，組間慢跑 2 分鐘。\n\n```\n## 這行在程式碼區塊裡，不是小標\n```\n\n" +
  "## 週末的長跑\n維持 16 km，前 10 km 控制在輕鬆跑的心率以下。";

function reply(body: { messages: Message[]; system?: string | Block[]; tools?: unknown[]; tool_choice?: { type: string } }): Block[] {
  const last = body.messages.at(-1);
  const lastText = textOf(last);
  const isToolResult = Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");

  // 從其他 AI 帶入的擷取：回固定的 JSON，前後夾著說明文字與程式碼區塊（真實模型常這樣回）
  if (!body.tools?.length && lastText.includes("只輸出一個 JSON 物件")) {
    const extraction = {
      profile: { goal_long_term: "全馬破四", pb_10k: "48:30", weight_kg: "62", injuries: "不明" },
      races: [
        { name: "模擬城市馬拉松", date: daysAgo(-60), distance_km: 42.195, target_time: "3:59:00", notes: null },
        { name: "去年的半馬", date: daysAgo(200), distance_km: 21.0975, target_time: null, notes: null },
      ],
      plan: "- 週二：間歇 6×800m\n- 週四：節奏跑 8km\n- 週日：長跑 25km",
    };
    return [{ type: "text", text: `整理如下：\n\n\`\`\`json\n${JSON.stringify(extraction, null, 2)}\n\`\`\`` }];
  }

  // 騎後分析（規格 12.31）：提到有沒有功率，E2E 檢查功率有帶進去
  if (!body.tools?.length && lastText.includes("騎車訓練")) {
    const power = /平均功率：(\d+) W/.exec(lastText);
    return [
      {
        type: "text",
        text: `（模擬騎後分析）穩定的耐力騎，強度控制得不錯\n\n- 大多在低強度${power ? `\n- 平均功率 ${power[1]} W，出力平穩` : ""}\n- 明天可以安排輕鬆跑`,
      },
    ];
  }
  // 沒有工具的單次生成（跑後摘要、對話壓縮）；真實模型常回 Markdown
  if (!body.tools?.length) {
    return [
      {
        type: "text",
        text: "（模擬摘要）穩定的有氧跑，心率控制得不錯\n\n- 配速穩定，心率大多在輕鬆跑的範圍\n- 體感與數據相符",
      },
    ];
  }
  if (body.tool_choice?.type === "none") return [{ type: "text", text: "（模擬回覆）已達工具呼叫上限，先回覆到這裡。" }];

  if (isToolResult) {
    // 只改一堂課（規格 12.31）：看完課表後，把第一堂閾值課改成 400 m × 8
    const asked = textOf([...body.messages].reverse().find((m) => m.role === "user" && typeof m.content === "string"));
    const threshold = lastText.match(/\[session_id=(\d+)\][^\n]*｜T 閾值/);
    if (/改成 400 m × 8/.test(asked) && threshold && !lastText.includes("已修改")) {
      lastEdit = { session_id: Number(threshold[1]), reason: "（模擬）想練速度，改成 400 m × 8", session: EDITED_SESSION };
      return [toolUse("edit_planned_session", lastEdit)];
    }
    // 整週的檢查有新的提醒時寫理由再改一次
    if (/改成 400 m × 8/.test(asked) && lastText.includes("尚未修改") && lastEdit) {
      return [toolUse("edit_planned_session", { ...lastEdit, accept_warnings: true, warning_notes: "（模擬）選手想練速度" })];
    }
    // 跑步＋騎車的課表有跨運動的警告：寫理由再存一次
    if (lastText.includes("尚未儲存") && lastText.includes("跑步與騎車")) {
      return [toolUse("save_training_plan", cyclingPlan(false, true))];
    }
    if (lastText.includes("✅ 是今天的活動")) {
      return [toolUse("save_workout", { perceived_effort: 7, subjective_notes: "腿有點重" })];
    }
    if (lastText.includes("非今天")) {
      return [toolUse("save_pending_subjective", { date: today(), perceived_effort: 7, subjective_notes: "腿有點重" })];
    }
    return [{ type: "text", text: `（模擬回覆）工具回傳了：\n\n${lastText}\n\n**建議**：明天安排 40 分鐘輕鬆跑，心率維持在 Z2。` }];
  }
  const howTo = lastText.match(/([^\s\]？?]+?)(?:怎麼用|在哪裡)/);
  if (howTo) return [toolUse("get_app_help", { topic: howTo[1]! })];
  const remember = lastText.match(/幫我記住[：:，, ]*(.+)/);
  if (remember) return [toolUse("remember", { content: remember[1]!.trim() })];
  if (/之前聊過|上次說/.test(lastText)) return [toolUse("search_conversations", { from: daysAgo(7), to: today() })];
  if (/跑完|剛跑/.test(lastText) && !lastText.includes("已經存檔")) return [toolUse("fetch_latest_activity")];
  // 比賽日的天氣（規格 12.31）：系統提示的賽事清單裡第一場設定了地點的
  // 系統提示：Anthropic 的在 system，OpenAI 相容的是第一則 system 訊息
  const systemText = body.system ? textOf({ role: "system", content: body.system }) : "";
  const placed = systemText.match(/- \[(\d+)\][^\n]*已設定地點/);
  const asked = /比賽.*(天氣|配速)|怎麼配速/.test(lastText);
  if (asked && placed) return [toolUse("get_race_weather", { race_id: Number(placed[1]) })];
  if (/比賽|賽事/.test(lastText)) return [toolUse("list_races")];
  if (/騎完|剛騎/.test(lastText) && hasCycling(body.tools)) {
    return [toolUse("save_activity_feedback", { perceived_effort: 4, subjective_notes: "（模擬）輕鬆", sport: "ride" })];
  }
  if (/改成 400 m × 8/.test(lastText)) return [toolUse("get_training_plan")];
  if (/(跑步和騎車|只騎車|騎車的).*課表/.test(lastText) && hasCycling(body.tools)) {
    return [toolUse("save_training_plan", cyclingPlan(/只騎車/.test(lastText)))];
  }
  if (/排.*課表|幫我排/.test(lastText)) return [toolUse("save_training_plan", samplePlan(lastText, hasMultisport(body.tools)))];
  // 教練動態「請教練調整接下來的課」（課表外的運動，規格 12.24）：重排這週（A → A'）
  if (/調整這週接下來的課/.test(lastText)) {
    return [toolUse("save_training_plan", { ...samplePlan("", hasMultisport(body.tools)), reason: "（模擬）依課表外的騎車調整" })];
  }
  if (/配速|強度|心率區間/.test(lastText)) return [toolUse("get_training_values")];
  // Anthropic 的工具是 { name }，OpenAI 相容的是 { function: { name } }
  const toolNames = (body.tools ?? []).map((t) => (t as { name?: string; function?: { name?: string } }).name ?? (t as { function?: { name?: string } }).function?.name);
  if (/天氣|下雨/.test(lastText) && toolNames.includes("get_weather")) {
    return [toolUse("get_weather", { date: daysAgo(-1) })];
  }
  // 長回覆（規格 12.30）：先一兩句結論、細節分小標；E2E 檢查小標以下收起、串流時全部展開
  if (/長一點|詳細說明/.test(lastText)) return [{ type: "text", text: LONG_REPLY }];
  if (/計畫|課表/.test(lastText)) return [toolUse("get_training_plan")];
  if (/最近|狀態|疲勞/.test(lastText)) return [toolUse("get_recent_workouts")];
  return [
    {
      type: "text",
      text:
        `（模擬回覆）收到：「${lastText.slice(0, 60)}」\n\n` +
        "| 項目 | 建議 |\n|---|---|\n| 明天 | 輕鬆跑 8 km |\n| 週日 | 長跑 18 km |\n\n- 這是**模擬上游**的固定回覆\n- 用來在本機測試介面與流程",
    },
  ];
}

const CORS = {
  "access-control-allow-origin": "*",
  // 萬用字元不涵蓋 authorization，要另外列出
  "access-control-allow-headers": "*, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把文字切成幾個字一段 */
function pieces(text: string, size = 3): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** 用量以字元數 / 2 估算；請求帶快取標記時另外算快取的讀與寫 */
function estimateUsage(body: CacheableBody, content: Block[]): Usage {
  const output = Math.round(JSON.stringify(content).length / 2);
  const cached = cachedUsage(body);
  if (cached) return { ...cached, output };
  const input = Math.round((JSON.stringify(body.messages).length + JSON.stringify(body.system ?? "").length) / 2);
  return { input, output, cacheRead: 0, cacheWrite: 0 };
}

type CacheableBody = { messages: unknown[]; system?: unknown; tools?: unknown[]; cache_control?: unknown };
const CACHE_TTL_MS = 5 * 60_000;
/** 快取的前綴（雜湊）→ 到期時間 */
const promptCache = new Map<string, number>();

/**
 * 模擬 Prompt Caching：只在請求上有 cache_control 時（Anthropic 的自動快取，或 OpenRouter 上 Claude 的寫法）。
 * 依 tools → system → messages 的順序把請求接成一串；斷點是帶 cache_control 的系統提示區塊結尾與整段的結尾。
 * 5 分鐘內在斷點寫過的最長前綴（任一區塊的邊界）算讀取，讀取到最後一個斷點之間算寫入，其餘照一般輸入；命中與寫入都重新計時。
 */
function cachedUsage(body: CacheableBody): Omit<Usage, "output"> | null {
  if (!body.cache_control) return null;
  const parts: { text: string; breakpoint: boolean }[] = [{ text: JSON.stringify(body.tools ?? []), breakpoint: false }];
  const systemParts = (system: unknown) => {
    if (typeof system === "string") parts.push({ text: system, breakpoint: false });
    else if (Array.isArray(system)) {
      for (const b of system as { text?: string; cache_control?: unknown }[]) parts.push({ text: b.text ?? "", breakpoint: Boolean(b.cache_control) });
    }
  };
  systemParts(body.system);
  for (const m of body.messages as { role: string; content: unknown }[]) {
    if (m.role === "system") systemParts(m.content);
    else parts.push({ text: JSON.stringify(m), breakpoint: false });
  }
  parts.at(-1)!.breakpoint = true;

  const now = Date.now();
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  let prefix = "";
  let read = 0;
  const breakpoints: { key: string; chars: number }[] = [];
  for (const part of parts) {
    prefix += part.text;
    const key = hash(prefix);
    // 斷點往前找之前寫過的區塊邊界（真實的 API 往前找最多 20 個區塊）
    if ((promptCache.get(key) ?? 0) > now) read = prefix.length;
    if (part.breakpoint) breakpoints.push({ key, chars: prefix.length });
  }
  for (const { key } of breakpoints) promptCache.set(key, now + CACHE_TTL_MS);
  const tokens = (chars: number) => Math.round(chars / 2);
  const cacheRead = tokens(read);
  const cacheWrite = tokens(breakpoints.at(-1)!.chars) - cacheRead;
  return { input: tokens(prefix.length) - cacheRead - cacheWrite, cacheRead, cacheWrite };
}

const anthropicUsage = (u: Usage) => ({
  input_tokens: u.input,
  output_tokens: u.output,
  ...(u.cacheRead || u.cacheWrite ? { cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite } : {}),
});

/** OpenAI 相容的用量：prompt_tokens 含快取；cache_write_tokens 只有帶快取標記時才有（同 OpenRouter） */
const openAIUsage = (u: Usage) => ({
  prompt_tokens: u.input + u.cacheRead + u.cacheWrite,
  completion_tokens: u.output,
  ...(u.cacheRead || u.cacheWrite ? { prompt_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite } } : {}),
});

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Anthropic 格式的串流：一段不回傳內容的思考，接著逐段送出文字與工具呼叫 */
async function streamAnthropic(res: ServerResponse, model: string, content: Block[], usage: Usage) {
  res.writeHead(200, { "content-type": "text/event-stream", ...CORS });
  const send = (type: string, data: Record<string, unknown> = {}) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

  send("message_start", {
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...anthropicUsage(usage), output_tokens: 1 },
    },
  });
  send("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
  await sleep(THINK_MS);
  send("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "mock-signature" } });
  send("content_block_stop", { index: 0 });

  for (const [i, block] of content.entries()) {
    const index = i + 1;
    if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const text of pieces(String(block.text))) {
        send("content_block_delta", { index, delta: { type: "text_delta", text } });
        await sleep(chunkMs(String(block.text)));
      }
    } else {
      send("content_block_start", { index, content_block: { ...block, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send("content_block_stop", { index });
  }
  const stopReason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  send("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output } });
  send("message_stop");
  res.end();
}

type OpenAIMessage = { role: string; content: string | null; tool_calls?: unknown[] };

/** OpenAI 格式的請求轉成 reply() 使用的格式（只用得到最後一則、系統提示與是否有工具） */
function fromOpenAI(body: { messages: OpenAIMessage[]; tools?: unknown[]; tool_choice?: unknown }) {
  return {
    messages: body.messages
      .filter((m) => m.role !== "system")
      .map((m): Message =>
        m.role === "tool"
          ? { role: "user", content: [{ type: "tool_result", content: m.content ?? "" }] }
          : { role: m.role, content: m.content ?? "" },
      ),
    // 系統提示另外帶著（比賽日的天氣看賽事清單）
    system: body.messages.find((m) => m.role === "system")?.content ?? undefined,
    tools: body.tools,
    tool_choice: body.tool_choice === "none" ? { type: "none" } : undefined,
  };
}

function toOpenAI(content: Block[]) {
  const text = content.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
  const toolCalls = content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input) } }));
  return { text, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop" };
}

async function streamOpenAI(res: ServerResponse, content: Block[], usage: Usage, includeUsage: boolean) {
  res.writeHead(200, { "content-type": "text/event-stream", ...CORS });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
    send({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
  const { text, toolCalls, finishReason } = toOpenAI(content);

  chunk({ role: "assistant", content: "" });
  await sleep(THINK_MS);
  for (const piece of pieces(text)) {
    chunk({ content: piece });
    await sleep(chunkMs(text));
  }
  for (const [index, call] of toolCalls.entries()) {
    chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] });
    chunk({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] });
  }
  chunk({}, finishReason);
  if (includeUsage) send({ id: "chatcmpl-mock", choices: [], usage: openAIUsage(usage) });
  res.write("data: [DONE]\n\n");
  res.end();
}

// 多裝置同步服務：和正式的同一份程式，資料只在記憶體裡，重新啟動就清空
const syncStore = new SyncStore(openNodeSqlite(":memory:"));
await syncStore.init();
// 冷卻期（規格 12.27）預設和正式的一樣 24 小時；E2E 用 MOCK_SYNC_COOLDOWN_MS 縮短
const syncCooldown = Number(process.env.MOCK_SYNC_COOLDOWN_MS);
const syncHandle = createSyncHandler({
  store: syncStore,
  allowedOrigins: ["*"],
  cooldownMs: Number.isFinite(syncCooldown) && syncCooldown >= 0 && process.env.MOCK_SYNC_COOLDOWN_MS ? syncCooldown : undefined,
});

function proxySync(req: IncomingMessage, res: ServerResponse, path: string) {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
    const headers = Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : []));
    void syncHandle(new Request(`http://localhost${path}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined })).then(
      async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      },
    );
  });
}

/** 模擬的 Open-Meteo：每天一樣，白天濕熱 */
function mockWeather(url: URL) {
  const past = Number(url.searchParams.get("past_days") ?? 0);
  const days = Number(url.searchParams.get("forecast_days") ?? 7);
  // 日期依查詢的時區（和 Open-Meteo 一樣），不然測試的瀏覽器在 UTC 時跨日前後會對不上
  // auto（比賽地點的天氣）：模擬的地點都當成台北的時區
  const zone = url.searchParams.get("timezone") === "auto" ? "Asia/Taipei" : url.searchParams.get("timezone") || "Asia/Taipei";
  const localToday = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
  const dates = Array.from({ length: past + days }, (_, i) => new Date(Date.parse(localToday) - (past - i) * 86_400_000).toISOString().slice(0, 10));
  const hours = dates.flatMap((d) => Array.from({ length: 24 }, (_, h) => ({ time: `${d}T${String(h).padStart(2, "0")}:00`, h })));
  const temp = (h: number) => 26 + 6 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
  return {
    hourly: {
      time: hours.map((x) => x.time),
      temperature_2m: hours.map((x) => Math.round(temp(x.h) * 10) / 10),
      apparent_temperature: hours.map((x) => Math.round((temp(x.h) + 4) * 10) / 10),
      dew_point_2m: hours.map(() => 24),
      relative_humidity_2m: hours.map((x) => (x.h < 12 ? 85 : 70)),
      precipitation_probability: hours.map((x) => (x.h >= 14 && x.h <= 17 ? 70 : 10)),
      precipitation: hours.map((x) => (x.h === 15 ? 3 : 0)),
      weather_code: hours.map((x) => (x.h >= 14 && x.h <= 17 ? 80 : 2)),
      wind_speed_10m: hours.map(() => 8),
    },
    daily: {
      time: dates,
      weather_code: dates.map(() => 80),
      temperature_2m_max: dates.map(() => 32),
      temperature_2m_min: dates.map(() => 20),
      apparent_temperature_max: dates.map(() => 36),
      precipitation_probability_max: dates.map(() => 70),
      precipitation_sum: dates.map(() => 3),
      wind_speed_10m_max: dates.map(() => 15),
    },
  };
}

/** E2E 用：最近的模型請求與天氣查詢 */
const recent: { kind: "llm" | "weather"; body: unknown; usage?: Usage }[] = [];
function record(kind: "llm" | "weather", body: unknown) {
  recent.push({ kind, body });
  if (recent.length > 50) recent.shift();
}

createServer((req, res) => {
  if (req.url?.startsWith("/sync/")) return proxySync(req, res, req.url.slice("/sync".length));
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "OPTIONS") return void res.writeHead(204, CORS).end();

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (req.method === "GET" && path === "/_mock/requests") return send(200, recent);
  if (req.method === "GET" && path.startsWith("/weather/v1/")) {
    record("weather", { path, query: Object.fromEntries(url.searchParams) });
    if (path === "/weather/v1/forecast") return send(200, mockWeather(url));
    if (path === "/weather/v1/air-quality") {
      const { hourly } = mockWeather(url);
      return send(200, { hourly: { time: hourly.time, us_aqi: hourly.time.map(() => 72), pm2_5: hourly.time.map(() => 20) } });
    }
    if (path === "/weather/v1/search") {
      const name = url.searchParams.get("name") ?? "";
      if (name.length < 2 || /找不到/.test(name)) return send(200, {});
      return send(200, {
        results: [
          { name: "Mock City", latitude: 34.69374, longitude: 135.50218, country: "Mockland", admin1: "North" },
          { name: "Mock City", latitude: 22.9997, longitude: 120.2270, country: "Mockland", admin1: "South" },
        ],
      });
    }
  }
  if (req.method === "GET" && /^\/intervals\/athlete\/[^/]+\/activities$/.test(path)) {
    if (!req.headers.authorization) return send(401, { status: 401, error: "Unauthorized" });
    // 和 Intervals.icu 一樣只回傳 oldest～newest 之間的活動
    const oldest = url.searchParams.get("oldest") ?? "0000-00-00";
    const newest = url.searchParams.get("newest") ?? "9999-99-99";
    return send(
      200,
      [...activities(), ...history()].filter((a) => {
        const date = String(a.start_date_local).slice(0, 10);
        return date >= oldest && date <= newest;
      }),
    );
  }
  if (req.method === "GET" && /^\/intervals\/athlete\/[^/]+$/.test(path)) {
    if (!req.headers.authorization) return send(401, { status: 401, error: "Unauthorized" });
    return send(200, {
      id: "i0",
      name: "Mock Runner",
      email: "mock@example.com",
      sportSettings: [
        { types: ["Ride", "VirtualRide"], ftp: RIDE_FTP, power_zones: POWER_ZONES, lthr: RIDE_LTHR, max_hr: 185, hr_zones: RIDE_HR_ZONES },
        { types: ["Run", "VirtualRun", "TrailRun"], lthr: LTHR, max_hr: 190, hr_zones: HR_ZONES, threshold_pace: null },
      ],
    });
  }
  if (req.method === "GET" && /^\/intervals\/athlete\/[^/]+\/pace-curves\.json$/.test(path)) {
    if (!req.headers.authorization) return send(401, { status: 401, error: "Unauthorized" });
    return send(200, {
      list: [
        {
          days: 91,
          distance: [400, 1000, 1609.34, 3000, 5000, 10000],
          values: [95, 260, 430, 840, 1450, 3306],
          activity_id: ["i-mock-3d", "i-mock-3d", "i-mock-3d", "i-mock-today", "i-mock-today", "i-mock-today"],
          paceModels: [{ type: "CS", criticalSpeed: 3.32, dPrime: 160, r2: 0.999 }],
        },
      ],
      activities: {
        "i-mock-today": { race: false, start_date_local: `${today()}T06:30:00` },
        "i-mock-3d": { race: false, start_date_local: `${daysAgo(3)}T19:10:00` },
      },
    });
  }
  if (req.method === "GET" && /^\/intervals\/athlete\/[^/]+\/wellness$/.test(path)) {
    if (!req.headers.authorization) return send(401, { status: 401, error: "Unauthorized" });
    return send(200, wellness());
  }
  if (req.method === "POST" && path === "/v1/messages") {
    void readJson(req).then(async (body) => {
      record("llm", body);
      const content = reply(body);
      const usage = estimateUsage(body, content);
      recent.at(-1)!.usage = usage;
      console.log(`${new Date().toISOString()} /v1/messages model=${body.model}${body.stream ? " stream" : ""} → ${content[0]?.type}`);
      if (body.stream) return streamAnthropic(res, body.model, content, usage);
      await sleep(THINK_MS);
      send(200, {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: anthropicUsage(usage),
      });
    }, () => send(400, { type: "error", error: { type: "invalid_request_error", message: "invalid JSON" } }));
    return;
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    void readJson(req).then(async (body) => {
      record("llm", body);
      const content = reply(fromOpenAI(body));
      const usage = estimateUsage(body, content);
      recent.at(-1)!.usage = usage;
      console.log(`${new Date().toISOString()} /v1/chat/completions model=${body.model}${body.stream ? " stream" : ""} → ${content[0]?.type}`);
      if (body.stream) return streamOpenAI(res, content, usage, Boolean(body.stream_options?.include_usage));
      await sleep(THINK_MS);
      const { text, toolCalls, finishReason } = toOpenAI(content);
      send(200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: finishReason,
            message: { role: "assistant", content: toolCalls.length ? null : text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
          },
        ],
        usage: openAIUsage(usage),
      });
    }, () => send(400, { error: { message: "invalid JSON" } }));
    return;
  }
  send(404, { type: "error", error: { type: "not_found_error", message: path } });
}).listen(PORT, "127.0.0.1", () => console.log(`mock upstream listening on http://127.0.0.1:${PORT}`));
