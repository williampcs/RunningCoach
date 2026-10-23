/**
 * 天氣（規格 11 #26）：Open-Meteo 的約略預報與跑步當下的天氣，只給教練評估用，不追求精確.
 *
 * 地點只有一個來源：選手為天氣設定的城市，四捨五入到 0.1°（約 10 km）. 座標只存在 OpenMeteoWeather 裡，
 * 只用來向 Open-Meteo 查天氣；Coach、系統提示、工具的回傳與資料庫都只看到天氣的數字，看不到地點.
 * Open-Meteo 的資料以 CC BY 4.0 授權，顯示的地方要標示來源（WEATHER_CREDIT）.
 */
import { addDays, daysBetween } from "./dates";

export const WEATHER_CREDIT = { label: "Weather data by Open-Meteo.com", href: "https://open-meteo.com/" } as const;

/** 四捨五入後的座標 */
export interface WeatherPlace {
  lat: number;
  lon: number;
}

/** 座標只留到 0.1°（約 10 km），Open-Meteo 收到的也是這個 */
export function roundPlace(lat: number, lon: number): WeatherPlace {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error(`座標不正確：${lat}, ${lon}`);
  }
  const round = (v: number) => Math.round(v * 10) / 10 || 0;
  return { lat: round(lat), lon: round(lon) };
}

/** 逐時，時間為選手時區的當地時間，例：2026-10-23T07:00 */
export interface WeatherHour {
  time: string;
  temp: number | null;
  apparent: number | null;
  dewPoint: number | null;
  humidity: number | null;
  precipProb: number | null;
  precip: number | null;
  wind: number | null;
  code: number | null;
}

export interface WeatherDay {
  date: string;
  code: number | null;
  tempMax: number | null;
  tempMin: number | null;
  apparentMax: number | null;
  precipProb: number | null;
  precipSum: number | null;
  windMax: number | null;
}

export interface AirQualityHour {
  time: string;
  usAqi: number | null;
  pm25: number | null;
}

export interface WeatherForecast {
  days: WeatherDay[];
  hours: WeatherHour[];
  /** 取不到時為空 */
  air: AirQualityHour[];
}

/** Coach 用的天氣來源；地點藏在實作裡 */
export interface WeatherSource {
  /** 今天起 7 天的預報（含逐時與空氣品質） */
  forecast(): Promise<WeatherForecast>;
  /** 過去某一天的逐時天氣（92 天內） */
  pastDay(date: string): Promise<WeatherHour[]>;
}

/** Open-Meteo 的過去天氣（past_days）最多 92 天 */
export const WEATHER_PAST_DAYS_MAX = 92;
const FORECAST_DAYS = 7;
const FORECAST_TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 8000;

const HOURLY = "temperature_2m,apparent_temperature,dew_point_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m";
const DAILY = "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_probability_max,precipitation_sum,wind_speed_10m_max";

export interface OpenMeteoUrls {
  forecast: string;
  airQuality: string;
  geocoding: string;
}

export const OPEN_METEO_URLS: OpenMeteoUrls = {
  forecast: "https://api.open-meteo.com/v1/forecast",
  airQuality: "https://air-quality-api.open-meteo.com/v1/air-quality",
  geocoding: "https://geocoding-api.open-meteo.com/v1/search",
};

/** 測試或本機模擬：三個服務都在同一個網址底下（{base}/v1/forecast…） */
export function openMeteoUrlsAt(base: string): OpenMeteoUrls {
  const b = base.replace(/\/+$/, "");
  return { forecast: `${b}/v1/forecast`, airQuality: `${b}/v1/air-quality`, geocoding: `${b}/v1/search` };
}

type Fetch = typeof fetch;

async function getJson(fetchFn: Fetch, url: string): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo 回應 ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function column(block: Record<string, unknown> | undefined, key: string, i: number): number | null {
  const values = block?.[key];
  const v = Array.isArray(values) ? values[i] : null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function times(block: Record<string, unknown> | undefined): string[] {
  const t = block?.time;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

function parseHours(json: Record<string, unknown>): WeatherHour[] {
  const h = json.hourly as Record<string, unknown> | undefined;
  return times(h).map((time, i) => ({
    time,
    temp: column(h, "temperature_2m", i),
    apparent: column(h, "apparent_temperature", i),
    dewPoint: column(h, "dew_point_2m", i),
    humidity: column(h, "relative_humidity_2m", i),
    precipProb: column(h, "precipitation_probability", i),
    precip: column(h, "precipitation", i),
    wind: column(h, "wind_speed_10m", i),
    code: column(h, "weather_code", i),
  }));
}

function parseDays(json: Record<string, unknown>): WeatherDay[] {
  const d = json.daily as Record<string, unknown> | undefined;
  return times(d).map((date, i) => ({
    date,
    code: column(d, "weather_code", i),
    tempMax: column(d, "temperature_2m_max", i),
    tempMin: column(d, "temperature_2m_min", i),
    apparentMax: column(d, "apparent_temperature_max", i),
    precipProb: column(d, "precipitation_probability_max", i),
    precipSum: column(d, "precipitation_sum", i),
    windMax: column(d, "wind_speed_10m_max", i),
  }));
}

export class OpenMeteoWeather implements WeatherSource {
  // 地點不對外公開：只在組查詢網址時用到
  readonly #place: WeatherPlace;
  readonly #timeZone: string;
  readonly #today: () => string;
  readonly #urls: OpenMeteoUrls;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  #cached: { at: number; day: string; value: Promise<WeatherForecast> } | null = null;
  readonly #past = new Map<string, Promise<WeatherHour[]>>();

  constructor(options: {
    place: WeatherPlace;
    timeZone: string;
    today: () => string;
    urls?: OpenMeteoUrls;
    fetch?: Fetch;
    now?: () => number;
  }) {
    this.#place = roundPlace(options.place.lat, options.place.lon);
    this.#timeZone = options.timeZone;
    this.#today = options.today;
    this.#urls = options.urls ?? OPEN_METEO_URLS;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => Date.now());
  }

  #query(extra: Record<string, string>): string {
    return new URLSearchParams({
      latitude: String(this.#place.lat),
      longitude: String(this.#place.lon),
      timezone: this.#timeZone,
      ...extra,
    }).toString();
  }

  forecast(): Promise<WeatherForecast> {
    const day = this.#today();
    const cached = this.#cached;
    if (cached && cached.day === day && this.#now() - cached.at < FORECAST_TTL_MS) return cached.value;
    const value = (async () => {
      const weather = getJson(this.#fetch, `${this.#urls.forecast}?${this.#query({ hourly: HOURLY, daily: DAILY, forecast_days: String(FORECAST_DAYS) })}`);
      // 空氣品質取不到時不影響天氣
      const air = getJson(this.#fetch, `${this.#urls.airQuality}?${this.#query({ hourly: "us_aqi,pm2_5", forecast_days: "2" })}`)
        .then((json) => {
          const h = json.hourly as Record<string, unknown> | undefined;
          return times(h).map((time, i) => ({ time, usAqi: column(h, "us_aqi", i), pm25: column(h, "pm2_5", i) }));
        })
        .catch(() => [] as AirQualityHour[]);
      const json = await weather;
      return { days: parseDays(json), hours: parseHours(json), air: await air };
    })();
    this.#cached = { at: this.#now(), day, value };
    // 失敗的不留著，下次再試
    value.catch(() => {
      if (this.#cached?.value === value) this.#cached = null;
    });
    return value;
  }

  pastDay(date: string): Promise<WeatherHour[]> {
    const today = this.#today();
    const ago = daysBetween(date, today);
    if (ago < 0 || ago > WEATHER_PAST_DAYS_MAX) return Promise.resolve([]);
    // 今天的還在變，不快取
    const key = ago === 0 ? null : date;
    const hit = key ? this.#past.get(key) : undefined;
    if (hit) return hit;
    const value = getJson(
      this.#fetch,
      `${this.#urls.forecast}?${this.#query({ hourly: HOURLY, past_days: String(Math.max(1, ago)), forecast_days: "1" })}`,
    ).then((json) => parseHours(json).filter((h) => h.time.startsWith(date)));
    if (key) {
      if (this.#past.size > 40) this.#past.clear();
      this.#past.set(key, value);
      value.catch(() => this.#past.delete(key));
    }
    return value;
  }
}

/** 為天氣找城市（設定畫面用）：送出的是選手輸入的城市名稱 */
export interface PlaceCandidate extends WeatherPlace {
  /** 例：臺北市, 臺灣 */
  label: string;
}

export async function searchPlaces(
  name: string,
  options: { url?: string; language?: string; fetch?: Fetch } = {},
): Promise<PlaceCandidate[]> {
  const query = name.trim();
  if (query.length < 2) return [];
  const params = new URLSearchParams({ name: query, count: "8", language: options.language ?? "zh", format: "json" });
  const json = await getJson(options.fetch ?? ((i, init) => fetch(i, init)), `${options.url ?? OPEN_METEO_URLS.geocoding}?${params}`);
  const results = Array.isArray(json.results) ? (json.results as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  const out: PlaceCandidate[] = [];
  for (const r of results) {
    if (typeof r.latitude !== "number" || typeof r.longitude !== "number" || typeof r.name !== "string") continue;
    const parts = [r.name, r.admin1, r.country].filter((p): p is string => typeof p === "string" && p !== "");
    const label = [...new Set(parts)].join(", ");
    const place = roundPlace(r.latitude, r.longitude);
    const key = `${label}|${place.lat}|${place.lon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, ...place });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 給教練的文字
// ---------------------------------------------------------------------------

/** WMO 天氣代碼 → 中文 */
export function weatherText(code: number | null): string {
  if (code === null) return "天氣不明";
  if (code === 0) return "晴";
  if (code <= 2) return "晴時多雲";
  if (code === 3) return "陰";
  if (code === 45 || code === 48) return "有霧";
  if (code >= 51 && code <= 57) return "毛毛雨";
  if (code === 65 || code === 67) return "大雨";
  if (code >= 61 && code <= 67) return "雨";
  if (code >= 71 && code <= 77) return "雪";
  if (code === 82) return "大陣雨";
  if (code >= 80 && code <= 82) return "陣雨";
  if (code >= 85 && code <= 86) return "陣雪";
  if (code >= 95) return "雷雨";
  return "天氣不明";
}

const deg = (v: number | null) => (v === null ? "?" : `${Math.round(v)}°C`);

function dayLine(d: WeatherDay): string {
  const parts = [weatherText(d.code), `${deg(d.tempMin)}–${deg(d.tempMax)}`];
  if (d.apparentMax !== null && d.tempMax !== null && d.apparentMax - d.tempMax >= 2) parts.push(`體感最高 ${deg(d.apparentMax)}`);
  if (d.precipProb !== null) parts.push(`降雨機率 ${Math.round(d.precipProb)}%`);
  if (d.precipSum !== null && d.precipSum >= 1) parts.push(`雨量約 ${Math.round(d.precipSum)} mm`);
  if (d.windMax !== null && d.windMax >= 30) parts.push(`風大（最大約 ${Math.round(d.windMax)} km/h）`);
  return parts.join("，");
}

function hourLine(h: WeatherHour): string {
  const parts = [`${h.time.slice(11, 16)} ${deg(h.temp)}`];
  if (h.dewPoint !== null) parts.push(`露點 ${deg(h.dewPoint)}`);
  if (h.precipProb !== null) parts.push(`降雨 ${Math.round(h.precipProb)}%`);
  return parts.join("、");
}

function maxOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length ? Math.max(...nums) : null;
}

/** 白天（05–21 點）的逐時 */
function daytime(hours: WeatherHour[], date: string): WeatherHour[] {
  return hours.filter((h) => h.time.startsWith(date) && Number(h.time.slice(11, 13)) >= 5 && Number(h.time.slice(11, 13)) <= 21);
}

function aqiLabel(aqi: number): string {
  if (aqi <= 50) return "良好";
  if (aqi <= 100) return "普通";
  if (aqi <= 150) return "對敏感族群不健康";
  if (aqi <= 200) return "不健康";
  return "非常不健康";
}

/** 系統提示的一行：今天的約略天氣 */
export function todayWeatherLine(f: WeatherForecast, today: string): string | null {
  const day = f.days.find((d) => d.date === today);
  if (!day) return null;
  const parts = [dayLine(day)];
  const dew = maxOf(daytime(f.hours, today).map((h) => h.dewPoint));
  if (dew !== null) parts.push(`白天露點最高 ${deg(dew)}`);
  const aqi = maxOf(f.air.filter((a) => a.time.startsWith(today)).map((a) => a.usAqi));
  if (aqi !== null) parts.push(`空氣品質${aqiLabel(aqi)}（US AQI 最高 ${Math.round(aqi)}）`);
  return parts.join("，");
}

/** get_weather 的回傳：每日預報；指定日期時加上那天每 3 小時的天氣 */
export function weatherForTool(f: WeatherForecast, today: string, date?: string | null): string {
  const lines = ["天氣預報（Open-Meteo 的模型預報，約略，給評估用）："];
  for (const d of f.days) {
    const label = d.date === today ? "今天" : d.date === addDays(today, 1) ? "明天" : "";
    lines.push(`- ${d.date}${label ? `（${label}）` : ""}：${dayLine(d)}`);
  }
  if (date) {
    const hours = f.hours.filter((h) => h.time.startsWith(date) && Number(h.time.slice(11, 13)) % 3 === 0 && Number(h.time.slice(11, 13)) >= 3);
    if (hours.length) {
      lines.push("", `${date} 每 3 小時：`, ...hours.map((h) => `- ${hourLine(h)}`));
    } else {
      lines.push("", `沒有 ${date} 的逐時預報（只有今天起 7 天）。`);
    }
  }
  return lines.join("\n");
}

/**
 * 跑步當下的天氣（跑後分析用）：開始時間到結束的逐時平均.
 * start 為當地時間 YYYY-MM-DDTHH:mm；沒有開始時間或資料時回傳 null
 */
export function runWeatherText(hours: WeatherHour[], start: string, durationMin: number | null): string | null {
  const startHour = Number(start.slice(11, 13));
  if (!Number.isFinite(startHour)) return null;
  const endHour = Math.min(23, Math.floor(startHour + Number(start.slice(14, 16)) / 60 + (durationMin ?? 30) / 60));
  const during = hours.filter((h) => h.time.startsWith(start.slice(0, 10)) && Number(h.time.slice(11, 13)) >= startHour && Number(h.time.slice(11, 13)) <= endHour);
  if (!during.length) return null;
  const avg = (key: keyof Omit<WeatherHour, "time">) => {
    const nums = during.map((h) => h[key]).filter((v): v is number => v !== null);
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  };
  const temp = avg("temp");
  if (temp === null) return null;
  const parts = [`約 ${deg(temp)}`];
  const apparent = avg("apparent");
  if (apparent !== null && Math.abs(apparent - temp) >= 2) parts[0] += `（體感 ${deg(apparent)}）`;
  const dew = avg("dewPoint");
  if (dew !== null) parts.push(`露點 ${deg(dew)}`);
  const humidity = avg("humidity");
  if (humidity !== null) parts.push(`濕度 ${Math.round(humidity)}%`);
  const rain = during.reduce((sum, h) => sum + (h.precip ?? 0), 0);
  parts.push(rain >= 0.5 ? `有雨（約 ${rain.toFixed(1)} mm）` : "沒下雨");
  const wind = avg("wind");
  if (wind !== null && wind >= 20) parts.push(`風約 ${Math.round(wind)} km/h`);
  return parts.join("、");
}

/** 從原始活動資料取當地開始時間，例：2026-10-19T07:12 */
export function startLocalOf(rawJson: string | null | undefined): string | null {
  if (!rawJson) return null;
  try {
    const start = (JSON.parse(rawJson) as { start_date_local?: unknown }).start_date_local;
    return typeof start === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(start) ? start.slice(0, 16) : null;
  } catch {
    return null;
  }
}

/** 一趟跑步的天氣（給摘要的 prompt）；沒設定天氣、太久以前或取不到時為 null，不丟錯 */
export async function runWeatherNote(
  weather: WeatherSource | null | undefined,
  run: { date: string; raw_json?: string | null; duration_min?: number | null },
): Promise<string | null> {
  if (!weather) return null;
  const start = startLocalOf(run.raw_json);
  if (!start || start.slice(0, 10) !== run.date) return null;
  try {
    return runWeatherText(await weather.pastDay(run.date), start, run.duration_min ?? null);
  } catch {
    return null;
  }
}

/** 教練動態的天氣提醒：濕熱、下雨、空氣品質差 */
export interface WeatherAlert {
  kind: "heat" | "rain" | "air";
  tone: "warn" | "info";
  title: string;
  detail: string;
}

/** 露點達這個值以上跑起來明顯悶熱 */
const HUMID_DEW_POINT = 22;
const HOT_APPARENT = 32;

export function weatherAlerts(f: WeatherForecast, today: string): WeatherAlert[] {
  const day = f.days.find((d) => d.date === today);
  if (!day) return [];
  const alerts: WeatherAlert[] = [];
  const hours = daytime(f.hours, today);
  const dew = maxOf(hours.map((h) => h.dewPoint));
  const apparent = maxOf([day.apparentMax, ...hours.map((h) => h.apparent)]);
  if ((dew !== null && dew >= HUMID_DEW_POINT) || (apparent !== null && apparent >= HOT_APPARENT)) {
    const facts = [apparent !== null ? `體感最高 ${deg(apparent)}` : null, dew !== null ? `露點 ${deg(dew)}` : null].filter(Boolean).join("、");
    alerts.push({
      kind: "heat",
      tone: apparent !== null && apparent >= 36 ? "warn" : "info",
      title: `今天濕熱（${facts}）`,
      detail: "配速放慢、以心率或體感為準，跑前跑中補水；可以改在清晨或傍晚跑。",
    });
  }
  if (day.precipProb !== null && day.precipProb >= 70 && (day.precipSum ?? 0) >= 2) {
    alerts.push({
      kind: "rain",
      tone: "info",
      title: `今天可能下雨（降雨機率 ${Math.round(day.precipProb)}%）`,
      detail: "路面濕滑時放慢、注意轉彎；也可以把課換到別天或改在室內。",
    });
  }
  const aqi = maxOf(f.air.filter((a) => a.time.startsWith(today) && Number(a.time.slice(11, 13)) >= 5 && Number(a.time.slice(11, 13)) <= 21).map((a) => a.usAqi));
  if (aqi !== null && aqi > 100) {
    alerts.push({
      kind: "air",
      tone: aqi > 150 ? "warn" : "info",
      title: `今天空氣品質${aqiLabel(aqi)}（US AQI 最高 ${Math.round(aqi)}）`,
      detail: aqi > 150 ? "建議減少戶外的高強度訓練，改輕鬆跑、室內或休息。" : "呼吸道比較敏感的話，避開空氣最差的時段或降低強度。",
    });
  }
  return alerts;
}
