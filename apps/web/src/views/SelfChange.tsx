import { useEffect, useState } from "react";

import {
  easyChangeable,
  injuryName,
  PAIN_LIMIT,
  ratioText,
  SELF_CHANGE_REASONS,
  SHORTEN_RATIOS,
  type Injury,
  type SelfChange,
  type SelfChangeReason,
  type SelfChangeRequest,
  type SessionKind,
} from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { PainPicker } from "../ui";
import { AddInjury } from "./Injuries";

/** 「改課」的選擇：短一點（約 3/4）、一半、換成輕鬆（規格 12.34 第 3 點 B）；改長、加量請教練 */
export function ChangeChooser({ kind, onPick }: { kind: SessionKind; onPick: (request: SelfChangeRequest) => void }) {
  return (
    <div className="session-actions self-change-choices" role="group" aria-label="改課">
      {SHORTEN_RATIOS.map((ratio) => (
        <button key={ratio} onClick={() => onPick({ action: "shorten", ratio })}>
          {ratio === 0.5 ? "一半" : "短一點（約 3/4）"}
        </button>
      ))}
      {easyChangeable(kind) && <button onClick={() => onPick({ action: "easy" })}>換成輕鬆</button>}
    </div>
  );
}

/** 改了什麼，例：「自己改短到約 3/4・原本 16 km 長跑，約 16 km、95 分鐘」 */
export function selfChangeLine(c: SelfChange): string {
  const what = c.action === "shorten" ? `自己改短到${ratioText(c.ratio)}` : "自己換成輕鬆";
  return `${what}・原本「${c.original.title}」，${c.km ? `約 ${c.km} km、` : "約 "}${c.minutes} 分鐘`;
}

/** 改了之後的原因：按一下就好，不按也行；再按一次取消. 「不舒服」接到傷病的流程（規格 12.33） */
export function ReasonChips({ id, change, title }: { id: number; change: SelfChange; title: string }) {
  const { coach, touch } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [unwell, setUnwell] = useState(false);
  async function pick(reason: SelfChangeReason) {
    const next = change.reason === reason ? null : reason;
    try {
      await coach.selfChangeReason(id, next);
      setError(null);
      setUnwell(next === "unwell");
      touch();
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <div className="self-change-reason">
      <span className="small muted">為什麼改？可以不選</span>
      <div className="segmented" role="group" aria-label="為什麼改">
        {(Object.keys(SELF_CHANGE_REASONS) as SelfChangeReason[]).map((r) => (
          <button key={r} type="button" aria-pressed={change.reason === r} onClick={() => void pick(r)}>
            {SELF_CHANGE_REASONS[r]}
          </button>
        ))}
      </div>
      {unwell && <UnwellPanel id={id} title={title} />}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

/** 記下分數之後，這堂課現在是不是「先不要做」（傷病的規則由核心算，和課卡的標示同一個來源） */
async function holdOf(coach: ReturnType<typeof useApp>["coach"], id: number): Promise<string | null> {
  const plans = await Promise.all([coach.activePlan(), coach.nextPlan()]);
  for (const p of plans) {
    const s = p?.sessions.find((x) => x.id === id);
    if (s) return s.injuryHold;
  }
  return null;
}

/**
 * 不舒服：哪裡（已有的傷病或新增）→ 現在幾分 → 記進傷病紀錄. 之後照傷病的安全規則：檢查器依分數擋課、課表標「先不要做」.
 * 每一種結果都寫出「這堂課」接下來怎樣（staging 試用的回饋，規格 12.38）：照改過的上，或先不要做；
 * 在選部位那一步按「先不用」也一樣（原因已經記成不舒服），並提示記下部位和分數的好處.
 * 不診斷、不給治療的建議；可以跟教練說，教練會照傷病的處理先問清楚
 */
function UnwellPanel({ id, title }: { id: number; title: string }) {
  const { coach, touch, goTo } = useApp();
  const [injuries, setInjuries] = useState<Injury[] | null>(null);
  const [chosen, setChosen] = useState<Injury | null>(null);
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState<{ score: number; hold: string | null } | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void coach.db.getInjuries().then(setInjuries);
  }, [coach]);

  async function score(n: number) {
    if (!chosen) return;
    try {
      await coach.db.addInjuryScore(chosen.id, { date: coach.today(), score: n, when: "checkin" });
      setSaved({ score: n, hold: await holdOf(coach, id) });
      setError(null);
      touch();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function add(input: Parameters<typeof coach.db.addInjury>[0]) {
    try {
      const injuryId = await coach.db.addInjury(input);
      const list = await coach.db.getInjuries();
      setInjuries(list);
      setChosen(list.find((i) => i.id === injuryId) ?? null);
      setAdding(false);
      touch();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const tell = (text: string) => (
    <div className="session-actions">
      <button className="text" onClick={() => goTo("chat", text)}>
        跟教練說
      </button>
    </div>
  );

  let body;
  if (saved) {
    const name = injuryName(chosen!);
    body = (
      <>
        <p className="small unwell-outcome">{saved.hold ? "這堂課：先不要做" : "這堂課：照改過的上"}</p>
        <p className="small">
          已記下{name} {saved.score}/10。
          {saved.hold
            ? `疼痛超過 ${PAIN_LIMIT} 分，會痛的運動先不排強度課與長課。請教練換成不會痛的運動或休息。`
            : saved.score > PAIN_LIMIT
              ? `疼痛超過 ${PAIN_LIMIT} 分，會痛的運動之後的強度課與長課先不排；這堂課可以照改過的上，運動中痛起來就停。`
              : `運動中不超過 ${PAIN_LIMIT} 分、隔天早上回到平常、沒有越來越痛就可以。`}
          越來越痛、腫起來或休息也痛，請先休息並看醫師。
        </p>
        {tell(`今天的「${title}」我改了，因為${name}不舒服，現在 ${saved.score}/10。`)}
      </>
    );
  } else if (skipped) {
    body = (
      <>
        <p className="small unwell-outcome">這堂課：照改過的上</p>
        <p className="small">已記下原因：不舒服。記下部位和分數，教練才能幫你避開會痛的課。</p>
        <div className="session-actions">
          <button onClick={() => setSkipped(false)}>記下部位</button>
          <button className="text" onClick={() => goTo("chat", `今天的「${title}」我改了，因為身體不舒服。`)}>
            跟教練說
          </button>
        </div>
      </>
    );
  } else if (chosen) {
    body = (
      <div className="pain-question">
        <span>{injuryName(chosen)}現在幾分？</span>
        <PainPicker value={null} label={`${injuryName(chosen)}的疼痛`} onChange={(n) => void score(n)} />
      </div>
    );
  } else if (adding) {
    body = <AddInjury add={(input) => void add(input)} cancel={() => setAdding(false)} />;
  } else {
    body = (
      <>
        <p className="small">哪裡不舒服？</p>
        <div className="session-actions">
          {injuries?.map((i) => (
            <button key={i.id} onClick={() => setChosen(i)}>
              {injuryName(i)}
            </button>
          ))}
          <button onClick={() => setAdding(true)}>{injuries?.length ? "其他部位" : "記下部位"}</button>
          <button className="text" onClick={() => setSkipped(true)}>
            先不用
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="unwell-panel" role="group" aria-label="哪裡不舒服">
      {body}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
