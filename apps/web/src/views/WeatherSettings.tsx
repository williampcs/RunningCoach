import { useState } from "react";

import { openMeteoUrlsAt, searchPlaces, WEATHER_CREDIT, type PlaceCandidate } from "@running-coach/core";

import { errorText, useApp } from "../app-context";

const geocodingUrl = import.meta.env.VITE_WEATHER_BASE_URL ? openMeteoUrlsAt(import.meta.env.VITE_WEATHER_BASE_URL).geocoding : undefined;

/**
 * 天氣的城市（規格 11 #26）：和選手資料的「紀錄頁的里程碑」分開設定.
 * 城市只用來查天氣：存在這個瀏覽器的設定裡，不進資料庫、不同步、不給模型看
 */
export function WeatherCard() {
  const { settings, updateSettings } = useApp();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = settings.weather;

  async function search() {
    setError(null);
    setResults(null);
    if (query.trim().length < 2) {
      setError("至少輸入兩個字。");
      return;
    }
    setBusy(true);
    try {
      setResults(await searchPlaces(query, { url: geocodingUrl }));
    } catch (e) {
      setError(`搜尋失敗：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function choose(place: PlaceCandidate | null) {
    await updateSettings({ ...settings, weather: place ? { label: place.label, lat: place.lat, lon: place.lon } : null });
    setResults(null);
    setQuery("");
  }

  return (
    <section className="card" id="weather">
      <h2>天氣</h2>
      <p className="small">
        設定一個城市，教練就會參考那裡約略的天氣：今天的天氣、排課時未來幾天的預報、跑後分析時跑步當下的溫度與露點；濕熱、下雨或空氣品質差時，教練動態也會提醒。
      </p>
      <div className="notice info">
        <strong>這個城市只用來查天氣</strong>
        <ul className="small weather-privacy">
          <li>只存在這個瀏覽器的設定裡：不會存進訓練資料、不會同步到其他裝置，也不會給 AI 模型看，教練只看得到天氣的數字。</li>
          <li>查天氣時，瀏覽器把約略的座標（四捨五入到約 10 公里）直接送到 Open-Meteo；搜尋城市時送出你輸入的名稱。Open-Meteo 也會看到你的 IP。</li>
          <li>和「選手資料」的「紀錄頁的里程碑」是分開的設定，互不影響。</li>
        </ul>
      </div>
      {current ? (
        <div className="row between">
          <span>
            目前：<strong>{current.label}</strong>
          </span>
          <button className="small" onClick={() => void choose(null)}>
            清除天氣的城市
          </button>
        </div>
      ) : (
        <p className="muted small">還沒設定：教練不會參考天氣。</p>
      )}
      <form
        className="row weather-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label>
          {current ? "換一個城市" : "城市"}
          <input value={query} placeholder="例：台北、Taichung、Osaka" onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "搜尋中…" : "搜尋城市"}
        </button>
      </form>
      {error && <div className="notice error">{error}</div>}
      {results && results.length === 0 && <p className="muted small">找不到這個城市，試試英文名稱或附近的大城市。</p>}
      {results && results.length > 0 && (
        <ul className="weather-results">
          {results.map((place) => (
            <li key={`${place.label}-${place.lat}-${place.lon}`}>
              <button onClick={() => void choose(place)}>{place.label}</button>
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">
        <a href={WEATHER_CREDIT.href} target="_blank" rel="noreferrer">
          {WEATHER_CREDIT.label}
        </a>
        （CC BY 4.0）：模型的預報與估計，約略，給教練評估用；要看精確的天氣請用氣象單位的預報。
      </p>
    </section>
  );
}
