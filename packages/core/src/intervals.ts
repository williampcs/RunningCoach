/** Intervals.icu — API 連線、活動拉取、資料正規化. */
import { addDays } from "./dates";
import type { Activity, ActivitySource, BestEffort, OtherActivity, PaceCurveSummary, RunSettings, WellnessDay } from "./types";

/** 預設的 API 網址（隱私說明頁列出網頁版會連的網址，測試會對照） */
export const INTERVALS_BASE_URL = "https://intervals.icu/api/v1";

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

/** 最佳配速曲線中，推算 VDOT 用的標準距離（公尺） */
export const EFFORT_DISTANCES = [1609.34, 3000, 5000, 10_000, 21_097.5, 42_195];

const positive = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/** 匯入完整歷史時一次抓一年，比一般的請求久 */
const HISTORY_TIMEOUT_MS = 60_000;

function isRun(activity: RawActivity): boolean {
  const sport = String(activity.type ?? activity.sport_type ?? "").toLowerCase();
  return sport.includes("run");
}

/**
 * Intervals.icu 不經 API 提供從 Strava 匯入的活動，只列出一筆沒有內容的紀錄（附 _note）。
 * 欄位依搜尋到的說明，還沒有以真實帳號確認：有 _note，或來源是 Strava 又沒有距離與時間，就當成拿不到內容
 */
function isUnavailable(activity: RawActivity): boolean {
  if (typeof activity._note === "string" && activity._note) return true;
  return String(activity.source ?? "").toUpperCase() === "STRAVA" && activity.distance == null && activity.moving_time == null;
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
        hrv_sdnn: num(raw.hrvSDNN),
        sleep_secs: num(raw.sleepSecs),
        sleep_score: num(raw.sleepScore),
        readiness: num(raw.readiness),
        raw_json: JSON.stringify(raw),
      };
      const empty = [day.resting_hr, day.hrv, day.hrv_sdnn, day.sleep_secs, day.sleep_score, day.readiness].every(
        (v) => v === null,
      );
      return empty ? [] : [day];
    });
  }

  /** 跑步的運動設定（包含 Run 的那組）；只取閾值與區間，選手的其他資料（姓名、email 等）不留 */
  async fetchRunSettings(): Promise<RunSettings | null> {
    const athlete = await this.getJson("");
    const all = (athlete as { sportSettings?: unknown } | null)?.sportSettings;
    const run = Array.isArray(all)
      ? (all as Record<string, unknown>[]).find((s) => Array.isArray(s.types) && s.types.includes("Run"))
      : undefined;
    if (!run) return null;
    const zones = Array.isArray(run.hr_zones) ? run.hr_zones.map(positive).filter((z): z is number => z !== null) : [];
    return {
      lthr: positive(run.lthr),
      max_hr: positive(run.max_hr),
      hr_zones: zones.length ? zones : null,
      threshold_pace: positive(run.threshold_pace),
    };
  }

  /** 最近 N 天跑步的最佳配速曲線：Intervals.icu 擬合的臨界速度，以及標準距離的最佳成績 */
  async fetchPaceCurve(days = 90): Promise<PaceCurveSummary | null> {
    const data = (await this.getJson(`/pace-curves.json?type=Run&curves=${days}d&pmType=CS`)) as {
      list?: Record<string, unknown>[];
      activities?: Record<string, { race?: unknown; start_date_local?: unknown }>;
    } | null;
    const curve = data?.list?.[0];
    if (!curve) return null;
    const distances = Array.isArray(curve.distance) ? (curve.distance as unknown[]) : [];
    const secs = Array.isArray(curve.values) ? (curve.values as unknown[]) : [];
    const ids = Array.isArray(curve.activity_id) ? (curve.activity_id as unknown[]) : [];
    const efforts: BestEffort[] = [];
    for (const target of EFFORT_DISTANCES) {
      const i = distances.findIndex((d) => typeof d === "number" && Math.abs(d - target) / target < 0.01);
      const time = i >= 0 ? positive(secs[i]) : null;
      if (time === null) continue;
      const activity = data?.activities?.[String(ids[i])];
      const start = typeof activity?.start_date_local === "string" ? activity.start_date_local.slice(0, 10) : null;
      efforts.push({ distance_m: target, secs: time, race: activity?.race === true, date: start });
    }
    const models = Array.isArray(curve.paceModels) ? (curve.paceModels as Record<string, unknown>[]) : [];
    const cs = models.find((m) => m.type === "CS");
    return { days, critical_speed: positive(cs?.criticalSpeed), d_prime: positive(cs?.dPrime), efforts };
  }

  /** 匯入完整歷史：一次抓一段期間，請求放寬逾時 */
  async fetchRunsBetween(oldest: string, newest: string): Promise<{ runs: Activity[]; unavailable: number }> {
    const data = await this.getJson(`/activities?oldest=${oldest}&newest=${newest}`, HISTORY_TIMEOUT_MS);
    const all = Array.isArray(data) ? (data as RawActivity[]) : [];
    const unavailable = all.filter(isUnavailable).length;
    const runs = all.filter((a) => !isUnavailable(a) && isRun(a) && a.id != null).sort(byStartDesc);
    return { runs: runs.map((raw) => this.normalize(raw)), unavailable };
  }

  private async getJson(path: string, timeoutMs = 15_000): Promise<unknown> {
    const athleteId = this.options.athleteId || "0";
    const base = (this.options.baseUrl ?? INTERVALS_BASE_URL).replace(/\/+$/, "");
    const response = await this.fetchImpl(`${base}/athlete/${encodeURIComponent(athleteId)}${path}`, {
      headers: { authorization: this.authHeader(), accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? "（請確認 API Key 與 Athlete ID）" : "";
      throw new IntervalsError(`Intervals.icu 回應 ${response.status}${hint}`);
    }
    return response.json();
  }

  /** 最近 N 天跑步以外的運動（騎車、游泳、肌力訓練等） */
  async fetchOtherActivities(days = 14): Promise<OtherActivity[]> {
    return (await this.queryActivities(days)).filter((a) => !isRun(a) && a.id != null).map((raw) => {
      const start = typeof raw.start_date_local === "string" ? raw.start_date_local : "";
      const seconds = num(raw.moving_time) || num(raw.elapsed_time);
      const meters = num(raw.distance);
      return {
        intervals_id: String(raw.id),
        date: start ? start.slice(0, 10) : this.options.today(),
        type: String(raw.type ?? raw.sport_type ?? "Other"),
        duration_min: seconds ? Math.round(seconds / 6) / 10 : null,
        distance_km: meters ? Math.round(meters / 10) / 100 : null,
        avg_hr: num(raw.average_heartrate),
        training_load: num(raw.icu_training_load),
        raw_json: JSON.stringify(raw),
      };
    });
  }

  /** 最近 N 天跑步以外的活動類型，例：["Walk", "Ride"] */
  async fetchOtherActivityTypes(days = 14): Promise<string[]> {
    return (await this.queryActivities(days))
      .filter((a) => !isRun(a))
      .map((a) => String(a.type ?? a.sport_type ?? "Other"));
  }

  private async queryActivities(days: number): Promise<RawActivity[]> {
    const newest = this.options.today();
    const oldest = addDays(newest, -days);
    const data = await this.getJson(`/activities?oldest=${oldest}&newest=${newest}`);
    return Array.isArray(data) ? (data as RawActivity[]) : [];
  }

  private async queryRuns(days: number): Promise<RawActivity[]> {
    return (await this.queryActivities(days)).filter(isRun).sort(byStartDesc);
  }
}
