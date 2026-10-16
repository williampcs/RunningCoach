import { useState } from "react";

import {
  addDays,
  FAKE_SCENARIOS,
  fakeActivity,
  generateActivities,
  parsePace,
  SYNC_DAYS,
  type FakeScenario,
  type FakeSpec,
} from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { useSync } from "../use-sync";

type Notice = { kind: "ok" | "error"; text: string };

const DEFAULT_SPEC = { scenario: "steady" as FakeScenario, weeks: 6, runsPerWeek: 4, easyPace: "5:45", maxHr: 188 };

const clock = (totalSec: number) => {
  const s = Math.round(totalSec);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
};

/** 設定頁的測試模式：啟用／停用、產生情境、新增單筆、模擬日期 */
export function TestModeCard() {
  const { coach, db, testMode, updateTestMode, touch } = useApp();
  const sync = useSync();
  const [message, setMessage] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const [scenario, setScenario] = useState<FakeScenario>(testMode.spec?.scenario ?? DEFAULT_SPEC.scenario);
  const [weeks, setWeeks] = useState(String(testMode.spec?.weeks ?? DEFAULT_SPEC.weeks));
  const [runsPerWeek, setRunsPerWeek] = useState(String(testMode.spec?.runsPerWeek ?? DEFAULT_SPEC.runsPerWeek));
  const [easyPace, setEasyPace] = useState(
    testMode.spec ? clock(testMode.spec.easyPaceSec) : DEFAULT_SPEC.easyPace,
  );
  const [maxHr, setMaxHr] = useState(String(testMode.spec?.maxHr ?? DEFAULT_SPEC.maxHr));
  const [seed, setSeed] = useState(String(testMode.spec?.seed ?? 1));
  const [sample, setSample] = useState(true);

  const [run, setRun] = useState({ date: "", distance: "", duration: "", avgHr: "", maxHr: "", elevation: "" });
  const [simDate, setSimDate] = useState(testMode.today ?? "");

  if (!testMode.enabled) {
    return (
      <section className="card">
        <h2>測試模式</h2>
        <p className="muted small">
          用假的跑步紀錄測試教練在各種情況下的反應，例如過度訓練、受傷中斷、賽前減量。測試模式使用另一個資料庫，正式的對話與訓練紀錄不受影響；也不連線
          Intervals.icu，不會在那裡留下任何資料。AI 模型照常使用你的設定，會正常計費。
        </p>
        <div className="row">
          <button
            onClick={() => {
              if (confirm("切換到測試模式？頁面會重新載入，改用測試用的資料庫。")) updateTestMode({ ...testMode, enabled: true });
            }}
          >
            啟用測試模式
          </button>
        </div>
      </section>
    );
  }

  const today = coach.today();
  const all = testMode.spec ? generateActivities(testMode.spec) : [];

  async function generate() {
    const pace = parsePace(easyPace);
    const spec: FakeSpec = {
      scenario,
      endDate: today,
      weeks: Math.min(16, Math.max(1, Number(weeks) || 1)),
      runsPerWeek: Math.min(7, Math.max(1, Number(runsPerWeek) || 1)),
      easyPaceSec: pace ?? 345,
      maxHr: Math.min(220, Math.max(140, Number(maxHr) || 188)),
      seed: Number(seed) || 1,
    };
    if (pace === null) {
      setMessage({ kind: "error", text: "輕鬆跑配速的格式是「分:秒」，例如 5:45。" });
      return;
    }
    if (!confirm("產生新的假資料會清空測試資料庫（對話、訓練紀錄、選手資料都會刪除），確定嗎？")) return;
    setBusy(true);
    setMessage(null);
    try {
      await db.reset();
      const runs = generateActivities(spec);
      // 同步只抓最近 14 天；更早的直接存入（不產生 AI 分析），模擬已經累積一段時間的紀錄
      const cutoff = addDays(today, -SYNC_DAYS);
      const older = runs.filter((r) => r.date < cutoff);
      for (const r of older) await coach.db.saveWorkout(r);
      if (sample) await seedSample(spec);
      updateTestMode({ ...testMode, spec, custom: [] });
      setMessage({
        kind: "ok",
        text: `已產生 ${runs.length} 筆：較早的 ${older.length} 筆已直接存入；最近 ${SYNC_DAYS} 天的 ${runs.length - older.length} 筆請按「同步」帶入（會產生 AI 分析）。`,
      });
    } catch (e) {
      setMessage({ kind: "error", text: `產生失敗：${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function seedSample(spec: FakeSpec) {
    const weekly = Math.round(
      generateActivities(spec)
        .filter((r) => r.date >= addDays(spec.endDate, -27))
        .reduce((sum, r) => sum + (r.distance_km ?? 0), 0) / 4,
    );
    const profile: Record<string, string> = {
      goal_long_term: "全馬破四（測試資料）",
      weekly_km_target: String(weekly),
      max_hr: String(spec.maxHr),
      birth_year: "1990",
      pb_10k: clock((spec.easyPaceSec - 70) * 10),
      pb_half: clock((spec.easyPaceSec - 50) * 21.0975),
    };
    for (const [key, value] of Object.entries(profile)) await coach.db.setProfileKey(key, value);
    await coach.db.addRace({
      name: "測試馬拉松",
      date: addDays(spec.endDate, spec.scenario === "taper" ? 7 : 70),
      distance_km: 42.195,
      target_time: "3:59:00",
    });
  }

  function addRun() {
    const distance = Number(run.distance);
    const duration = Number(run.duration);
    if (!(distance > 0) || !(duration > 0)) {
      setMessage({ kind: "error", text: "請填寫距離（公里）與時間（分鐘）。" });
      return;
    }
    const optional = (v: string) => (v.trim() === "" ? null : Number(v));
    const activity = fakeActivity({
      id: `fake-custom-${Date.now()}`,
      date: run.date || today,
      distanceKm: distance,
      durationMin: duration,
      avgHr: optional(run.avgHr),
      maxHr: optional(run.maxHr),
      elevationM: optional(run.elevation),
      athleteMaxHr: testMode.spec?.maxHr,
    });
    updateTestMode({ ...testMode, custom: [...testMode.custom, activity] });
    setRun({ date: "", distance: "", duration: "", avgHr: "", maxHr: "", elevation: "" });
    setMessage({
      kind: "ok",
      text: `已新增 ${activity.date} ${activity.distance_km} 公里（${activity.avg_pace}）。可以到「跑後回報」回報這次的感受，或按「同步」帶入。`,
    });
  }

  function applyDate(next: string | null) {
    updateTestMode({ ...testMode, today: next });
    setSimDate(next ?? "");
    setMessage({ kind: "ok", text: next ? `模擬日期改為 ${next}。` : "已回到實際日期。" });
  }

  return (
    <section className="card test-mode">
      <h2>測試模式</h2>
      <p className="small">
        目前使用測試資料庫與假資料。{testMode.spec ? `情境「${FAKE_SCENARIOS[testMode.spec.scenario].label}」，${testMode.spec.weeks} 週，共 ${all.length} 筆，產生到 ${testMode.spec.endDate}。` : "還沒產生假資料。"}
        {testMode.custom.length ? `手動新增 ${testMode.custom.length} 筆。` : ""}
      </p>

      <strong>產生一段期間的紀錄</strong>
      <div className="grid">
        <label className="wide">
          情境
          <select value={scenario} onChange={(e) => setScenario(e.target.value as FakeScenario)}>
            {(Object.keys(FAKE_SCENARIOS) as FakeScenario[]).map((key) => (
              <option key={key} value={key}>
                {FAKE_SCENARIOS[key].label}
              </option>
            ))}
          </select>
          <span className="small">{FAKE_SCENARIOS[scenario].description}</span>
        </label>
        <label>
          週數
          <input type="number" min={1} max={16} value={weeks} onChange={(e) => setWeeks(e.target.value)} />
        </label>
        <label>
          每週次數
          <input type="number" min={1} max={7} value={runsPerWeek} onChange={(e) => setRunsPerWeek(e.target.value)} />
        </label>
        <label>
          輕鬆跑配速
          <input value={easyPace} placeholder="5:45" onChange={(e) => setEasyPace(e.target.value)} />
        </label>
        <label>
          最大心率
          <input type="number" value={maxHr} onChange={(e) => setMaxHr(e.target.value)} />
        </label>
        <label>
          亂數種子
          <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} />
        同時填入範例選手資料與一場賽事
      </label>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void generate()}>
          {busy ? "產生中…" : "產生（會清空測試資料庫）"}
        </button>
        <button disabled={busy} onClick={() => setSeed(String(Math.floor(Math.random() * 100000)))}>
          換一組亂數
        </button>
        <button disabled={sync.busy} onClick={() => void sync.run()}>
          {sync.busy ? "同步中…" : "同步"}
        </button>
      </div>
      {sync.message && <div className={`notice ${sync.message.kind}`}>{sync.message.text}</div>}

      <strong>新增一筆</strong>
      <div className="grid">
        <label>
          日期
          <input type="date" value={run.date || today} onChange={(e) => setRun({ ...run, date: e.target.value })} />
        </label>
        <label>
          距離（公里）
          <input inputMode="decimal" value={run.distance} onChange={(e) => setRun({ ...run, distance: e.target.value })} />
        </label>
        <label>
          時間（分鐘）
          <input inputMode="decimal" value={run.duration} onChange={(e) => setRun({ ...run, duration: e.target.value })} />
        </label>
        <label>
          平均心率
          <input inputMode="numeric" value={run.avgHr} placeholder="可留空" onChange={(e) => setRun({ ...run, avgHr: e.target.value })} />
        </label>
        <label>
          最高心率
          <input inputMode="numeric" value={run.maxHr} placeholder="可留空" onChange={(e) => setRun({ ...run, maxHr: e.target.value })} />
        </label>
        <label>
          爬升（公尺）
          <input inputMode="numeric" value={run.elevation} placeholder="可留空" onChange={(e) => setRun({ ...run, elevation: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <button onClick={addRun}>新增</button>
        {testMode.custom.length > 0 && (
          <button
            onClick={() => {
              updateTestMode({ ...testMode, custom: [] });
              setMessage({ kind: "ok", text: "已清空手動新增的紀錄（已同步進資料庫的不受影響）。" });
            }}
          >
            清空手動新增的紀錄
          </button>
        )}
      </div>

      <strong>模擬今天的日期</strong>
      <p className="muted small">
        目前是 {today}。往後移就像時間過去：之後日期的假資料會陸續出現、賽事倒數也跟著變。
      </p>
      <div className="row">
        <input type="date" aria-label="模擬日期" value={simDate} onChange={(e) => setSimDate(e.target.value)} />
        <button disabled={!simDate} onClick={() => applyDate(simDate)}>
          套用
        </button>
        {testMode.today && <button onClick={() => applyDate(null)}>回到實際日期</button>}
      </div>

      {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
      <div className="row">
        <button
          className="danger"
          onClick={() => {
            if (confirm("停用測試模式，回到正式資料？測試資料庫會保留，下次啟用時還在。")) {
              updateTestMode({ ...testMode, enabled: false, today: null });
              touch();
            }
          }}
        >
          停用測試模式
        </button>
      </div>
    </section>
  );
}
