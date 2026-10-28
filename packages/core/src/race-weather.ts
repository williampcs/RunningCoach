/**
 * 比賽地點的天氣（規格 12.31 第 3 點）：比賽在 16 天內、賽事設定了地點時，查起跑到預計完賽的每小時天氣.
 *
 * 地點和天氣的城市一樣只用來查天氣：賽事的地點只存顯示的名稱與四捨五入的座標（約 10 km），
 * 座標只在 OpenMeteoRaceWeather 組查詢網址時用到；教練的工具、系統提示與看板只看得到天氣的數字，看不到地點.
 * 不依賴天氣的設定：沒設天氣城市的人也能用.
 */
import { daysBetween } from "./dates";
import { parseDuration } from "./training-values";
import type { Race } from "./types";
import { OPEN_METEO_URLS, roundPlace, weatherText, type OpenMeteoUrls, type WeatherHour, type WeatherPlace } from "./weather";

/** Open-Meteo 的預報最多 16 天（今天算第一天）：比賽在今天起第 15 天以內才查得到 */
export const RACE_FORECAST_DAYS = 16;
export const RACE_FORECAST_MAX_AHEAD = RACE_FORECAST_DAYS - 1;

const HOURLY = "temperature_2m,apparent_temperature,dew_point_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m";
const TTL_MS = 60 * 60_000;
const TIMEOUT_MS = 8000;

/** 賽事的地點：選手在賽事頁選的城市（和天氣設定的城市分開） */
export interface RacePlace extends WeatherPlace {
  /** 顯示用的名稱，例：台北市、Osaka, Japan */
  label: string;
}

/** 賽事上的地點欄位（schema 15）→ 地點；沒有設定時是 null */
export function racePlaceOf(r: Pick<Race, "place_label" | "place_lat" | "place_lon">): RacePlace | null {
  if (r.place_lat == null || r.place_lon == null) return null;
  return { label: r.place_label ?? "", lat: r.place_lat, lon: r.place_lon };
}

/** 沒有目標時間時，依距離估計的速度（偏慢，涵蓋大多數人在場上的時間；我們的經驗值） */
const ESTIMATE = { runMinPerKm: 7, rideKmh: 25 };

/** 預計在場上多久（分鐘）：有目標時間用目標時間，沒有時依距離估 */
export function raceMinutes(r: Pick<Race, "distance_km" | "target_time" | "sport">): { minutes: number; estimated: boolean } {
  const target = parseDuration(r.target_time);
  if (target) return { minutes: target / 60, estimated: false };
  const minutes = r.sport === "ride" ? (r.distance_km / ESTIMATE.rideKmh) * 60 : r.distance_km * ESTIMATE.runMinPerKm;
  return { minutes: Math.max(30, minutes), estimated: true };
}

const hourOf = (h: WeatherHour) => Number(h.time.slice(11, 13));

/**
 * 比賽時段的逐時天氣：起跑那個小時到預計完賽的那個小時；沒有起跑時間時是白天（05–21 點）每 3 小時.
 * 時間是比賽地點的當地時間
 */
export function raceHours(hours: WeatherHour[], race: Pick<Race, "date" | "start_time" | "distance_km" | "target_time" | "sport">): WeatherHour[] {
  const day = hours.filter((h) => h.time.startsWith(race.date));
  if (!race.start_time) return day.filter((h) => hourOf(h) >= 5 && hourOf(h) <= 21 && hourOf(h) % 3 === 0);
  const start = Number(race.start_time.slice(0, 2)) + Number(race.start_time.slice(3, 5)) / 60;
  const end = start + raceMinutes(race).minutes / 60;
  return day.filter((h) => hourOf(h) >= Math.floor(start) && hourOf(h) <= Math.min(23, Math.floor(end)));
}

const deg = (v: number | null) => (v === null ? "?" : `${Math.round(v)}°C`);
const nums = (values: (number | null)[]) => values.filter((v): v is number => v !== null);
const max = (values: (number | null)[]) => (nums(values).length ? Math.max(...nums(values)) : null);
const min = (values: (number | null)[]) => (nums(values).length ? Math.min(...nums(values)) : null);

/** 露點、體感達這個值以上跑起來明顯悶熱（和今天的天氣提醒一樣） */
const HUMID_DEW_POINT = 22;
const HOT_APPARENT = 32;

export interface RaceWeatherSummary {
  /** 一句話，例：濕熱，可能下雨；天氣普通時是「舒適」 */
  label: string;
  /** 看板的標籤，例：體感 32°C、降雨 60% */
  tags: string[];
  /** 完整的一句（問教練、工具的結果用），例：濕熱，可能下雨：體感 27–32°C、露點最高 24°C、降雨機率最高 60% */
  line: string;
}

/** 比賽時段的天氣：一句話與標籤 */
export function raceWeatherSummary(hours: WeatherHour[]): RaceWeatherSummary | null {
  if (!hours.length || !nums(hours.map((h) => h.temp)).length) return null;
  const apparentMax = max(hours.map((h) => h.apparent ?? h.temp));
  const apparentMin = min(hours.map((h) => h.apparent ?? h.temp));
  const dew = max(hours.map((h) => h.dewPoint));
  const rain = max(hours.map((h) => h.precipProb));
  const wind = max(hours.map((h) => h.wind));
  const labels: string[] = [];
  if ((dew !== null && dew >= HUMID_DEW_POINT) || (apparentMax !== null && apparentMax >= HOT_APPARENT)) labels.push("濕熱");
  else if (apparentMax !== null && apparentMax >= 26) labels.push("偏熱");
  else if (apparentMin !== null && apparentMin <= 5) labels.push("寒冷");
  else if (apparentMax !== null && apparentMax <= 15) labels.push("涼爽");
  if (rain !== null && rain >= 50) labels.push("可能下雨");
  if (wind !== null && wind >= 30) labels.push("風大");
  const label = labels.length ? labels.join("，") : "舒適";

  const tags = [
    apparentMax !== null ? `體感 ${deg(apparentMax)}` : null,
    dew !== null && dew >= 18 ? `露點 ${deg(dew)}` : null,
    rain !== null ? `降雨 ${Math.round(rain)}%` : null,
    wind !== null && wind >= 20 ? `風 ${Math.round(wind)} km/h` : null,
  ].filter((t): t is string => t !== null);
  const facts = [
    apparentMin !== null && apparentMax !== null ? `體感 ${apparentMin === apparentMax ? deg(apparentMax) : `${Math.round(apparentMin)}–${deg(apparentMax)}`}` : null,
    dew !== null ? `露點最高 ${deg(dew)}` : null,
    rain !== null ? `降雨機率最高 ${Math.round(rain)}%` : null,
    wind !== null ? `風最大約 ${Math.round(wind)} km/h` : null,
  ].filter(Boolean);
  return { label, tags, line: `${label}：${facts.join("、")}` };
}

/** 起跑與預計完賽的說明，例：起跑 07:00，預計約 2 小時（依目標時間） */
export function raceWindowText(race: Pick<Race, "start_time" | "distance_km" | "target_time" | "sport">): string {
  const { minutes, estimated } = raceMinutes(race);
  const span = minutes >= 90 ? `${Math.round((minutes / 60) * 2) / 2} 小時` : `${Math.round(minutes)} 分鐘`;
  return `${race.start_time ? `起跑 ${race.start_time}，` : ""}預計約 ${span}（${estimated ? "沒有目標時間，依距離估" : "依目標時間"}）`;
}

function hourLine(h: WeatherHour): string {
  const parts = [`${h.time.slice(11, 16)} ${weatherText(h.code)} ${deg(h.temp)}`];
  if (h.apparent !== null && h.temp !== null && Math.abs(h.apparent - h.temp) >= 2) parts[0] += `（體感 ${deg(h.apparent)}）`;
  if (h.dewPoint !== null) parts.push(`露點 ${deg(h.dewPoint)}`);
  if (h.precipProb !== null) parts.push(`降雨 ${Math.round(h.precipProb)}%`);
  if (h.wind !== null) parts.push(`風 ${Math.round(h.wind)} km/h`);
  return parts.join("、");
}

/** 比賽日的天氣為什麼查不到（教練的工具與看板共用）；查得到時是 null */
export function raceWeatherUnavailable(race: Pick<Race, "date" | "place_lat" | "place_lon">, today: string): string | null {
  const ahead = daysBetween(today, race.date);
  if (ahead < 0) return "這場比賽已經過了，沒有預報。";
  if (race.place_lat == null || race.place_lon == null) {
    return "這場比賽沒有設定地點，查不到天氣。請選手到「計畫」頁的賽事按「編輯」選比賽的城市（地點只用來查天氣，你看不到）。";
  }
  if (ahead > RACE_FORECAST_MAX_AHEAD) return `還太遠：比賽在 ${ahead} 天後，16 天內才有預報（${ahead - RACE_FORECAST_MAX_AHEAD} 天後再查）。`;
  return null;
}

/** get_race_weather 的回傳：只有天氣，沒有地點 */
export function raceWeatherForTool(race: Race, hours: WeatherHour[]): string {
  const during = raceHours(hours, race);
  const summary = raceWeatherSummary(during);
  if (!during.length || !summary) return `${race.date} 的預報還沒有這個時段的資料，晚點再查。`;
  return [
    `「${race.name}」（${race.date}）的天氣預報（Open-Meteo 的模型預報，約略，越接近比賽越準；時間是比賽地點的當地時間）：`,
    race.start_time ? raceWindowText(race) : `沒有起跑時間，列出白天每 3 小時（請選手在賽事頁填起跑時間會更準）；${raceWindowText(race)}`,
    ...during.map((h) => `- ${hourLine(h)}`),
    `整體：${summary.line}`,
  ].join("\n");
}

/** Coach 用的比賽天氣來源；地點由呼叫的人給（賽事上的），不另外存 */
export interface RaceWeatherSource {
  /** 那個地點今天起 16 天的逐時預報（比賽地點的當地時間） */
  forecast(place: WeatherPlace): Promise<WeatherHour[]>;
}

type Fetch = typeof fetch;

export class OpenMeteoRaceWeather implements RaceWeatherSource {
  readonly #urls: OpenMeteoUrls;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #cache = new Map<string, { at: number; value: Promise<WeatherHour[]> }>();

  constructor(options: { urls?: OpenMeteoUrls; fetch?: Fetch; now?: () => number } = {}) {
    this.#urls = options.urls ?? OPEN_METEO_URLS;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => Date.now());
  }

  forecast(place: WeatherPlace): Promise<WeatherHour[]> {
    // 只送四捨五入的座標（約 10 km）
    const { lat, lon } = roundPlace(place.lat, place.lon);
    const key = `${lat},${lon}`;
    const hit = this.#cache.get(key);
    if (hit && this.#now() - hit.at < TTL_MS) return hit.value;
    // 時區用比賽地點的（auto）：起跑時間是當地時間
    const query = new URLSearchParams({ latitude: String(lat), longitude: String(lon), timezone: "auto", hourly: HOURLY, forecast_days: String(RACE_FORECAST_DAYS) });
    const value = (async () => {
      const res = await this.#fetch(`${this.#urls.forecast}?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Open-Meteo 回應 ${res.status}`);
      return parseHourly((await res.json()) as Record<string, unknown>);
    })();
    if (this.#cache.size > 20) this.#cache.clear();
    this.#cache.set(key, { at: this.#now(), value });
    value.catch(() => {
      if (this.#cache.get(key)?.value === value) this.#cache.delete(key);
    });
    return value;
  }
}

function parseHourly(json: Record<string, unknown>): WeatherHour[] {
  const h = json.hourly as Record<string, unknown> | undefined;
  const col = (key: string, i: number) => {
    const v = Array.isArray(h?.[key]) ? (h![key] as unknown[])[i] : null;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const times = Array.isArray(h?.time) ? (h!.time as unknown[]).filter((t): t is string => typeof t === "string") : [];
  return times.map((time, i) => ({
    time,
    temp: col("temperature_2m", i),
    apparent: col("apparent_temperature", i),
    dewPoint: col("dew_point_2m", i),
    humidity: col("relative_humidity_2m", i),
    precipProb: col("precipitation_probability", i),
    precip: col("precipitation", i),
    wind: col("wind_speed_10m", i),
    code: col("weather_code", i),
  }));
}
