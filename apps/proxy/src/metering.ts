/** 從上游回應取出 token 用量 — 只讀 usage 欄位，內容原樣轉發、不保留. */
import type { TokenUsage } from "./policy";

interface WireUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** 以回應中出現的欄位更新用量（串流中後到的事件帶的是累計值） */
function merge(usage: TokenUsage, wire: WireUsage | undefined | null): void {
  if (!wire) return;
  if (typeof wire.input_tokens === "number") usage.input = wire.input_tokens;
  if (typeof wire.output_tokens === "number") usage.output = wire.output_tokens;
  if (typeof wire.cache_read_input_tokens === "number") usage.cacheRead = wire.cache_read_input_tokens;
  if (typeof wire.cache_creation_input_tokens === "number") usage.cacheWrite = wire.cache_creation_input_tokens;
}

/**
 * 從回應讀到的用量.
 * final：拿到了上游最後的用量（非串流的 usage、串流的 message_delta）；inputKnown：至少知道輸入的用量（串流的 message_start）.
 * 沒有 final 時，輸出 token 只是到那時為止的數字，計費照預扣的算（handler.ts）
 */
export interface MeterResult {
  usage: TokenUsage;
  final: boolean;
  inputKnown: boolean;
}

/** 非串流回應 */
export function usageFromJson(text: string): MeterResult {
  const usage = emptyUsage();
  let wire: WireUsage | undefined;
  try {
    wire = (JSON.parse(text) as { usage?: WireUsage }).usage;
    merge(usage, wire);
  } catch {
    // 上游回了非 JSON 的內容：沒有可計的用量
  }
  const final = typeof wire?.output_tokens === "number";
  return { usage, final, inputKnown: final || typeof wire?.input_tokens === "number" };
}

/**
 * 串流回應：位元組原樣往下游送，同時掃描 message_start / message_delta 事件中的 usage。
 * 串流結束、出錯或下游中斷時呼叫一次 onDone；沒有讀到 message_delta 的用量就結束的，final 是 false.
 */
export function meterSseStream(
  body: ReadableStream<Uint8Array>,
  onDone: (result: MeterResult) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const usage = emptyUsage();
  let buffer = "";
  let finished = false;
  let final = false;
  let inputKnown = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    onDone({ usage, final, inputKnown });
  };

  const scan = (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      // 只解析帶有 usage 的事件，其餘（文字增量等）直接略過
      if (!line.includes('"usage"')) continue;
      try {
        const event = JSON.parse(line.slice(5)) as { type?: string; usage?: WireUsage; message?: { usage?: WireUsage } };
        merge(usage, event.message?.usage);
        merge(usage, event.usage);
        if (typeof event.message?.usage?.input_tokens === "number" || typeof event.usage?.input_tokens === "number") inputKnown = true;
        // message_delta 帶的是最後的累計用量
        if (event.type === "message_delta" && typeof event.usage?.output_tokens === "number") final = true;
      } catch {
        // 不完整或非 JSON 的 data 行
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        scan(value);
        controller.enqueue(value);
      } catch (e) {
        finish();
        controller.error(e);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
}
