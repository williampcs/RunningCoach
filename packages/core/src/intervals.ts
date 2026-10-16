/** Intervals.icu — API 連線、活動拉取、資料正規化. */
import { addDays } from "./dates";
import type { Activity, ActivitySource, WellnessDay } from "./types";

const BASE_URL = "https://intervals.icu/api/v1";

/** Intervals.icu 回傳的活動（只列出用到的欄位） */
type RawActivity = Record<string, unknown>;

export interface IntervalsOptions {
  /** 個人 API key（Basic 驗證）。與 accessToken 擇一 */
  apiKey?: string;
  /** OAuth access token（Bearer 驗證） */
  accessToken?: string;
  /** 未設定時用 0，代表憑證所屬的選手 */
  athleteId?: string;
  /** 使用者時區的今天，YYYY-MM-DD */
  today: () => string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class IntervalsError extends Error {
  override name = "IntervalsError";
}

/** 將 m/s 轉換為配速字串，例：'5:30/km' */
export function speedToPace(speedMps: number | null | undefined): string | null {
  if (!speedMps || speedMps <= 0) return null;
  const secsPerKm = 1000 / speedMps;
  const mins = Math.floor(secsPerKm / 60);
  const secs = Math.floor(secsPerKm % 60);
  return `${mins}:${String(secs).padStart(2, "0")}/km`;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRun(activity: RawActivity): boolean {
  const sport = String(activity.type ?? activity.sport_type ?? "").toLowerCase();
  return sport.includes("run");
}

function byStartDesc(a: RawActivity, b: RawActivity): number {
  return String(b.start_date_local ?? "").localeCompare(String(a.start_date_local ?? ""));
}

export class IntervalsClient implements ActivitySource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: IntervalsOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private authHeader(): string {
    if (this.options.accessToken) return `Bearer ${this.options.accessToken}`;
    if (this.options.apiKey) return `Basic ${btoa(`API_KEY:${this.options.apiKey}`)}`;
    throw new IntervalsError("找不到 Intervals.icu API Key，請先完成設定。");
  }

  /** 將 Intervals.icu 活動資料正規化為系統統一口徑 */
  normalize(raw: RawActivity): Activity {
    const distanceM = num(raw.distance) || num(raw.icu_distance) || 0;
    const movingSec = num(raw.moving_time) || num(raw.elapsed_time) || 0;
    // 未提供 average_speed 且有距離與時間時自行推算
    const speedMps = num(raw.average_speed) || (movingSec > 0 ? distanceM / movingSec : null);
    const startLocal = typeof raw.start_date_local === "string" ? raw.start_date_local : "";

    return {
      intervals_id: String(raw.id),
      date: startLocal ? startLocal.slice(0, 10) : this.options.today(),
      type: "run",
      distance_km: Math.round(distanceM / 10) / 100,
      duration_min: Math.round(movingSec / 6) / 10,
      avg_hr: num(raw.average_heartrate),
      max_hr: num(raw.max_heartrate),
      avg_pace: speedToPace(speedMps),
      elevation_m: num(raw.total_elevation_gain),
      calories: num(raw.calories),
      training_load: num(raw.icu_training_load),
      raw_json: JSON.stringify(raw),
    };
  }

  /** 拉取最新一筆跑步活動（查詢最近 7 天） */
  async fetchLatestActivity(): Promise<Activity | null> {
    const latest = (await this.queryRuns(7))[0];
    return latest ? this.normalize(latest) : null;
  }

  /** 拉取最近 N 天的跑步活動列表（基本資料），新的在前 */
  async fetchActivities(days = 14): Promise<Activity[]> {
    return (await this.queryRuns(days)).map((raw) => this.normalize(raw));
  }

  /** 最近 N 天的恢復資料（靜息心率、HRV、睡眠等）；欄位視手錶與設定而定，沒有的就是 null */
  async fetchWellness(days = 14): Promise<WellnessDay[]> {
    const newest = this.options.today();
    const oldest = addDays(newest, -days);
    const data = await this.getJson(`/wellness?oldest=${oldest}&newest=${newest}`);
    if (!Array.isArray(data)) return [];
    return (data as Record<string, unknown>[]).flatMap((raw) => {
      const date = typeof raw.id === "string" ? raw.id.slice(0, 10) : typeof raw.date === "string" ? raw.date.slice(0, 10) : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
      const day: WellnessDay = {
        date,
        resting_hr: num(raw.restingHR),
        hrv: num(raw.hrv),
        sleep_secs: num(raw.sleepSecs),
        sleep_score: num(raw.sleepScore),
        readiness: num(raw.readiness),
        raw_json: JSON.stringify(raw),
      };
      const empty = [day.resting_hr, day.hrv, day.sleep_secs, day.sleep_score, day.readiness].every((v) => v === null);
      return empty ? [] : [day];
    });
  }

  private async getJson(path: string): Promise<unknown> {
    const athleteId = this.options.athleteId || "0";
    const base = (this.options.baseUrl ?? BASE_URL).replace(/\/+$/, "");
    const response = await this.fetchImpl(`${base}/athlete/${encodeURIComponent(athleteId)}${path}`, {
      headers: { authorization: this.authHeader(), accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? "（請確認 API Key 與 Athlete ID）" : "";
      throw new IntervalsError(`Intervals.icu 回應 ${response.status}${hint}`);
    }
    return response.json();
  }

  private async queryRuns(days: number): Promise<RawActivity[]> {
    const newest = this.options.today();
    const oldest = addDays(newest, -days);
    const data = await this.getJson(`/activities?oldest=${oldest}&newest=${newest}`);
    if (!Array.isArray(data)) return [];
    return (data as RawActivity[]).filter(isRun).sort(byStartDesc);
  }
}
