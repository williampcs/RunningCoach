import {
  athleteSports,
  computeTrainingValues,
  formatPace,
  INJURY_STATUS_LABELS,
  injuryName,
  PREFERENCE_OPTIONS,
  SPORT_CHOICES,
  SPORT_LABELS,
  sportGoalKey,
  type Injury,
  type Sport,
  type TrainingValues,
} from "@running-coach/core";
import { Bookmark, ChevronLeft, ChevronRight, HeartPulse, Import, SlidersHorizontal, Target, Trophy, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { errorText, useApp } from "../app-context";
import { Disclosure, Icon, ListRow, SportIcon } from "../ui";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { featureEnabled } from "../environment";
import { ConversationSummaryCard, MemoriesCard } from "./Memories";
import { ImportFromAi } from "./ImportFromAi";
import { InjuriesCard } from "./Injuries";
import { TrainingValuesCard } from "./TrainingValues";

interface Field {
  key: string;
  label: string;
  placeholder?: string;
  wide?: boolean;
  /** 有選項時顯示成下拉選單 */
  options?: Record<string, string>;
  /** 下拉選單沒選時的說法（預設「未填」） */
  emptyLabel?: string;
  /** 會打長文字：自動長高（Enter 照舊存，不換行） */
  long?: boolean;
}

const GOAL_FIELDS: Field[] = [
  { key: "goal_long_term", label: "長期目標", placeholder: "例如：全馬破四", wide: true, long: true },
  { key: "weekly_km_target", label: "每週目標里程（km）", placeholder: "40" },
];

const PB_FIELDS: Field[] = [
  { key: "pb_5k", label: "5km", placeholder: "22:40" },
  { key: "pb_10k", label: "10km", placeholder: "48:30" },
  { key: "pb_half", label: "半馬", placeholder: "1:52:10" },
  { key: "pb_full", label: "全馬", placeholder: "4:05:00" },
];

/** 身體：生理資料＋傷病注意 */
const BODY_FIELDS: Field[] = [
  { key: "gender", label: "性別" },
  { key: "birth_year", label: "出生年（西元）", placeholder: "1990" },
  { key: "height_cm", label: "身高（cm）" },
  { key: "weight_kg", label: "體重（kg）" },
  { key: "body_fat_pct", label: "體脂（%）" },
  { key: "max_hr", label: "最大心率（實測）", placeholder: "未填則以 220 − 年齡推算" },
  { key: "resting_hr", label: "靜息心率" },
  { key: "injuries", label: "舊傷與長期要注意的", placeholder: "例如：右膝舊傷；現在會痛的記在上面的傷病紀錄", wide: true, long: true },
];

/** 只跑步時的訓練偏好；不常改的收在「更多」 */
const RUN_PREFERENCES: Field[] = [
  { key: "pref_goal", label: "目標", options: PREFERENCE_OPTIONS.pref_goal, wide: true },
  { key: "pref_intensity", label: "強度", options: PREFERENCE_OPTIONS.pref_intensity, wide: true },
  { key: "pref_runs_per_week", label: "每週最多幾次", placeholder: "4" },
  { key: "pref_max_minutes", label: "每次最多幾分鐘", placeholder: "60" },
  { key: "pref_long_run_day", label: "長跑日", placeholder: "週日" },
  { key: "pref_rest_days", label: "休息日", placeholder: "週一、週五" },
];
const RUN_PREFERENCES_MORE: Field[] = [
  { key: "pref_schedule", label: "節奏", options: PREFERENCE_OPTIONS.pref_schedule, wide: true },
  { key: "pref_train_time", label: "偏好時段", placeholder: "清晨" },
  { key: "pref_other", label: "其他會做的運動", placeholder: "騎車、重訓", wide: true, long: true },
];

/** 多運動的共通設定（一個人的時間是共用的，跨運動一起算）；不常改的收在「更多」 */
const COMMON_FIELDS: Field[] = [
  { key: "pref_days_per_week", label: "每週最多練幾天", placeholder: "5" },
  { key: "pref_rest_days", label: "休息日", placeholder: "週一、週五" },
];
const COMMON_FIELDS_MORE: Field[] = [
  { key: "pref_schedule", label: "節奏", options: PREFERENCE_OPTIONS.pref_schedule, wide: true },
  { key: "pref_train_time", label: "偏好時段", placeholder: "清晨" },
  { key: "pref_other", label: "其他活動（不排課，只讓教練知道）", placeholder: "登山、球類、瑜伽", wide: true, long: true },
];

/** 每項運動的下一層：跑步沿用原本的欄位（舊資料自動帶過去） */
const SPORT_FIELDS: Record<"run" | "ride", Field[]> = {
  run: [
    { key: "pref_goal", label: "跑步的目標", options: PREFERENCE_OPTIONS.pref_goal, wide: true },
    { key: "pref_intensity", label: "跑步的強度", options: PREFERENCE_OPTIONS.pref_intensity, wide: true },
    { key: "pref_runs_per_week", label: "每週跑幾次", placeholder: "4" },
    { key: "pref_max_minutes", label: "跑步每次最多幾分鐘", placeholder: "60" },
    { key: "pref_long_run_day", label: "長跑日", placeholder: "週日" },
  ],
  ride: [
    { key: "pref_goal_ride", label: "騎車的目標", options: PREFERENCE_OPTIONS.pref_goal_ride, wide: true },
    { key: "pref_intensity_ride", label: "騎車的強度", options: PREFERENCE_OPTIONS.pref_intensity_ride, emptyLabel: "未填（沿用跑步的）", wide: true },
    { key: "pref_ride_hours", label: "每週騎幾小時", placeholder: "3" },
    { key: "pref_ride_max_minutes", label: "騎車每次最多幾分鐘", placeholder: "120" },
    { key: "pref_long_ride_day", label: "長騎日", placeholder: "週六" },
  ],
};

/** 跑步、騎車以外的運動的目標的提示（文字；跑步、騎車的目標在各自的下一層用選單） */
const GOAL_PLACEHOLDERS: Partial<Record<Sport, string>> = {
  swim: "例如：每週一次、恢復用",
  strength: "例如：每週兩次、預防受傷",
  other: "例如：瑜伽、爬山",
};

type Form = Record<string, string>;
/** 改一個欄位；commit 是立刻存（選單、勾選），打字的欄位離開時才存 */
type SetField = (key: string, value: string, commit?: boolean) => void;
type Commit = (key: string) => void;

function FieldInput({ field, form, setField, commit }: { field: Field; form: Form; setField: SetField; commit: Commit }) {
  const value = form[field.key] ?? "";
  // 選單：舊資料不是選項之一時（例如以前用文字寫的騎車目標）照原文留著
  const legacy = field.options && value && !(value in field.options) ? value : null;
  return (
    <label className={field.wide ? "wide" : ""}>
      {field.label}
      {field.options ? (
        <select value={value} onChange={(e) => setField(field.key, e.target.value, true)}>
          <option value="">{field.emptyLabel ?? "未填"}</option>
          {Object.entries(field.options).map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
          {legacy && <option value={legacy}>{legacy}（原本寫的）</option>}
        </select>
      ) : field.long ? (
        <AutoGrowTextarea
          enter="submit"
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => setField(field.key, e.target.value)}
          onBlur={() => commit(field.key)}
          onKeyDown={(e) => {
            // 不換行：Enter 就是打完了（離開欄位時存）
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <input
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => setField(field.key, e.target.value)}
          onBlur={() => commit(field.key)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.currentTarget.blur()}
        />
      )}
    </label>
  );
}

function Fields({ fields, ...props }: { fields: Field[]; form: Form; setField: SetField; commit: Commit }) {
  return (
    <div className="grid">
      {fields.map((field) => (
        <FieldInput key={field.key} field={field} {...props} />
      ))}
    </div>
  );
}

type Page = "values" | "goal" | "training" | "run" | "ride" | "pb" | "body" | "memory" | "import";

const ROWS: { id: Page; title: string; icon: LucideIcon }[] = [
  { id: "goal", title: "目標", icon: Target },
  { id: "training", title: "練什麼、怎麼練", icon: SlidersHorizontal },
  { id: "pb", title: "個人最佳", icon: Trophy },
  { id: "body", title: "身體", icon: HeartPulse },
  { id: "memory", title: "教練記得的事", icon: Bookmark },
];

const TITLES: Record<Page, string> = {
  values: "我的數字",
  goal: "目標",
  training: "練什麼、怎麼練",
  run: "跑步",
  ride: "騎車",
  pb: "個人最佳",
  body: "身體",
  memory: "教練記得的事",
  import: "從其他 AI 帶入",
};

/** 選手頁的下一層：返回、標題，下面是欄位 */
function Subpage({ page, back, backLabel, children }: { page: Page; back: () => void; backLabel: string; children: ReactNode }) {
  return (
    <div className="stack subpage profile-subpage" data-page={page}>
      <div className="subpage-head">
        <button className="back-button" aria-label={`回到${backLabel}`} onClick={back}>
          <Icon as={ChevronLeft} />
          {backLabel}
        </button>
      </div>
      <h3 className="title">{TITLES[page]}</h3>
      {children}
    </div>
  );
}

/** 「從其他 AI 帶入」的文字按鈕（放在和它帶入的範圍有關的地方：目標、個人最佳、身體與賽事、課表） */
function ImportButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="text import-button" onClick={onClick}>
      <Icon as={Import} size={18} />
      從其他 AI 帶入
    </button>
  );
}

const pace = (secs: number) => formatPace(secs).replace("/km", "");
const pct = (part: number, total: number) => Math.round((part / total) * 100);

/** 最上面「我的數字」：教練排課表用的幾個數字；點進去是完整的訓練數值 */
function MyNumbers({ open }: { open: () => void }) {
  const { coach, revision } = useApp();
  const [values, setValues] = useState<TrainingValues | null>(null);
  useEffect(() => {
    void computeTrainingValues(coach.db, coach.db.today()).then(setValues);
  }, [coach, revision]);
  if (!values) return null;
  const { hr, vdot, paces, distribution: d } = values;
  const total = d.lowSecs + d.moderateSecs + d.highSecs;
  const numbers = [
    vdot && { value: vdot.value.toFixed(1), label: "VDOT" },
    paces && { value: pace(paces.threshold), label: "閾值 /km" },
    hr && { value: String(hr.easyMax), label: "輕鬆跑上限" },
  ].filter((n): n is { value: string; label: string } => Boolean(n));
  return (
    <section className="card my-numbers">
      <button type="button" className="my-numbers-head" aria-label="我的數字：看完整的訓練數值" onClick={open}>
        <span className="list-row-text">
          <span className="list-row-title">我的數字</span>
          <span className="list-row-sub">教練排課表用的數字，同步後更新</span>
        </span>
        <Icon as={ChevronRight} />
      </button>
      {numbers.length > 0 ? (
        <div className="my-numbers-values">
          {numbers.map((n) => (
            <span key={n.label}>
              <span className="num">{n.value}</span>
              <span className="small muted">{n.label}</span>
            </span>
          ))}
        </div>
      ) : (
        <p className="small muted">還算不出來：同步跑步紀錄、回報一場比賽的成績，或填最大心率與出生年，就會有配速與心率。</p>
      )}
      {total > 0 ? (
        <>
          <div className="split-bar" role="img" aria-label={`最近 28 天：低強度 ${pct(d.lowSecs, total)}%、中強度 ${pct(d.moderateSecs, total)}%、高強度 ${pct(d.highSecs, total)}%`}>
            <span className="low" style={{ flexGrow: d.lowSecs }} />
            <span className="moderate" style={{ flexGrow: d.moderateSecs }} />
            <span className="high" style={{ flexGrow: d.highSecs }} />
          </div>
          <p className="small legend">
            <span>最近 28 天：低 {pct(d.lowSecs, total)}%</span>
            <span>中 {pct(d.moderateSecs, total)}%</span>
            <span>高 {pct(d.highSecs, total)}%</span>
          </p>
        </>
      ) : (
        <p className="small muted">最近 28 天的強度分配：要有心率區間的資料（手錶有心率、Intervals.icu 設好區間）。</p>
      )}
    </section>
  );
}

/** 選項的說法，括號裡的說明在摘要裡省略（「適度（每週一堂強度課）」寫「適度」） */
const optionText = (options: Record<string, string>, value: string | undefined) => (value ? (options[value] ?? value).replace(/（[^）]*）$/, "") : null);
const join = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · ");

export function ProfileView() {
  const { coach, revision, touch, toast } = useApp();
  const [saved, setSaved] = useState<Form>({});
  const [form, setForm] = useState<Form>({});
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  // 從哪一頁打開「從其他 AI 帶入」：帶入或取消後回到那裡
  const [importFrom, setImportFrom] = useState<Page | null>(null);
  const [memory, setMemory] = useState<{ count: number; summary: string | null }>({ count: 0, summary: null });
  const [injuries, setInjuries] = useState<Injury[]>([]);
  const multisport = featureEnabled("multisport");

  // 重新讀取（例如別台同步過來）時，保留這裡改到一半、還沒存的欄位，其他的換成最新的
  const latest = useRef({ saved, form });
  latest.current = { saved, form };
  useEffect(() => {
    void coach.db.getProfile().then((profile) => {
      const { saved: before, form: editing } = latest.current;
      const edited = Object.fromEntries(Object.entries(editing).filter(([key, value]) => (value ?? "").trim() !== (before[key] ?? "")));
      setSaved(profile);
      setForm({ ...profile, ...edited });
    });
    void Promise.all([coach.db.getMemories(), coach.db.getLatestSummary()]).then(([items, summary]) =>
      setMemory({ count: items.length, summary: summary?.created_at ?? null }),
    );
    void coach.db.getInjuries().then(setInjuries);
  }, [coach, revision]);

  // 改了就存（規格 12.30 第 1 點）：一次存一個欄位，存好有小提示
  async function save(updates: Form) {
    const changed = Object.entries(updates).filter(([key, value]) => value.trim() !== (latest.current.saved[key] ?? ""));
    if (!changed.length) return;
    try {
      for (const [key, raw] of changed) {
        const value = raw.trim();
        if (value) await coach.db.setProfileKey(key, value);
        else await coach.db.deleteProfileKey(key);
      }
      setSaved((s) => {
        const next = { ...s };
        for (const [key, raw] of changed) {
          if (raw.trim()) next[key] = raw.trim();
          else delete next[key];
        }
        return next;
      });
      setError(null);
      toast("已儲存");
      touch();
    } catch (e) {
      setError(errorText(e));
    }
  }
  const setField: SetField = (key, value, commit = false) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (commit) void save({ [key]: value });
  };
  const commit: Commit = (key) => void save({ [key]: latest.current.form[key] ?? "" });
  const fieldProps = { form, setField, commit };

  const back = () => setPage(page === "run" || page === "ride" ? "training" : null);
  const openImport = (from: Page | null) => {
    setImportFrom(from);
    setPage("import");
  };
  const errorLine = error && <p className="field-error">{error}</p>;

  if (page === "values") {
    return (
      <Subpage page={page} back={back} backLabel="選手">
        <TrainingValuesCard />
      </Subpage>
    );
  }
  if (page === "import") {
    const backTo = () => setPage(importFrom);
    return (
      <Subpage page={page} back={backTo} backLabel={importFrom ? TITLES[importFrom] : "選手"}>
        <ImportFromAi startOpen onClose={backTo} />
      </Subpage>
    );
  }
  if (page === "goal" || page === "pb" || page === "body") {
    const fields = { goal: GOAL_FIELDS, pb: PB_FIELDS, body: BODY_FIELDS }[page];
    return (
      <Subpage page={page} back={back} backLabel="選手">
        {/* 身體：最上面是傷病紀錄（規格 12.33） */}
        {page === "body" && <InjuriesCard />}
        <section className="card">
          <ImportButton onClick={() => openImport(page)} />
          <Fields fields={fields} {...fieldProps} />
          {errorLine}
        </section>
      </Subpage>
    );
  }
  if (page === "run" || page === "ride") {
    return (
      <Subpage page={page} back={back} backLabel="練什麼、怎麼練">
        <section className="card">
          <Fields fields={SPORT_FIELDS[page]} {...fieldProps} />
          {errorLine}
        </section>
      </Subpage>
    );
  }
  if (page === "training") {
    return (
      <Subpage page={page} back={back} backLabel="選手">
        <section className="card">
          <p className="field-note">教練依這些排課表；沒填的，教練排課前會先問。</p>
          {multisport ? <MultisportPreferences {...fieldProps} open={setPage} /> : <Fields fields={RUN_PREFERENCES} {...fieldProps} />}
          <Disclosure summary="更多：節奏、偏好時段、其他活動" className="profile-more">
            <Fields fields={multisport ? COMMON_FIELDS_MORE : RUN_PREFERENCES_MORE} {...fieldProps} />
          </Disclosure>
          {errorLine}
        </section>
      </Subpage>
    );
  }
  if (page === "memory") {
    return (
      <Subpage page={page} back={back} backLabel="選手">
        <MemoriesCard />
        <ConversationSummaryCard />
      </Subpage>
    );
  }

  // 第一層：我的數字＋五列，右邊是摘要（沒填的寫「還沒填」）
  const sports = form.pref_sports ? athleteSports(form) : [];
  const summaries: Record<string, string> = {
    goal: join([saved.goal_long_term, saved.weekly_km_target && `每週 ${saved.weekly_km_target} km`]),
    training: multisport
      ? join([
          sports.map((s) => SPORT_LABELS[s]).join("、"),
          saved.pref_primary_sport && `主要${SPORT_LABELS[saved.pref_primary_sport as Sport] ?? saved.pref_primary_sport}`,
          saved.pref_days_per_week && `每週 ${saved.pref_days_per_week} 天`,
        ])
      : join([
          optionText(PREFERENCE_OPTIONS.pref_goal, saved.pref_goal),
          optionText(PREFERENCE_OPTIONS.pref_intensity, saved.pref_intensity),
          saved.pref_runs_per_week && `每週 ${saved.pref_runs_per_week} 次`,
        ]),
    pb: join(PB_FIELDS.map((f) => saved[f.key] && `${f.label} ${saved[f.key]}`)),
    body: join([
      injuries.length > 0 && injuries.map((i) => `${injuryName(i)}${INJURY_STATUS_LABELS[i.status]}`).join("、"),
      saved.max_hr && `最大心率 ${saved.max_hr}`,
      saved.injuries,
      !saved.max_hr && !saved.injuries && BODY_FIELDS.some((f) => saved[f.key]) && `已填 ${BODY_FIELDS.filter((f) => saved[f.key]).length} 項`,
    ]),
    memory: join([memory.count > 0 && `${memory.count} 則`, memory.summary && `對話摘要 ${new Date(memory.summary).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" })}`]),
  };
  return (
    <>
      <MyNumbers open={() => setPage("values")} />
      <section className="card settings-list profile-list">
        <div className="profile-list-head">
          <h2>你填的資料</h2>
          <ImportButton onClick={() => openImport(null)} />
        </div>
        <ul className="rows">
          {ROWS.map((row) => (
            <li key={row.id}>
              <ListRow
                icon={<Icon as={row.icon} />}
                title={row.title}
                sub={summaries[row.id] || <span className="not-filled">還沒填</span>}
                chevron
                label={row.title}
                onClick={() => setPage(row.id)}
              />
            </li>
          ))}
        </ul>
        {errorLine}
      </section>
    </>
  );
}

/**
 * 多運動的「練什麼、怎麼練」（規格 12.26 第 4 點、12.30）：練哪些運動、主要運動、共通的設定，每項運動再一層.
 * 沒選練哪些運動時當成只跑步（舊的資料）：跑步那一列照樣出現
 */
function MultisportPreferences({ form, setField, commit, open }: { form: Form; setField: SetField; commit: Commit; open: (page: Page) => void }) {
  const picked = form.pref_sports ? athleteSports(form) : [];
  const sports = picked.length ? picked : (["run"] as Sport[]);
  const toggle = (sport: Sport) => {
    const next = picked.includes(sport) ? picked.filter((s) => s !== sport) : [...picked, sport];
    setField("pref_sports", SPORT_CHOICES.filter((s) => next.includes(s)).join(","), true);
    // 主要運動不在練的運動裡了就清掉
    if (form.pref_primary_sport && !next.includes(form.pref_primary_sport as Sport)) setField("pref_primary_sport", "", true);
  };
  const primaryChoices = Object.fromEntries(Object.entries(PREFERENCE_OPTIONS.pref_primary_sport).filter(([s]) => sports.includes(s as Sport)));
  const sportSub = (sport: "run" | "ride") =>
    join(SPORT_FIELDS[sport].map((f) => (f.options ? optionText(f.options, form[f.key]) : form[f.key] && `${f.label.replace(/^(跑步|騎車)的?/, "")} ${form[f.key]}`)));
  return (
    <>
      <fieldset className="wide sports-picker">
        <legend>練哪些運動（可複選）</legend>
        <div className="row">
          {SPORT_CHOICES.map((sport) => (
            <label key={sport} className="check">
              <input type="checkbox" checked={picked.includes(sport)} onChange={() => toggle(sport)} />
              {SPORT_LABELS[sport]}
            </label>
          ))}
        </div>
        <p className="field-note">沒選的話當成只跑步；只選騎車也可以。</p>
      </fieldset>
      <div className="grid">
        {Object.keys(primaryChoices).length > 1 && (
          <FieldInput
            field={{ key: "pref_primary_sport", label: "主要運動", options: primaryChoices, emptyLabel: "不選（依各項的設定）", wide: true }}
            form={form}
            setField={setField}
            commit={commit}
          />
        )}
        {COMMON_FIELDS.map((field) => (
          <FieldInput key={field.key} field={field} form={form} setField={setField} commit={commit} />
        ))}
      </div>
      {Object.keys(primaryChoices).length > 1 && <p className="field-note">主要運動拿大部分的時間與強度課；賽事快到時，那項會暫時變成主要。</p>}
      <ul className="rows sport-rows">
        {(["run", "ride"] as const)
          .filter((sport) => sports.includes(sport))
          .map((sport) => (
            <li key={sport}>
              <ListRow
                icon={<SportIcon sport={sport} />}
                title={SPORT_LABELS[sport]}
                sub={sportSub(sport) || <span className="not-filled">還沒填</span>}
                chevron
                label={SPORT_LABELS[sport]}
                onClick={() => open(sport)}
              />
            </li>
          ))}
      </ul>
      {picked
        .filter((sport) => sport !== "run" && sport !== "ride")
        .map((sport) => (
          <label key={sport} className="wide">
            {SPORT_LABELS[sport]}的目標
            <input
              value={form[sportGoalKey(sport)] ?? ""}
              placeholder={GOAL_PLACEHOLDERS[sport]}
              onChange={(e) => setField(sportGoalKey(sport), e.target.value)}
              onBlur={() => commit(sportGoalKey(sport))}
            />
          </label>
        ))}
    </>
  );
}
