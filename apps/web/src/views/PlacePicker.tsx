import { useState } from "react";

import { matchTaiwanCities, openMeteoUrlsAt, searchPlaces, TAIWAN_CITIES, type PlaceCandidate } from "@running-coach/core";

import { errorText } from "../app-context";
import { InfoTip } from "../ui";

const geocodingUrl = import.meta.env.VITE_WEATHER_BASE_URL ? openMeteoUrlsAt(import.meta.env.VITE_WEATHER_BASE_URL).geocoding : undefined;

/**
 * 比賽的地點（規格 12.31）：和天氣設定一樣，台灣的縣市直接選（不送出去），其他地方用英文搜尋.
 * 放在賽事的表單裡，所以不用 <form>（不能巢狀），搜尋框按 Enter 也只搜尋
 */
export function RacePlacePicker({ value, onChange }: { value: PlaceCandidate | null; onChange: (place: PlaceCandidate | null) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setError(null);
    setResults(null);
    if (query.trim().length < 2) return setError("至少輸入兩個字。");
    // 台灣的縣市在本機對照，不送出去
    const local = matchTaiwanCities(query);
    if (local.length) return setResults(local);
    setBusy(true);
    try {
      setResults(await searchPlaces(query, { url: geocodingUrl }));
    } catch (e) {
      setError(`搜尋失敗：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function choose(place: PlaceCandidate | null) {
    onChange(place);
    setResults(null);
    setQuery("");
  }

  return (
    <fieldset className="wide race-place">
      <legend className="row">
        <span>比賽地點（選填，查比賽日的天氣用）</span>
        <InfoTip label="比賽地點只用來查天氣">
          <ul className="weather-privacy">
            <li>比賽前 16 天內，教練會查起跑到預計完賽每小時的天氣，看板在賽前三天顯示比賽日的天氣。</li>
            <li>教練只看得到天氣，看不到地點。地點存在這場賽事上，會跟著多裝置同步。</li>
            <li>查天氣時，瀏覽器把約略的座標（四捨五入到約 10 公里）直接送到 Open-Meteo，Open-Meteo 也會看到你的 IP。選台灣的縣市不會送出名稱；搜尋其他地方時會送出你輸入的名稱。</li>
            <li>和「設定」的天氣城市是分開的，沒有設定天氣的城市也能用。</li>
          </ul>
        </InfoTip>
      </legend>
      {value && (
        <div className="row between">
          <span>
            目前：<strong>{value.label}</strong>
          </span>
          <button type="button" className="text" onClick={() => choose(null)}>
            清除地點
          </button>
        </div>
      )}
      <label>
        台灣的縣市
        <select
          value={TAIWAN_CITIES.findIndex((c) => value?.label === c.label && value.lat === c.lat && value.lon === c.lon)}
          onChange={(e) => {
            const city = TAIWAN_CITIES[Number(e.target.value)];
            if (city) choose({ label: city.label, lat: city.lat, lon: city.lon });
          }}
        >
          <option value={-1}>{value ? "（不是台灣的縣市）" : "選擇縣市…"}</option>
          {TAIWAN_CITIES.map((c, i) => (
            <option key={c.label} value={i}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <div className="row weather-search">
        <label>
          其他地方（用英文搜尋）
          <input
            value={query}
            placeholder="例：Osaka、Singapore"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void search();
              }
            }}
          />
        </label>
        <button type="button" disabled={busy} onClick={() => void search()}>
          {busy ? "搜尋中…" : "搜尋城市"}
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {results && results.length === 0 && <p className="muted small">找不到這個城市，試試英文名稱或附近的大城市。</p>}
      {results && results.length > 0 && (
        <ul className="weather-results">
          {results.map((place) => (
            <li key={`${place.label}-${place.lat}-${place.lon}`}>
              <button type="button" onClick={() => choose(place)}>
                {place.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
