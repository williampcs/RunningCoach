import { useEffect, useState } from "react";

import {
  INJURY_SIDE_LABELS,
  INJURY_STATUS_LABELS,
  injuryName,
  latestPain,
  PAIN_LIMIT,
  PAIN_WHEN_LABELS,
  SCORE_STALE_DAYS,
  SPORT_CHOICES,
  SPORT_LABELS,
  type Injury,
  type InjuryInput,
  type InjurySide,
  type InjuryStatus,
  type Sport,
} from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { Disclosure, InfoTip, PainPicker } from "../ui";

const SIDES = Object.keys(INJURY_SIDE_LABELS) as InjurySide[];
const sideLabel = (side: InjurySide) => INJURY_SIDE_LABELS[side] || "不分";

/** 一行的摘要：會痛的運動、最近的分數，例：「跑步｜最近 4/10（10/27）」 */
function summaryOf(i: Injury): string {
  const latest = latestPain(i);
  return [
    i.sports.length ? i.sports.map((s) => SPORT_LABELS[s]).join("、") : "全部的運動",
    latest ? `最近 ${latest.score}/10（${Number(latest.date.slice(5, 7))}/${Number(latest.date.slice(8))}）` : "還沒有分數",
    i.red_flag ? "要先就醫" : null,
  ]
    .filter(Boolean)
    .join("｜");
}

/** 會痛的運動：都不勾是不知道（當成全部） */
function SportsChoice({ value, onChange }: { value: Sport[]; onChange: (sports: Sport[]) => void }) {
  return (
    <fieldset className="wide sports-picker">
      <legend>會痛的運動</legend>
      <div className="row">
        {SPORT_CHOICES.map((sport) => (
          <label key={sport} className="check">
            <input
              type="checkbox"
              checked={value.includes(sport)}
              onChange={() => onChange(value.includes(sport) ? value.filter((s) => s !== sport) : [...value, sport])}
            />
            {SPORT_LABELS[sport]}
          </label>
        ))}
      </div>
      <p className="field-note">都不勾是不知道，當成全部的運動都會痛。</p>
    </fieldset>
  );
}

/** 一個傷：改了就存（選單、勾選、分數；備註離開欄位時） */
function InjuryItem({ injury, save, remove }: { injury: Injury; save: (input: InjuryInput, score?: number) => void; remove: () => void }) {
  const [notes, setNotes] = useState(injury.notes ?? "");
  const today = useApp().coach.today();
  const todayScore = injury.scores.find((s) => s.date === today && s.when === "checkin")?.score ?? null;
  return (
    <li className="injury" data-id={injury.id}>
      <Disclosure
        summary={
          <span className="injury-head">
            <strong>{injuryName(injury)}</strong>
            <span className="chip">{INJURY_STATUS_LABELS[injury.status]}</span>
            <span className="small muted">{summaryOf(injury)}</span>
          </span>
        }
      >
        <div className="injury-fields">
          <div className="pain-question">
            <span>今天幾分？{todayScore !== null && <strong> {todayScore}/10</strong>}</span>
            <PainPicker value={todayScore} label={`${injuryName(injury)}的疼痛`} onChange={(n) => save({}, n)} />
          </div>
          {injury.scores.length > 0 && (
            <p className="small muted">
              最近的分數：
              {injury.scores
                .slice(-5)
                .map((s) => `${Number(s.date.slice(5, 7))}/${Number(s.date.slice(8))} ${PAIN_WHEN_LABELS[s.when]} ${s.score}`)
                .join("、")}
            </p>
          )}
          <div className="grid">
            <label>
              狀態
              <select value={injury.status} onChange={(e) => save({ status: e.target.value as InjuryStatus })}>
                {Object.entries(INJURY_STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              哪一側
              <select value={injury.side} onChange={(e) => save({ side: e.target.value as InjurySide })}>
                {SIDES.map((s) => (
                  <option key={s} value={s}>
                    {sideLabel(s)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <SportsChoice value={injury.sports} onChange={(sports) => save({ sports })} />
          <label className="check">
            <input type="checkbox" checked={injury.red_flag} onChange={(e) => save({ red_flag: e.target.checked })} />
            有需要就醫的警訊、還沒給醫師看過（先不排任何運動）
          </label>
          <label>
            備註
            <AutoGrowTextarea value={notes} placeholder="例如：下樓梯會痛" onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (injury.notes ?? "") && save({ notes })} />
          </label>
          <div className="actions">
            <button className="text danger" onClick={() => confirm(`刪掉「${injuryName(injury)}」的紀錄？之後教練與檢查器都不會再看到。`) && remove()}>
              刪除
            </button>
          </div>
        </div>
      </Disclosure>
    </li>
  );
}

/** 新增一個傷：部位、哪一側、會痛的運動 */
export function AddInjury({ add, cancel }: { add: (input: InjuryInput & { area: string }) => void; cancel: () => void }) {
  const [area, setArea] = useState("");
  const [side, setSide] = useState<InjurySide>("none");
  const [sports, setSports] = useState<Sport[]>([]);
  return (
    <form
      className="injury-fields"
      onSubmit={(e) => {
        e.preventDefault();
        add({ area, side, sports });
      }}
    >
      <div className="grid">
        <label>
          部位
          <input value={area} placeholder="例如：膝蓋、小腿、足底" onChange={(e) => setArea(e.target.value)} />
        </label>
        <label>
          哪一側
          <select value={side} onChange={(e) => setSide(e.target.value as InjurySide)}>
            {SIDES.map((s) => (
              <option key={s} value={s}>
                {sideLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <SportsChoice value={sports} onChange={setSports} />
      <div className="actions">
        <button type="submit" className="primary" disabled={!area.trim()}>
          新增
        </button>
        <button type="button" className="text" onClick={cancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/**
 * 傷病紀錄（規格 12.33）：選手 → 身體. 教練問完會記在這裡；選手看得到、可以改、標成好了或刪除.
 * 檢查器依這份紀錄擋課，所以會痛的運動與分數要準
 */
export function InjuriesCard() {
  const { coach, revision, touch, toast } = useApp();
  const [items, setItems] = useState<Injury[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void coach.db.getInjuries({ includeResolved: true }).then(setItems);
  }, [coach, revision]);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      setError(null);
      setItems(await coach.db.getInjuries({ includeResolved: true }));
      touch();
      toast("已儲存");
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }

  const save = (id: number) => (input: InjuryInput, score?: number) =>
    void act(async () => {
      await coach.db.updateInjury(id, input);
      if (score !== undefined) await coach.db.addInjuryScore(id, { date: coach.today(), score, when: "checkin" });
    });
  const open = items?.filter((i) => i.status !== "resolved") ?? [];
  const resolved = items?.filter((i) => i.status === "resolved") ?? [];
  const item = (i: Injury) => <InjuryItem key={`${i.id}-${i.updated_at}`} injury={i} save={save(i.id)} remove={() => void act(() => coach.db.deleteInjury(i.id))} />;

  return (
    <section className="card injuries">
      <div className="card-head">
        <h2>傷病紀錄</h2>
        <InfoTip label="傷病紀錄的說明">
          跟教練說哪裡痛，教練會先問清楚，跟你確認後記在這裡；你也可以自己新增或修改。排課時，會痛的運動在疼痛超過 {PAIN_LIMIT}/10、或超過 {SCORE_STALE_DAYS}{" "}
          天沒有回報分數時，不排強度課與長課；有需要就醫的警訊時，所有運動都先不排。教練不診斷，也不給治療或復健的動作，請以醫師或物理治療師的意見為準。
        </InfoTip>
      </div>
      {items && !open.length && !adding && <p className="muted small">現在沒有。哪裡痛時跟教練說，教練會問清楚再記下。</p>}
      {open.length > 0 && <ul className="injury-list">{open.map(item)}</ul>}
      {adding ? (
        <AddInjury add={(input) => void act(() => coach.db.addInjury(input)).then((ok) => ok && setAdding(false))} cancel={() => setAdding(false)} />
      ) : (
        <div className="actions">
          <button onClick={() => setAdding(true)}>新增傷病</button>
        </div>
      )}
      {resolved.length > 0 && (
        <Disclosure summary={`好了的（${resolved.length}）`}>
          <ul className="injury-list">{resolved.map(item)}</ul>
        </Disclosure>
      )}
      {error && <p className="field-error">{error}</p>}
    </section>
  );
}
