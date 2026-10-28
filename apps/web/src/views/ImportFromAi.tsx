import { useState } from "react";

import { IMPORT_PROMPT, PROFILE_FIELDS, type ImportedRace, type ImportSuggestion } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { InfoTip } from "../ui";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { Markdown } from "../Markdown";

interface ProfileChoice {
  key: string;
  label: string;
  current: string | undefined;
  value: string;
  selected: boolean;
}

interface RaceChoice {
  race: ImportedRace;
  /** 已有同一天、未取消的賽事 */
  duplicate: boolean;
  selected: boolean;
}

interface Review {
  profile: ProfileChoice[];
  races: RaceChoice[];
  plan: { value: string; replaces: boolean; selected: boolean } | null;
}

const distanceText = (km: number) =>
  Math.abs(km - 42.195) < 0.01 ? "全馬" : Math.abs(km - 21.0975) < 0.01 ? "半馬" : `${Number(km.toFixed(2))} km`;

/**
 * 從其他 AI 服務帶入（規格 6.5）：使用者貼上原本的服務整理好的內容，模型擷取成建議值，逐項確認後寫入.
 * 原文只在這個元件的狀態裡，不寫入資料庫；帶入、取消或離開這頁就會丟掉。
 * startOpen：直接從貼上的步驟開始（選手頁的下一層、計畫頁的賽事）；帶入或取消後呼叫 onClose
 */
export function ImportFromAi({ startOpen = false, onClose }: { startOpen?: boolean; onClose?: () => void } = {}) {
  const { coach, llmProblem, touch, goTo, toast } = useApp();
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  function close() {
    setOpen(false);
    setText("");
    setReview(null);
    setCopied(false);
    onClose?.();
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(IMPORT_PROMPT);
      setCopied(true);
    } catch {
      setMessage({ kind: "error", text: "無法自動複製，請手動選取上方的提示詞複製。" });
    }
  }

  async function extract() {
    setBusy(true);
    setMessage(null);
    try {
      const [suggestion, profile, races, plan] = await Promise.all([
        coach.extractImport(text),
        coach.db.getProfile(),
        coach.db.getAllRaces(),
        coach.db.getActiveTrainingPlan(),
      ]);
      setReview(toReview(suggestion, profile, races, plan !== null));
    } catch (e) {
      setMessage({ kind: "error", text: `整理失敗：${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!review) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await coach.applyImport({
        profile: Object.fromEntries(review.profile.filter((p) => p.selected).map((p) => [p.key, p.value])),
        races: review.races.filter((r) => r.selected).map((r) => r.race),
        plan: review.plan?.selected ? review.plan.value : null,
      });
      const parts = [
        result.profile > 0 && `選手資料 ${result.profile} 項`,
        result.races > 0 && `賽事 ${result.races} 場`,
        result.plan && "本週課表",
      ].filter(Boolean);
      const done = `已帶入${parts.join("、")}。原本貼上的內容已丟棄。`;
      // 帶入後回到打開它的地方時，結果用畫面下方的小提示說
      if (onClose) toast(done);
      else setMessage({ kind: "ok", text: done });
      close();
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: `帶入失敗：${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>從其他 AI 帶入</h2>
          <InfoTip label="從其他 AI 帶入的說明">
            已經在 ChatGPT、Claude 等服務跟 AI 聊過訓練？請它整理你的資料，貼回來後幫你填好選手資料、賽事與課表，確認後再帶入。
          </InfoTip>
        </div>
        <p className="muted">跟其他 AI 聊過訓練？把它整理的資料帶進來。</p>
        <div className="actions">
          <button
            onClick={() => {
              setMessage(null);
              setOpen(true);
            }}
          >
            開始
          </button>
        </div>
        {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
      </section>
    );
  }

  if (review) {
    const count =
      review.profile.filter((p) => p.selected).length +
      review.races.filter((r) => r.selected).length +
      (review.plan?.selected ? 1 : 0);
    const empty = review.profile.length === 0 && review.races.length === 0 && review.plan === null;
    const setProfile = (i: number, patch: Partial<ProfileChoice>) =>
      setReview({ ...review, profile: review.profile.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
    const setRace = (i: number, selected: boolean) =>
      setReview({ ...review, races: review.races.map((r, j) => (j === i ? { ...r, selected } : r)) });

    return (
      <section className="card import">
        <h2>確認要帶入的資料</h2>
        {empty ? (
          <p className="small">沒有找到可以帶入的資料。可以回上一步補充內容再試一次。</p>
        ) : (
          <p className="muted small">勾選要帶入的項目，可以先修改。與目前不同的值預設不勾選。</p>
        )}

        {review.profile.length > 0 && (
          <div className="import-group">
            <strong>選手資料</strong>
            {review.profile.map((p, i) => (
              <div className="import-item" key={p.key}>
                <input
                  type="checkbox"
                  aria-label={`帶入${p.label}`}
                  checked={p.selected}
                  onChange={(e) => setProfile(i, { selected: e.target.checked })}
                />
                <label>
                  {p.label}
                  <AutoGrowTextarea enter="submit" value={p.value} onChange={(e) => setProfile(i, { value: e.target.value, selected: true })} />
                  {p.current !== undefined && <span className="small">目前：{p.current}</span>}
                </label>
              </div>
            ))}
          </div>
        )}

        {review.races.length > 0 && (
          <div className="import-group">
            <strong>未來賽事</strong>
            {review.races.map((r, i) => (
              <label className="check" key={`${r.race.date}-${r.race.name}`}>
                <input type="checkbox" checked={r.selected} onChange={(e) => setRace(i, e.target.checked)} />
                <span>
                  {r.race.date} {r.race.name}（{distanceText(r.race.distance_km)}
                  {r.race.target_time ? `，目標 ${r.race.target_time}` : ""}
                  {r.race.start_time ? `，${r.race.start_time} 起跑` : ""}
                  {r.race.place ? `，${r.race.place.label}` : ""}）
                  {r.duplicate && <span className="muted small">　已有同一天的賽事</span>}
                </span>
              </label>
            ))}
            <p className="muted small">帶入後可以在「計畫」修改。</p>
          </div>
        )}

        {review.plan && (
          <div className="import-group">
            <label className="check">
              <input
                type="checkbox"
                checked={review.plan.selected}
                onChange={(e) => setReview({ ...review, plan: { ...review.plan!, selected: e.target.checked } })}
              />
              <strong>設為本週課表</strong>
            </label>
            {review.plan.replaces && <p className="muted small">會取代目前的本週計畫。</p>}
            <div className="import-plan">
              <Markdown>{review.plan.value}</Markdown>
            </div>
          </div>
        )}

        {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
        <div className="actions">
          <button className="primary" disabled={busy || count === 0} onClick={() => void apply()}>
            {busy ? "帶入中…" : `帶入選取的 ${count} 項`}
          </button>
          <button className="text" disabled={busy} onClick={() => setReview(null)}>
            上一步
          </button>
          <button className="text" disabled={busy} onClick={close}>
            取消
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card import">
      <h2>從其他 AI 帶入</h2>
      <ol className="guide small">
        <li>複製下面的提示詞，貼到你原本使用的 AI 服務（例如 ChatGPT、Claude）送出。</li>
        <li>把它的回覆整段貼到下方，按「整理」。也可以直接貼上與教練或跑友的對話。</li>
        <li>確認整理出來的資料，勾選要帶入的項目。</li>
      </ol>
      <textarea readOnly rows={6} value={IMPORT_PROMPT} aria-label="提示詞" className="small" />
      <div className="actions">
        <button onClick={() => void copyPrompt()}>{copied ? "已複製" : "複製提示詞"}</button>
      </div>
      <textarea
        rows={8}
        value={text}
        aria-label="整理好的內容"
        placeholder="把原本的 AI 整理好的內容貼在這裡"
        onChange={(e) => setText(e.target.value)}
      />
      <p className="field-note">內容會送到你的 AI 模型整理，不存進資料庫，離開這頁就丟掉。</p>
      {llmProblem && (
        <div className="notice warn">
          {llmProblem}，目前無法整理。
          <button className="text" onClick={() => goTo("settings")}>
            前往設定
          </button>
        </div>
      )}
      {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
      <div className="actions">
        <button
          className="primary"
          disabled={busy || text.trim() === "" || llmProblem !== null}
          onClick={() => void extract()}
        >
          {busy ? "整理中…" : "整理"}
        </button>
        <button className="text" disabled={busy} onClick={close}>
          取消
        </button>
      </div>
    </section>
  );
}

function toReview(
  suggestion: ImportSuggestion,
  current: Record<string, string>,
  races: { date: string; cancelled?: number | null }[],
  hasPlan: boolean,
): Review {
  const profile = PROFILE_FIELDS.flatMap((field): ProfileChoice[] => {
    const value = suggestion.profile[field.key];
    if (value === undefined || value === current[field.key]) return [];
    const existing = current[field.key];
    return [{ key: field.key, label: field.label, current: existing, value, selected: existing === undefined }];
  });
  const taken = new Set(races.filter((r) => !r.cancelled).map((r) => r.date));
  return {
    profile,
    races: suggestion.races.map((race) => ({ race, duplicate: taken.has(race.date), selected: !taken.has(race.date) })),
    plan: suggestion.plan ? { value: suggestion.plan, replaces: hasPlan, selected: !hasPlan } : null,
  };
}
