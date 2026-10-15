/**
 * 本機開發用的模擬上游 — 不需要任何金鑰、不花 token 就能把整條流程跑起來.
 *
 *   POST /v1/messages                         模擬 Anthropic Messages API（依規則回覆，會呼叫工具；支援串流）
 *   POST /v1/chat/completions                 模擬 OpenAI 相容的 Chat Completions（同一套規則；支援串流）
 *   GET  /intervals/athlete/:id/activities    模擬 Intervals.icu（今天與三天前各一筆跑步）
 *
 * 回覆前先停頓一段時間模擬思考；串流時思考內容不回傳（同新模型的預設），之後逐段送出文字。
 *
 * 搭配方式見 README 的「本機開發」。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8788);
// 模擬思考的停頓與串流時每段文字的間隔（毫秒）
const THINK_MS = Number(process.env.MOCK_THINK_MS ?? 800);
const CHUNK_MS = Number(process.env.MOCK_CHUNK_MS ?? 25);

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

  // 沒有工具的單次生成（跑後摘要、對話壓縮）；真實模型常回 Markdown
  if (!body.tools?.length) {
    return [
      {
        type: "text",
        text: "**（模擬摘要）10 公里有氧跑**｜配速 5:30/km｜心率 152\n\n- 配速穩定，心率落在 Z3\n- 體感與數據相符",
      },
    ];
  }
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

const estimateUsage = (body: { messages: unknown; system?: unknown }, content: Block[]) => ({
  input: Math.round((JSON.stringify(body.messages).length + JSON.stringify(body.system ?? "").length) / 2),
  output: Math.round(JSON.stringify(content).length / 2),
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
async function streamAnthropic(res: ServerResponse, model: string, content: Block[], usage: { input: number; output: number }) {
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
      usage: { input_tokens: usage.input, output_tokens: 1 },
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
        await sleep(CHUNK_MS);
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

/** OpenAI 格式的請求轉成 reply() 使用的格式（只用得到最後一則與是否有工具） */
function fromOpenAI(body: { messages: OpenAIMessage[]; tools?: unknown[]; tool_choice?: unknown }) {
  return {
    messages: body.messages
      .filter((m) => m.role !== "system")
      .map((m): Message =>
        m.role === "tool"
          ? { role: "user", content: [{ type: "tool_result", content: m.content ?? "" }] }
          : { role: m.role, content: m.content ?? "" },
      ),
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

async function streamOpenAI(res: ServerResponse, content: Block[], usage: { input: number; output: number }, includeUsage: boolean) {
  res.writeHead(200, { "content-type": "text/event-stream", ...CORS });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
    send({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
  const { text, toolCalls, finishReason } = toOpenAI(content);

  chunk({ role: "assistant", content: "" });
  await sleep(THINK_MS);
  for (const piece of pieces(text)) {
    chunk({ content: piece });
    await sleep(CHUNK_MS);
  }
  for (const [index, call] of toolCalls.entries()) {
    chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] });
    chunk({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] });
  }
  chunk({}, finishReason);
  if (includeUsage) send({ id: "chatcmpl-mock", choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } });
  res.write("data: [DONE]\n\n");
  res.end();
}

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
    void readJson(req).then(async (body) => {
      const content = reply(body);
      const usage = estimateUsage(body, content);
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
        usage: { input_tokens: usage.input, output_tokens: usage.output },
      });
    }, () => send(400, { type: "error", error: { type: "invalid_request_error", message: "invalid JSON" } }));
    return;
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    void readJson(req).then(async (body) => {
      const content = reply(fromOpenAI(body));
      const usage = estimateUsage(body, content);
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
        usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
      });
    }, () => send(400, { error: { message: "invalid JSON" } }));
    return;
  }
  send(404, { type: "error", error: { type: "not_found_error", message: path } });
}).listen(PORT, "127.0.0.1", () => console.log(`mock upstream listening on http://127.0.0.1:${PORT}`));
