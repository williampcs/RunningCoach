/** 比賽地點的天氣（16 天內，規格 12.31 第 3 點） */
import { describe, expect, it } from "vitest";

import type { Race } from "../src";
import { applyEntity, snapshot } from "../src/device-sync/entities";
import {
  OpenMeteoRaceWeather,
  raceHours,
  raceMinutes,
  raceWeatherSummary,
  raceWeatherUnavailable,
  type RaceWeatherSource,
} from "../src/race-weather";
import { editRace, normalizeStartTime, placeFields } from "../src/races";
import type { WeatherHour, WeatherPlace } from "../src/weather";
import { makeCoach, toolTurn, turn } from "./helpers";

// 今天是 2026-10-10（台北時間）
const TODAY = "2026-10-10";

/** 某天 24 小時的逐時：早上涼、中午熱，下午可能下雨 */
function day(date: string, partial: (h: number) => Partial<WeatherHour> = () => ({})): WeatherHour[] {
  return Array.from({ length: 24 }, (_, h) => ({
    time: `${date}T${String(h).padStart(2, "0")}:00`,
    temp: 20 + h / 2,
    apparent: 21 + h / 2,
    dewPoint: 18,
    humidity: 80,
    precipProb: h >= 14 ? 60 : 10,
    precip: 0,
    wind: 10,
    code: h >= 14 ? 80 : 2,
    ...partial(h),
  }));
}

const race = (partial: Partial<Race> = {}): Race => ({
  id: 1,
  name: "城市半馬",
  date: "2026-10-18",
  distance_km: 21.1,
  target_time: "2:00:00",
  confirmed: 1,
  result_time: null,
  notes: null,
  cancelled: 0,
  created_at: "",
  ...partial,
});

/** 記下收到的地點，回傳固定的預報 */
class FakeRaceWeather implements RaceWeatherSource {
  readonly asked: WeatherPlace[] = [];
  constructor(readonly hours: WeatherHour[]) {}
  async forecast(place: WeatherPlace) {
    this.asked.push(place);
    return this.hours;
  }
}

describe("比賽時段", () => {
  it("起跑時間的格式；在場上多久：目標時間，沒有時依距離估", () => {
    expect(normalizeStartTime("6:30")).toBe("06:30");
    expect(normalizeStartTime(" 07：00 ")).toBe("07:00");
    expect(normalizeStartTime("")).toBeNull();
    expect(() => normalizeStartTime("25:00")).toThrow(/HH:MM/);
    expect(raceMinutes(race())).toEqual({ minutes: 120, estimated: false });
    expect(raceMinutes(race({ target_time: null, distance_km: 10 }))).toEqual({ minutes: 70, estimated: true });
    expect(raceMinutes(race({ target_time: "", distance_km: 100, sport: "ride" }))).toEqual({ minutes: 240, estimated: true });
  });

  it("有起跑時間：起跑那個小時到預計完賽；沒有時：白天每 3 小時", () => {
    const hours = [...day("2026-10-17"), ...day("2026-10-18")];
    expect(raceHours(hours, race({ start_time: "06:30" })).map((h) => h.time.slice(11, 16))).toEqual(["06:00", "07:00", "08:00"]);
    expect(raceHours(hours, race()).map((h) => h.time.slice(11, 13))).toEqual(["06", "09", "12", "15", "18", "21"]);
    expect(raceHours(hours, race({ start_time: "06:30" })).every((h) => h.time.startsWith("2026-10-18"))).toBe(true);
  });

  it("一句話與標籤：濕熱、可能下雨、風大；普通的天氣是舒適", () => {
    const humid = raceWeatherSummary(day("2026-10-18", () => ({ dewPoint: 23, apparent: 30, precipProb: 60, wind: 32 })))!;
    expect(humid.label).toBe("濕熱，可能下雨，風大");
    expect(humid.tags).toEqual(["體感 30°C", "露點 23°C", "降雨 60%", "風 32 km/h"]);
    expect(humid.line).toContain("濕熱，可能下雨，風大：體感 30°C、露點最高 23°C、降雨機率最高 60%");
    const mild = raceWeatherSummary(day("2026-10-18", () => ({ apparent: 20, dewPoint: 12, precipProb: 10 })))!;
    expect(mild.label).toBe("舒適");
    expect(mild.tags).toEqual(["體感 20°C", "降雨 10%"]);
    expect(raceWeatherSummary(day("2026-10-18", () => ({ apparent: 2, precipProb: 0 })))!.label).toBe("寒冷");
    expect(raceWeatherSummary([])).toBeNull();
  });

  it("查不到的原因：沒有地點、超過 16 天、已經過了", () => {
    const place = { place_lat: 25, place_lon: 121.6 };
    expect(raceWeatherUnavailable(race(), TODAY)).toMatch(/沒有設定地點/);
    expect(raceWeatherUnavailable(race({ ...place, date: "2026-10-25" }), TODAY)).toBeNull();
    expect(raceWeatherUnavailable(race({ ...place, date: "2026-10-26" }), TODAY)).toBe("還太遠：比賽在 16 天後，16 天內才有預報（1 天後再查）。");
    expect(raceWeatherUnavailable(race({ ...place, date: "2026-10-09" }), TODAY)).toMatch(/已經過了/);
  });
});

describe("Open-Meteo 的比賽天氣", () => {
  it("只送四捨五入的座標、比賽地點的時區、16 天；同一個地點一小時內不重查，失敗的不留著", async () => {
    const urls: string[] = [];
    let fail = true;
    const source = new OpenMeteoRaceWeather({
      fetch: (async (url: string) => {
        urls.push(url);
        if (fail) return new Response("{}", { status: 500 });
        return Response.json({ hourly: { time: ["2026-10-18T07:00"], temperature_2m: [22], dew_point_2m: [19] } });
      }) as typeof fetch,
    });
    await expect(source.forecast({ lat: 34.6937, lon: 135.5023 })).rejects.toThrow("500");
    fail = false;
    const hours = await source.forecast({ lat: 34.6937, lon: 135.5023 });
    await source.forecast({ lat: 34.71, lon: 135.48 });
    expect(hours).toEqual([expect.objectContaining({ time: "2026-10-18T07:00", temp: 22, dewPoint: 19, wind: null })]);
    expect(urls).toHaveLength(2);
    const q = new URL(urls[1]!).searchParams;
    expect([q.get("latitude"), q.get("longitude"), q.get("timezone"), q.get("forecast_days")]).toEqual(["34.7", "135.5", "auto", "16"]);
  });
});

describe("賽事的地點與起跑時間", () => {
  it("存四捨五入的座標；起跑時間統一格式；可以清掉；賽後不能改", async () => {
    const { coach } = await makeCoach();
    const id = await coach.db.addRace({ name: "大阪馬拉松", date: "2026-10-25", distance_km: 42.195, ...placeFields({ lat: 34.6937, lon: 135.5023 }, "Osaka, Japan"), start_time: "09:15" });
    expect(await coach.db.getRace(id)).toMatchObject({ place_label: "Osaka, Japan", place_lat: 34.7, place_lon: 135.5, start_time: "09:15" });
    await editRace(coach.db, TODAY, id, { start_time: "9:00", ...placeFields({ lat: 25.04, lon: 121.56 }, "台北市") });
    expect(await coach.db.getRace(id)).toMatchObject({ place_label: "台北市", place_lat: 25, place_lon: 121.6, start_time: "09:00" });
    await editRace(coach.db, TODAY, id, { start_time: null, ...placeFields(null) });
    expect(await coach.db.getRace(id)).toMatchObject({ place_label: null, place_lat: null, place_lon: null, start_time: null });
    await expect(editRace(coach.db, TODAY, id, { start_time: "25:00" })).rejects.toThrow(/HH:MM/);
    const past = await coach.db.addRace({ name: "上週的", date: "2026-10-04", distance_km: 10 });
    await expect(editRace(coach.db, TODAY, past, placeFields({ lat: 25, lon: 121.6 }, "台北市"))).rejects.toThrow(/只能改名稱與備註/);
  });

  it("多裝置同步：地點與起跑時間帶過去；沒有地點的賽事內容和之前一樣", async () => {
    const ma = await makeCoach();
    const mb = await makeCoach();
    await ma.coach.db.addRace({ name: "有地點", date: "2026-10-25", distance_km: 21.1, ...placeFields({ lat: 25, lon: 121.6 }, "台北市"), start_time: "06:00" });
    await ma.coach.db.addRace({ name: "沒地點", date: "2026-11-01", distance_km: 10 });
    const snap = await snapshot(ma.driver);
    const races = [...snap.data].filter(([k]) => k.startsWith("r:"));
    expect(races.find(([, v]) => v.name === "沒地點")![1]).not.toHaveProperty("place_lat");
    const target = await snapshot(mb.driver);
    for (const [name, data] of races) await applyEntity(mb.driver, name, data, target);
    expect((await mb.coach.db.getAllRaces()).find((r) => r.name === "有地點")).toMatchObject({ place_label: "台北市", place_lat: 25, place_lon: 121.6, start_time: "06:00" });
  });
});

describe("教練查比賽日的天氣", () => {
  const SECRET = "Osaka, Japan";
  const hours = [...day("2026-10-17"), ...day("2026-10-18", () => ({ dewPoint: 23 }))];

  it("沒設天氣的城市也能用；工具的結果與系統提示有天氣、沒有地點；沒有地點與太遠的照實說", async () => {
    const source = new FakeRaceWeather(hours);
    const { coach, provider } = await makeCoach(
      [
        (call) => {
          // 系統提示：有起跑時間與「已設定地點」，沒有地點的名稱與座標
          expect(call.request.system).toContain("｜起跑 06:30｜已設定地點（可查比賽日天氣）");
          expect(call.request.system).toContain("先用 get_race_weather 查比賽日的天氣");
          return toolTurn("get_race_weather", { race_id: 1 });
        },
        toolTurn("get_race_weather", { race_id: 2 }),
        toolTurn("get_race_weather", { race_id: 3 }),
        toolTurn("list_races"),
        turn({ text: "好" }),
      ],
      { raceWeather: source },
    );
    await coach.db.addRace({ name: "城市半馬", date: "2026-10-18", distance_km: 21.1, target_time: "2:00:00", ...placeFields({ lat: 34.6937, lon: 135.5023 }, SECRET), start_time: "06:30" });
    await coach.db.addRace({ name: "沒地點", date: "2026-10-18", distance_km: 10 });
    await coach.db.addRace({ name: "太遠", date: "2026-11-20", distance_km: 42.195, ...placeFields({ lat: 25, lon: 121.6 }, "台北市") });
    await coach.chat("下週的半馬要怎麼配速？");
    const results = provider.calls.flatMap((c) => c.toolResults ?? []).map((r) => r.content);
    expect(results[0]).toContain("「城市半馬」（2026-10-18）的天氣預報");
    expect(results[0]).toContain("起跑 06:30，預計約 2 小時（依目標時間）");
    expect(results[0]).toMatch(/- 06:00 .*露點 23°C、降雨 10%、風 10 km\/h/);
    expect(results[0]).toContain("整體：濕熱");
    expect(results[1]).toMatch(/沒有設定地點/);
    expect(results[2]).toMatch(/^還太遠：比賽在 41 天後/);
    expect(results[3]).toContain("｜起跑 06:30｜已設定地點");
    // 只查了有地點、16 天內的那場；送出的是四捨五入的座標
    expect(source.asked).toEqual([{ label: SECRET, lat: 34.7, lon: 135.5 }]);
    // 送給模型的內容（系統提示、對話、工具的結果）都沒有地點
    const sent = JSON.stringify(provider.calls.map((c) => [c.request, c.toolResults]));
    for (const secret of [SECRET, "Osaka", "34.7", "135.5", "台北市"]) expect(sent).not.toContain(secret);
  });

  it("看板：賽前三天起放比賽日的天氣（一句話、標籤、問教練怎麼配速），沒有地點、太早的不放", async () => {
    const source = new FakeRaceWeather([...day("2026-10-13", () => ({ dewPoint: 23, precipProb: 60 }))]);
    const { coach } = await makeCoach([], { raceWeather: source });
    await coach.db.addRace({ name: "三天後", date: "2026-10-13", distance_km: 21.1, target_time: "1:50:00", ...placeFields({ lat: 25, lon: 121.6 }, "台北市"), start_time: "06:00" });
    await coach.db.addRace({ name: "四天後", date: "2026-10-14", distance_km: 10, ...placeFields({ lat: 25, lon: 121.6 }, "台北市") });
    await coach.db.addRace({ name: "沒地點", date: "2026-10-12", distance_km: 10 });
    const items = (await coach.feed()).filter((i) => i.id.startsWith("race-weather-"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "weather",
      tone: "warn",
      title: "比賽日的天氣：濕熱，可能下雨",
      tags: ["體感 25°C", "露點 23°C", "降雨 60%"],
      detail: "三天後 · 起跑 06:00，預計約 2 小時（依目標時間）",
      credit: { label: "Weather data by Open-Meteo.com", href: "https://open-meteo.com/" },
    });
    const action = items[0]!.actions[0]!;
    expect(action).toMatchObject({ type: "ask", label: "問教練怎麼配速" });
    expect(JSON.stringify(items)).not.toContain("台北市");
    // 取不到預報時不放，也不影響其他提醒
    const broken = await makeCoach([], { raceWeather: { forecast: () => Promise.reject(new Error("離線")) } });
    await broken.coach.db.addRace({ name: "三天後", date: "2026-10-13", distance_km: 21.1, ...placeFields({ lat: 25, lon: 121.6 }, "台北市") });
    expect((await broken.coach.feed()).some((i) => i.id.startsWith("race-weather-"))).toBe(false);
    expect((await broken.coach.feed()).some((i) => i.id.startsWith("race-1"))).toBe(true);
  });
});
