import { describe, expect, it } from "vitest";

import {
  buildFeed,
  OpenMeteoWeather,
  roundPlace,
  searchPlaces,
  type WeatherForecast,
  type WeatherHour,
  type WeatherSource,
} from "../src";
import { matchTaiwanCities, runWeatherText, TAIWAN_CITIES, todayWeatherLine, weatherAlerts, weatherForTool, weatherNotice } from "../src/weather";
import { activity, makeCoach, toolTurn, turn } from "./helpers";

const TODAY = "2026-10-10";

function hour(time: string, partial: Partial<WeatherHour> = {}): WeatherHour {
  return { time, temp: 25, apparent: 26, dewPoint: 15, humidity: 60, precipProb: 10, precip: 0, wind: 8, code: 1, ...partial };
}

function forecast(partial: { hot?: boolean; rain?: boolean; aqi?: number } = {}): WeatherForecast {
  const hours = Array.from({ length: 24 }, (_, h) =>
    hour(`${TODAY}T${String(h).padStart(2, "0")}:00`, partial.hot ? { temp: 31, apparent: 37, dewPoint: 25, humidity: 80 } : {}),
  );
  return {
    days: [
      {
        date: TODAY,
        code: partial.rain ? 61 : 1,
        tempMax: partial.hot ? 33 : 27,
        tempMin: 21,
        apparentMax: partial.hot ? 37 : 27,
        precipProb: partial.rain ? 80 : 10,
        precipSum: partial.rain ? 6 : 0,
        windMax: 12,
      },
      { date: "2026-10-11", code: 3, tempMax: 26, tempMin: 20, apparentMax: 26, precipProb: 20, precipSum: 0, windMax: 10 },
    ],
    hours,
    air: partial.aqi ? hours.map((h) => ({ time: h.time, usAqi: partial.aqi!, pm25: 30 })) : [],
  };
}

/** 記錄網址的假 fetch */
function fakeFetch(handler: (url: URL) => unknown) {
  const urls: URL[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const body = handler(url);
    if (body instanceof Error) return new Response("fail", { status: 500 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fn, urls };
}

const openMeteoBody = {
  hourly: {
    time: [`${TODAY}T06:00`, `${TODAY}T07:00`],
    temperature_2m: [24.5, 26.1],
    apparent_temperature: [27, 29],
    dew_point_2m: [22, 23],
    relative_humidity_2m: [88, 82],
    precipitation_probability: [10, 20],
    precipitation: [0, 0],
    weather_code: [2, 2],
    wind_speed_10m: [6, 7],
  },
  daily: {
    time: [TODAY],
    weather_code: [2],
    temperature_2m_max: [30],
    temperature_2m_min: [22],
    apparent_temperature_max: [34],
    precipitation_probability_max: [30],
    precipitation_sum: [0.2],
    wind_speed_10m_max: [14],
  },
};

describe("roundPlace", () => {
  it("keeps one decimal (about 10 km)", () => {
    expect(roundPlace(25.03776, 121.56454)).toEqual({ lat: 25, lon: 121.6 });
    expect(roundPlace(-33.8688, 151.2093)).toEqual({ lat: -33.9, lon: 151.2 });
    expect(() => roundPlace(95, 0)).toThrow();
  });
});

describe("OpenMeteoWeather", () => {
  it("sends only the rounded coordinates and caches the forecast", async () => {
    const fetch = fakeFetch((url) => (url.pathname.includes("air") ? { hourly: { time: [`${TODAY}T06:00`], us_aqi: [40], pm2_5: [8] } } : openMeteoBody));
    let now = 0;
    const weather = new OpenMeteoWeather({ place: { lat: 25.03776, lon: 121.56454 }, timeZone: "Asia/Taipei", today: () => TODAY, fetch: fetch.fn, now: () => now });
    const f = await weather.forecast();
    expect(f.days[0]).toMatchObject({ date: TODAY, tempMax: 30, apparentMax: 34 });
    expect(f.hours[1]).toMatchObject({ time: `${TODAY}T07:00`, dewPoint: 23 });
    expect(f.air).toEqual([{ time: `${TODAY}T06:00`, usAqi: 40, pm25: 8 }]);
    for (const url of fetch.urls) {
      expect(url.searchParams.get("latitude")).toBe("25");
      expect(url.searchParams.get("longitude")).toBe("121.6");
      expect(url.searchParams.get("timezone")).toBe("Asia/Taipei");
    }
    await weather.forecast();
    expect(fetch.urls).toHaveLength(2);
    now += 31 * 60_000;
    await weather.forecast();
    expect(fetch.urls).toHaveLength(4);
    // 地點不會隨物件被序列化或列舉出去
    expect(JSON.stringify(weather)).not.toContain("25");
    expect(Object.keys(weather)).toEqual([]);
  });

  it("still gives the weather when air quality fails, and retries after a failure", async () => {
    let fail = true;
    const fetch = fakeFetch((url) => (url.pathname.includes("air") ? new Error("down") : fail ? new Error("down") : openMeteoBody));
    const weather = new OpenMeteoWeather({ place: { lat: 25, lon: 121.5 }, timeZone: "Asia/Taipei", today: () => TODAY, fetch: fetch.fn });
    await expect(weather.forecast()).rejects.toThrow("500");
    fail = false;
    const f = await weather.forecast();
    expect(f.air).toEqual([]);
    expect(f.days).toHaveLength(1);
  });

  it("reads a past day with past_days and skips days that are too old", async () => {
    const fetch = fakeFetch(() => ({
      hourly: { ...openMeteoBody.hourly, time: ["2026-10-07T06:00", "2026-10-08T06:00"] },
    }));
    const weather = new OpenMeteoWeather({ place: { lat: 25, lon: 121.5 }, timeZone: "Asia/Taipei", today: () => TODAY, fetch: fetch.fn });
    const hours = await weather.pastDay("2026-10-08");
    expect(hours.map((h) => h.time)).toEqual(["2026-10-08T06:00"]);
    expect(fetch.urls[0]!.searchParams.get("past_days")).toBe("2");
    await weather.pastDay("2026-10-08");
    expect(fetch.urls).toHaveLength(1);
    expect(await weather.pastDay("2026-01-01")).toEqual([]);
    expect(fetch.urls).toHaveLength(1);
  });
});

describe("searchPlaces", () => {
  it("labels, rounds and dedupes the results", async () => {
    const fetch = fakeFetch(() => ({
      results: [
        { name: "臺北市", latitude: 25.04776, longitude: 121.53185, admin1: "臺灣", country: "臺灣" },
        { name: "臺北市", latitude: 25.04, longitude: 121.55, admin1: "臺灣", country: "臺灣" },
        { name: "Taipei", latitude: 25.03, longitude: 121.56, country: "Taiwan" },
        { latitude: 1, longitude: 2 },
      ],
    }));
    const places = await searchPlaces("台北", { fetch: fetch.fn });
    expect(places).toEqual([
      { label: "臺北市, 臺灣", lat: 25, lon: 121.5 },
      { label: "臺北市, 臺灣", lat: 25, lon: 121.6 },
      { label: "Taipei, Taiwan", lat: 25, lon: 121.6 },
    ]);
    expect(fetch.urls[0]!.searchParams.get("name")).toBe("台北");
    // 結果用英文的名稱
    expect(fetch.urls[0]!.searchParams.get("language")).toBe("en");
    expect(await searchPlaces("台", { fetch: fetch.fn })).toEqual([]);
    expect(fetch.urls).toHaveLength(1);
  });
});

describe("weather text", () => {
  it("summarizes today for the system prompt", () => {
    const line = todayWeatherLine(forecast({ hot: true, aqi: 120 }), TODAY)!;
    expect(line).toContain("21°C–33°C");
    expect(line).toContain("體感最高 37°C");
    expect(line).toContain("白天露點最高 25°C");
    expect(line).toContain("空氣品質對敏感族群不健康（US AQI 最高 120）");
    expect(todayWeatherLine(forecast(), "2026-12-01")).toBeNull();
  });

  it("lists the days and the hours of one day for the tool", () => {
    const text = weatherForTool(forecast(), TODAY, TODAY);
    expect(text).toContain(`- ${TODAY}（今天）：晴時多雲`);
    expect(text).toContain("- 2026-10-11（明天）：陰");
    expect(text).toContain("06:00 25°C、露點 15°C、降雨 10%");
    expect(text).not.toContain("00:00");
    expect(weatherForTool(forecast(), TODAY, "2026-10-20")).toContain("沒有 2026-10-20 的逐時預報");
  });

  it("averages the hours of a run", () => {
    const hours = [
      hour(`${TODAY}T06:00`, { temp: 24, apparent: 27, dewPoint: 22, humidity: 90 }),
      hour(`${TODAY}T07:00`, { temp: 26, apparent: 29, dewPoint: 24, humidity: 80, precip: 1 }),
      hour(`${TODAY}T09:00`, { temp: 30 }),
    ];
    expect(runWeatherText(hours, `${TODAY}T06:20`, 50)).toBe("約 25°C（體感 28°C）、露點 23°C、濕度 85%、有雨（約 1.0 mm）");
    expect(runWeatherText(hours, `${TODAY}T03:00`, 30)).toBeNull();
  });

  it("alerts on humid heat, rain and bad air only", () => {
    expect(weatherAlerts(forecast(), TODAY)).toEqual([]);
    const alerts = weatherAlerts(forecast({ hot: true, rain: true, aqi: 160 }), TODAY);
    expect(alerts.map((a) => [a.kind, a.tone])).toEqual([
      ["heat", "warn"],
      ["rain", "info"],
      ["air", "warn"],
    ]);
    expect(alerts[0]!.title).toBe("濕熱（體感最高 37°C、露點 25°C）");
  });

  it("combines the alerts into one notice", () => {
    expect(weatherNotice(forecast(), TODAY)).toBeNull();
    expect(weatherNotice(forecast({ rain: true }), TODAY)).toEqual({
      tone: "info",
      title: "可能下雨",
      tags: ["降雨 80%"],
      summary: "今天可能下雨（降雨機率 80%）",
      detail: "路面濕滑時放慢、注意轉彎；也可以把課換到別天或改在室內。",
    });
    // 看板的標題是短句，數字是標籤（規格 12.28）；完整的一句給問教練用
    const both = weatherNotice(forecast({ hot: true, rain: true }), TODAY)!;
    expect(both.tone).toBe("warn");
    expect(both.title).toBe("濕熱，可能下雨");
    expect(both.tags).toEqual(["體感 37°C", "露點 25°C", "降雨 80%"]);
    expect(both.summary).toBe("今天濕熱（體感最高 37°C、露點 25°C），可能下雨（降雨機率 80%）");
  });
});

describe("Taiwan cities", () => {
  it("are already rounded and unique", () => {
    expect(new Set(TAIWAN_CITIES.map((c) => c.label)).size).toBe(22);
    for (const c of TAIWAN_CITIES) expect(roundPlace(c.lat, c.lon)).toEqual({ lat: c.lat, lon: c.lon });
  });

  it("match common ways of writing the name", () => {
    const labels = (q: string) => matchTaiwanCities(q).map((c) => c.label);
    expect(labels("台北")).toEqual(["台北市"]);
    expect(labels("臺北市")).toEqual(["台北市"]);
    expect(labels("Taipei")).toEqual(["台北市"]);
    expect(labels("新北")).toEqual(["新北市"]);
    expect(labels("新竹")).toEqual(["新竹市", "新竹縣"]);
    expect(labels("台東")).toEqual(["台東縣"]);
    expect(labels("Osaka")).toEqual([]);
    expect(labels("台")).toEqual([]);
  });
});

/** 不連網的天氣來源 */
class FixedWeather implements WeatherSource {
  pastCalls: string[] = [];
  constructor(private readonly f: WeatherForecast | Error) {}
  async forecast() {
    if (this.f instanceof Error) throw this.f;
    return this.f;
  }
  async pastDay(date: string) {
    this.pastCalls.push(date);
    return [hour(`${date}T07:00`, { temp: 29, apparent: 33, dewPoint: 25, humidity: 85 })];
  }
}

describe("Coach with weather", () => {
  it("puts today's weather in the system prompt and offers get_weather", async () => {
    const { coach, provider } = await makeCoach([toolTurn("get_weather", { date: "2026-10-11" }), turn({ text: "好" })], {
      weather: new FixedWeather(forecast({ hot: true })),
    });
    const reply = await coach.chat("明天天氣適合跑嗎");
    const { system, tools } = provider.calls[0]!.request;
    expect(system).toContain("今天的天氣（Open-Meteo 的預報，約略）：");
    expect(system).toContain("你不知道選手在哪個城市");
    expect(tools?.map((t) => t.name)).toContain("get_weather");
    expect(provider.calls[1]!.toolResults?.[0]?.content).toContain("天氣預報（Open-Meteo 的模型預報，約略");
    expect(reply.sources).toContain("天氣預報（Open-Meteo）");
  });

  it("says there is no weather when no city is set", async () => {
    const { coach, provider } = await makeCoach([turn({ text: "好" })], { settings: { shell: "web" } });
    await coach.chat("嗨");
    const { system, tools } = provider.calls[0]!.request;
    expect(system).toContain("沒有天氣資料（選手沒有設定天氣的城市）");
    expect(system).toContain("「設定」的「天氣」");
    expect(tools?.map((t) => t.name)).not.toContain("get_weather");
    expect(coach.hasWeather).toBe(false);
  });

  it("chats without weather when it cannot be fetched", async () => {
    const { coach, provider, logs } = await makeCoach([turn({ text: "好" })], { weather: new FixedWeather(new Error("offline")) });
    await coach.chat("嗨");
    expect(provider.calls[0]!.request.system).toContain("今天的天氣：這次取不到");
    expect(logs.some((l) => l.includes("Weather fetch failed: offline"))).toBe(true);
  });

  it("adds the weather during the run to the run summary", async () => {
    const weather = new FixedWeather(forecast());
    const run = activity({ raw_json: JSON.stringify({ id: "i100", start_date_local: `${TODAY}T07:05:00` }) });
    const { coach, provider } = await makeCoach([turn({ text: "摘要" })], { activities: [run], weather });
    await coach.reportRun(6, "很悶");
    const prompt = provider.calls[0]!.request.messages[0]!.content;
    expect(prompt).toContain("當時天氣（模型估計，約略）：約 29°C（體感 33°C）、露點 25°C、濕度 85%、沒下雨");
    expect(weather.pastCalls).toEqual([TODAY]);
  });

  it("skips the run weather without a start time", async () => {
    const weather = new FixedWeather(forecast());
    const { coach, provider } = await makeCoach([turn({ text: "摘要" })], { activities: [activity()], weather });
    await coach.reportRun(6, "");
    expect(provider.calls[0]!.request.messages[0]!.content).not.toContain("當時天氣");
    expect(weather.pastCalls).toEqual([]);
  });

  it("shows weather alerts in the feed with the credit", async () => {
    const { coach } = await makeCoach([], { weather: new FixedWeather(forecast({ hot: true })) });
    const items = (await coach.feed()).filter((i) => i.kind === "weather");
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({ id: `weather-${TODAY}`, tone: "warn", credit: { label: "Weather data by Open-Meteo.com", href: "https://open-meteo.com/" } });
    const plain = await buildFeed(coach.db, TODAY, coach.settings);
    expect(plain.some((i) => i.kind === "weather")).toBe(false);
  });
});
