import { useEffect, useState } from "react";

import {
  distanceText,
  DNS_REASONS,
  shortDateLabel,
  duplicateGroups,
  isAfterRace,
  raceOutcome,
  raceStatusText,
  RESULT_SOURCES,
  resultDetail,
  type ResultSource,
  similarRaces,
  type DnsReason,
  type Race,
} from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { Disclosure, SportIcon } from "../ui";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { featureEnabled } from "../environment";

interface RaceForm {
  id: number | null;
  /** 賽後：只能改名稱與備註 */
  after: boolean;
  name: string;
  date: string;
  distance: string;
  target: string;
  confirmed: boolean;
  notes: string;
  /** 賽事的運動（多運動）：run 跑步、ride 騎車 */
  sport: "run" | "ride";
}

const EMPTY_RACE: RaceForm = {
  id: null,
  after: false,
  name: "",
  date: "",
  distance: "",
  target: "",
  confirmed: true,
  notes: "",
  sport: "run",
};

interface ResultForm {
  id: number;
  outcome: "finished" | "dnf";
  /** 個人成績（淨時間） */
  time: string;
  /** 大會成績（槍聲起算，選填） */
  gunTime: string;
  source: ResultSource;
  note: string;
  /** 比賽當天的手錶紀錄 */
  watch: { time: string; distanceKm: number | null } | null | undefined;
}

/**
 * 賽事（規格 12.15）：賽前可以改全部欄位；賽後只能改名稱與備註、記錄或修改成績；
 * 「不參加了／沒有出賽」記下原因、不能恢復；任何一場都可以刪除（只有選手能刪）
 */
export function RacesCard() {
  const { coach, revision, touch } = useApp();
  const [races, setRaces] = useState<Race[]>([]);
  const [form, setForm] = useState<RaceForm | null>(null);
  const [resultFor, setResultFor] = useState<ResultForm | null>(null);
  const [dnsFor, setDnsFor] = useState<{
    id: number;
    reason: DnsReason;
    note: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = coach.today();

  useEffect(() => {
    void coach.db.getAllRaces().then(setRaces);
  }, [coach, revision]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      touch();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function saveRace(f: RaceForm) {
    if (f.after) {
      if (!f.name.trim()) return setError("請填寫賽事名稱。");
      await run(async () => {
        await coach.editRace(f.id!, {
          name: f.name.trim(),
          notes: f.notes.trim(),
        });
        setForm(null);
      });
      return;
    }
    const distance = Number(f.distance);
    if (!f.name.trim() || !f.date || !Number.isFinite(distance) || distance <= 0) {
      setError("請填寫賽事名稱、日期與距離（公里）。");
      return;
    }
    const same = similarRaces(races, { date: f.date, distance_km: distance }, f.id ?? undefined);
    if (same.length && !confirm(`${f.date} 已經有距離相近的「${same.map((r) => r.name).join("」「")}」，確定不是同一場嗎？`)) return;
    await run(async () => {
      const fields = {
        name: f.name.trim(),
        date: f.date,
        distance_km: distance,
        target_time: f.target.trim(),
        confirmed: f.confirmed ? 1 : 0,
        notes: f.notes.trim(),
        // 多運動：單車的賽事；開關關著時不寫（和原本一樣）
        ...(featureEnabled("multisport") ? { sport: f.sport } : {}),
      };
      if (f.id === null) await coach.db.addRace(fields);
      else await coach.editRace(f.id, fields);
      setForm(null);
    });
  }

  function openResult(race: Race) {
    setDnsFor(null);
    const outcome = raceOutcome(race);
    const next: ResultForm = {
      id: race.id,
      outcome: outcome === "dnf" ? "dnf" : "finished",
      time: race.result_time ?? "",
      gunTime: race.gun_time ?? "",
      source: (race.result_source as ResultSource | null) ?? "chip",
      note: outcome === "dnf" ? (race.outcome_reason ?? "") : "",
      watch: undefined,
    };
    setResultFor(next);
    void coach.raceActivity(race.id).then((watch) => setResultFor((f) => (f?.id === race.id ? { ...f, watch } : f)));
  }

  function saveResult(f: ResultForm) {
    if (f.outcome === "finished" && !f.time.trim()) return setError("請填寫完賽成績。");
    void run(async () => {
      await coach.recordRaceResult(
        f.id,
        f.outcome === "finished"
          ? { outcome: "finished", time: f.time.trim(), gunTime: f.gunTime.trim() || null, source: f.source }
          : { outcome: "dnf", note: f.note },
      );
      setResultFor(null);
    });
  }

  // 還沒比的在前（近的先），賽後待記錄的接著，完賽的在後；
  // 沒有完賽、沒有出賽的收在「其他紀錄」裡，預設收起：一長串沒跑完的紀錄容易讓人挫折（規格 12.15）
  const upcoming = races.filter((r) => raceOutcome(r) === null && r.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const awaiting = races.filter((r) => raceOutcome(r) === null && r.date < today);
  const finished = races.filter((r) => raceOutcome(r) === "finished");
  const others = races.filter((r) => raceOutcome(r) === "dnf" || raceOutcome(r) === "dns");
  const dups = duplicateGroups(races);

  return (
    <section className="card" id="races">
      <div className="card-head">
        <h2>賽事</h2>
        {form === null && <button onClick={() => setForm(EMPTY_RACE)}>新增賽事</button>}
      </div>
      {error && <div className="notice error">{error}</div>}
      {dups.length > 0 && (
        <div className="notice warn small">
          看起來重複（同一天、距離相近）：
          {dups.map((g) => g.map((r) => `「${r.name}」`).join("和")).join("；")}
          。可以把多的那筆刪除。
        </div>
      )}
      {form && (
        <form
          className="grid"
          onSubmit={(e) => {
            e.preventDefault();
            void saveRace(form);
          }}
        >
          <label className="wide">
            賽事名稱
            <AutoGrowTextarea enter="submit" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          {form.after ? (
            <p className="small muted wide">賽後只能改名稱與備註；成績用「修改成績」。</p>
          ) : (
            <>
              {featureEnabled("multisport") && (
                <label>
                  運動
                  <select value={form.sport} onChange={(e) => setForm({ ...form, sport: e.target.value as RaceForm["sport"] })}>
                    <option value="run">跑步</option>
                    <option value="ride">騎車（公路賽、百公里等）</option>
                  </select>
                </label>
              )}
              <label>
                日期
                <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </label>
              <label>
                距離（km）
                <input
                  inputMode="decimal"
                  value={form.distance}
                  placeholder="21.1"
                  onChange={(e) => setForm({ ...form, distance: e.target.value })}
                />
              </label>
              <label>
                目標時間
                <input value={form.target} placeholder="留空表示完賽即可" onChange={(e) => setForm({ ...form, target: e.target.value })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={form.confirmed} onChange={(e) => setForm({ ...form, confirmed: e.target.checked })} />
                已確認報名
              </label>
            </>
          )}
          <label className="wide">
            備註
            <AutoGrowTextarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
          <div className="actions wide">
            <button type="submit" className="primary">
              {form.id === null ? "新增" : "儲存變更"}
            </button>
            <button className="text" type="button" onClick={() => setForm(null)}>
              取消
            </button>
          </div>
        </form>
      )}
      {races.length === 0 && !form && <p className="muted">還沒有賽事。</p>}
      <ul className="list">{[...upcoming, ...awaiting, ...finished].map(renderRace)}</ul>
      {others.length > 0 && (
        <Disclosure className="races-other" summary={`其他紀錄 ${others.length} 場`}>
          <ul className="list">{others.map(renderRace)}</ul>
        </Disclosure>
      )}
    </section>
  );

  function renderRace(race: Race) {
    const outcome = raceOutcome(race);
    const after = isAfterRace(race, today);
    const raceDayOrLater = race.date <= today;
    return (
      <li key={race.id}>
        <div className="list-row">
          <span className="list-row-icon race-icon">
            <SportIcon sport={featureEnabled("multisport") && race.sport === "ride" ? "ride" : "race"} />
          </span>
          <span className="list-row-text">
            <span className="list-row-title">{race.name}</span>
            <span className="list-row-sub">
              {[
                featureEnabled("multisport") && race.sport === "ride" ? "騎車" : null,
                shortDateLabel(race.date),
                distanceText(race.distance_km * 1000),
                `目標 ${race.target_time || "完賽"}`,
                ...(outcome === "finished" ? resultDetail(race) : []),
                race.notes || null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <span className="list-row-end">{raceStatusText(race, today)}</span>
        </div>
        <div className="actions">
          <button
            className="text"
            onClick={() =>
              setForm({
                id: race.id,
                after,
                name: race.name,
                date: race.date,
                distance: String(race.distance_km),
                target: race.target_time ?? "",
                confirmed: Boolean(race.confirmed),
                notes: race.notes ?? "",
                sport: race.sport === "ride" ? "ride" : "run",
              })
            }
          >
            編輯
          </button>
          {raceDayOrLater && outcome !== "dns" && resultFor?.id !== race.id && (
            <button className={race.date < today && !outcome ? "primary" : "text"} onClick={() => openResult(race)}>
              {outcome ? "修改成績" : "記錄成績"}
            </button>
          )}
          {outcome === null && dnsFor?.id !== race.id && (
            <button
              className="text"
              onClick={() => {
                setResultFor(null);
                setDnsFor({ id: race.id, reason: "injury", note: "" });
              }}
            >
              {race.date < today ? "沒有出賽" : "不參加了"}
            </button>
          )}
          <button
            className="text danger"
            onClick={() => {
              if (confirm(`確定要刪除「${race.name}」嗎？刪除後無法復原。`)) void run(() => coach.deleteRace(race.id));
            }}
          >
            刪除
          </button>
        </div>
        {dnsFor?.id === race.id && (
          <form
            className="race-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await coach.markRaceNotStarted(race.id, dnsFor.reason, dnsFor.note);
                setDnsFor(null);
              });
            }}
          >
            <label>
              原因
              <select value={dnsFor.reason} onChange={(e) => setDnsFor({ ...dnsFor, reason: e.target.value as DnsReason })}>
                {Object.entries(DNS_REASONS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              補充（選填）
              <AutoGrowTextarea value={dnsFor.note} placeholder="例：右膝不適" onChange={(e) => setDnsFor({ ...dnsFor, note: e.target.value })} />
            </label>
            <p className="small muted">記下後不能恢復；紀錄會保留，教練之後會參考原因。</p>
            <div className="actions">
              <button type="submit" className="primary">
                {race.date < today ? "確定沒有出賽" : "確定不參加"}
              </button>
              <button className="text" type="button" onClick={() => setDnsFor(null)}>
                取消
              </button>
            </div>
          </form>
        )}
        {resultFor?.id === race.id && (
          <form
            className="race-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveResult(resultFor);
            }}
          >
            <div className="row">
              <label className="check">
                <input
                  type="radio"
                  checked={resultFor.outcome === "finished"}
                  onChange={() => setResultFor({ ...resultFor, outcome: "finished" })}
                />
                完賽
              </label>
              <label className="check">
                <input type="radio" checked={resultFor.outcome === "dnf"} onChange={() => setResultFor({ ...resultFor, outcome: "dnf" })} />
                沒有完賽
              </label>
            </div>
            {resultFor.outcome === "finished" ? (
              <>
                <label>
                  個人成績（淨時間）
                  <input
                    autoFocus
                    value={resultFor.time}
                    placeholder="例：1:55:30"
                    onChange={(e) => setResultFor({ ...resultFor, time: e.target.value })}
                  />
                </label>
                <label>
                  大會成績（槍聲起算，選填）
                  <input value={resultFor.gunTime} placeholder="例：1:57:02" onChange={(e) => setResultFor({ ...resultFor, gunTime: e.target.value })} />
                </label>
                <label>
                  成績來源
                  <select value={resultFor.source} onChange={(e) => setResultFor({ ...resultFor, source: e.target.value as ResultSource })}>
                    {Object.entries(RESULT_SOURCES).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="small muted">有晶片計時的話用大會給的個人成績，最準；推算訓練配速用這個。</p>
                {resultFor.watch === null && <p className="small muted">比賽當天沒有距離接近的手錶紀錄（可能還沒同步）。</p>}
                {resultFor.watch && (
                  <p className="small">
                    沒有正式成績的話，可以參考手錶紀錄：{resultFor.watch.distanceKm} km，{resultFor.watch.time}{" "}
                    <button type="button" className="link" onClick={() => setResultFor({ ...resultFor, time: resultFor.watch!.time, source: "watch" })}>
                      用這個時間
                    </button>
                  </p>
                )}
              </>
            ) : (
              <label>
                說明（選填）
                <AutoGrowTextarea
                  value={resultFor.note}
                  placeholder="例：25K 抽筋退賽"
                  onChange={(e) => setResultFor({ ...resultFor, note: e.target.value })}
                />
              </label>
            )}
            <div className="actions">
              <button type="submit" className="primary">
                儲存
              </button>
              <button className="text" type="button" onClick={() => setResultFor(null)}>
                取消
              </button>
            </div>
          </form>
        )}
      </li>
    );
  }
}
