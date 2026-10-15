import { openNodeSqlite } from "@running-coach/sqlite-node";

import {
  Coach,
  type Activity,
  type ActivitySource,
  type ChatRequest,
  type CoachSettings,
  type LlmProvider,
  type NextOptions,
  type ToolResult,
  type Turn,
} from "../src";

export const NOW = new Date("2026-10-10T04:00:00Z"); // 台北時間 2026-10-10（星期六）12:00

export function turn(partial: Partial<Turn> = {}): Turn {
  return {
    text: "",
    toolCalls: [],
    finish: "ok",
    usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20 },
    ...partial,
  };
}

export function toolTurn(name: string, input: Record<string, unknown> = {}, id = `call_${name}`): Turn {
  return turn({ finish: "tool_use", toolCalls: [{ id, name, input }] });
}

export interface RecordedCall {
  request: ChatRequest;
  toolResults?: ToolResult[];
  disableTools?: boolean;
  /** 串流呼叫時才有；腳本中的函式可以用它模擬逐段產生的文字 */
  onText?: (text: string) => void;
}

/** 依序回放預先寫好的回應，並記錄每次呼叫 */
export class ScriptedProvider implements LlmProvider {
  readonly calls: RecordedCall[] = [];

  constructor(readonly script: (Turn | Error | ((call: RecordedCall) => Turn | Promise<Turn>))[]) {}

  effortFor(_model: string, effort: string) {
    return effort;
  }

  startChat(request: ChatRequest) {
    return {
      next: async (opts: NextOptions = {}) => {
        const call = { request, ...opts };
        this.calls.push(call);
        const step = this.script.shift();
        if (!step) throw new Error("ScriptedProvider：腳本已用完");
        if (step instanceof Error) throw step;
        return typeof step === "function" ? step(call) : step;
      },
    };
  }
}

export class FakeActivities implements ActivitySource {
  constructor(public activities: Activity[] = []) {}

  async fetchLatestActivity() {
    return this.activities[0] ?? null;
  }

  async fetchActivities() {
    return this.activities;
  }
}

export function activity(partial: Partial<Activity> = {}): Activity {
  return {
    intervals_id: "i100",
    date: "2026-10-10",
    type: "run",
    distance_km: 10.02,
    duration_min: 55.1,
    avg_hr: 152,
    max_hr: 171,
    avg_pace: "5:30/km",
    elevation_m: 48,
    calories: 640,
    training_load: 72,
    raw_json: JSON.stringify({ id: "i100", icu_training_load: 72 }),
    ...partial,
  };
}

export async function makeCoach(
  script: ConstructorParameters<typeof ScriptedProvider>[0] = [],
  options: { activities?: Activity[]; settings?: Partial<CoachSettings>; now?: () => Date } = {},
) {
  const provider = new ScriptedProvider(script);
  const activities = new FakeActivities(options.activities);
  const driver = openNodeSqlite(":memory:");
  const logs: string[] = [];
  const coach = new Coach({
    driver,
    llm: {
      provider,
      models: { chat: "chat-model", summary: "summary-model", compress: "compress-model" },
      chatEffort: "medium",
    },
    activities,
    settings: options.settings,
    now: options.now ?? (() => NOW),
    logger: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
      error: (m) => logs.push(`error ${m}`),
    },
  });
  await coach.init();
  return { coach, provider, activities, driver, logs };
}
