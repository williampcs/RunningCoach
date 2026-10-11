/**
 * 本機開發用的模擬上游 — 不需要任何金鑰、不花 token 就能把整條流程跑起來.
 *
 *   POST /v1/messages                         模擬 Anthropic Messages API（依規則回覆，會呼叫工具）
 *   GET  /intervals/athlete/:id/activities    模擬 Intervals.icu（今天與三天前各一筆跑步）
 *
 * 搭配方式見 README 的「本機開發」。
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8788);

type Block = { type: string; [key: string]: unknown };
type Message = { role: string; content: string | Block[] };

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
const daysAgo = (n: number) => new Date(Date.parse(today()) - n * 86_400_000).toISOString().slice(0, 10);

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
    },
    { id: "i-mock-ride", type: "Ride", start_date_local: `${daysAgo(1)}T18:00:00`, distance: 30000, moving_time: 3600 },
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
    },
  ];
}

const textOf = (m: Message | undefined) =>
  !m ? "" : typeof m.content === "string" ? m.content : m.content.map((b) => String(b.text ?? b.content ?? "")).join("\n");

const toolUse = (name: string, input: Record<string, unknown> = {}): Block => ({
  type: "tool_use",
  id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
  name,
  input,
});

/** 依對話內容決定模擬教練的下一步 */
function reply(body: { messages: Message[]; tools?: unknown[]; tool_choice?: { type: string } }): Block[] {
  const last = body.messages.at(-1);
  const lastText = textOf(last);
  const isToolResult = Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");

  if (!body.tools?.length) return [{ type: "text", text: "（模擬摘要）10 公里有氧跑，配速穩定，心率落在 Z3，體感與數據相符。" }];
  if (body.tool_choice?.type === "none") return [{ type: "text", text: "（模擬回覆）已達工具呼叫上限，先回覆到這裡。" }];

  if (isToolResult) {
    if (lastText.includes("✅ 是今天的活動")) {
      return [toolUse("save_workout", { perceived_effort: 7, subjective_notes: "腿有點重" })];
    }
    if (lastText.includes("非今天")) {
      return [toolUse("save_pending_subjective", { date: today(), perceived_effort: 7, subjective_notes: "腿有點重" })];
    }
    return [{ type: "text", text: `（模擬回覆）工具回傳了：\n\n${lastText}\n\n**建議**：明天安排 40 分鐘輕鬆跑，心率維持在 Z2。` }];
  }
  if (/跑完|剛跑/.test(lastText) && !lastText.includes("已經存檔")) return [toolUse("fetch_latest_activity")];
  if (/比賽|賽事/.test(lastText)) return [toolUse("get_upcoming_races")];
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
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

createServer((req, res) => {
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "OPTIONS") return void res.writeHead(204, CORS).end();

  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "GET" && /^\/intervals\/athlete\/[^/]+\/activities$/.test(path)) {
    if (!req.headers.authorization) return send(401, { status: 401, error: "Unauthorized" });
    return send(200, activities());
  }
  if (req.method === "POST" && path === "/v1/messages") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const content = reply(body);
      const inputChars = JSON.stringify(body.messages).length + JSON.stringify(body.system ?? "").length;
      console.log(`${new Date().toISOString()} /v1/messages model=${body.model} → ${content[0]?.type}`);
      send(200, {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: Math.round(inputChars / 2), output_tokens: Math.round(JSON.stringify(content).length / 2) },
      });
    });
    return;
  }
  send(404, { type: "error", error: { type: "not_found_error", message: path } });
}).listen(PORT, "127.0.0.1", () => console.log(`mock upstream listening on http://127.0.0.1:${PORT}`));
