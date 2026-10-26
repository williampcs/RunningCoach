import { athleteSports, PREFERENCE_OPTIONS, REGION_CHOICES, SPORT_CHOICES, SPORT_LABELS, sportGoalKey, type Sport } from "@running-coach/core";
import { useEffect, useRef, useState } from "react";

import { errorText, useApp } from "../app-context";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { featureEnabled } from "../environment";
import { ConversationSummaryCard, MemoriesCard } from "./Memories";
import { ImportFromAi } from "./ImportFromAi";
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
  /** 會打長文字：自動長高（Enter 照舊儲存，不換行） */
  long?: boolean;
}

const GROUPS: { title: string; note?: string; fields: Field[] }[] = [
  {
    title: "目標與狀況",
    fields: [
      { key: "goal_long_term", label: "長期目標", placeholder: "例如：全馬破四", wide: true, long: true },
      { key: "weekly_km_target", label: "每週目標里程（km）", placeholder: "40" },
      { key: "injuries", label: "傷病注意", placeholder: "例如：右膝舊傷", wide: true, long: true },
      { key: "region", label: "紀錄頁的里程碑", options: REGION_CHOICES, emptyLabel: "通用（不依賴所在地）", wide: true },
    ],
  },
  {
    title: "個人最佳",
    fields: [
      { key: "pb_5k", label: "5km", placeholder: "22:40" },
      { key: "pb_10k", label: "10km", placeholder: "48:30" },
      { key: "pb_half", label: "半馬", placeholder: "1:52:10" },
      { key: "pb_full", label: "全馬", placeholder: "4:05:00" },
    ],
  },
  {
    title: "生理資料",
    fields: [
      { key: "gender", label: "性別" },
      { key: "birth_year", label: "出生年（西元）", placeholder: "1990" },
      { key: "height_cm", label: "身高（cm）" },
      { key: "weight_kg", label: "體重（kg）" },
      { key: "body_fat_pct", label: "體脂（%）" },
      { key: "max_hr", label: "最大心率（實測）", placeholder: "未填則以 220 − 年齡推算" },
      { key: "resting_hr", label: "靜息心率" },
    ],
  },
  {
    title: "訓練偏好",
    note: "教練依這些排課表；沒填的，教練排課前會先問。",
    fields: [
      { key: "pref_goal", label: "目標", options: PREFERENCE_OPTIONS.pref_goal, wide: true },
      { key: "pref_intensity", label: "強度", options: PREFERENCE_OPTIONS.pref_intensity, wide: true },
      { key: "pref_schedule", label: "節奏", options: PREFERENCE_OPTIONS.pref_schedule, wide: true },
      { key: "pref_runs_per_week", label: "每週最多幾次", placeholder: "4" },
      { key: "pref_max_minutes", label: "每次最多幾分鐘", placeholder: "60" },
      { key: "pref_other", label: "其他會做的運動", placeholder: "騎車、重訓", wide: true, long: true },
      { key: "pref_long_run_day", label: "長跑日", placeholder: "週日" },
      { key: "pref_rest_days", label: "休息日", placeholder: "週一、週五" },
      { key: "pref_train_time", label: "偏好時段", placeholder: "清晨" },
    ],
  },
];

/** 各運動的目標的提示（跑步的目標仍是上面的選單） */
const GOAL_PLACEHOLDERS: Partial<Record<Sport, string>> = {
  ride: "例如：週末一次 2 小時的長騎、通勤",
  swim: "例如：每週一次、恢復用",
  strength: "例如：每週兩次、預防受傷",
  other: "例如：瑜伽、爬山",
};

/**
 * 練哪些運動（可複選）與各自的目標（多運動的開關，規格 12.24）：存在 pref_sports 與 pref_goal_<運動>.
 * 沒選時當成只跑步（舊的資料）
 */
function SportsPicker({ form, setForm }: { form: Record<string, string>; setForm: (form: Record<string, string>) => void }) {
  const picked = form.pref_sports ? athleteSports(form) : [];
  const toggle = (sport: Sport) => {
    const next = picked.includes(sport) ? picked.filter((s) => s !== sport) : [...picked, sport];
    setForm({ ...form, pref_sports: SPORT_CHOICES.filter((s) => next.includes(s)).join(",") });
  };
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
        <p className="small muted">沒選的話，教練當成只跑步。選了騎車，教練會排單車的課；只選騎車也可以。</p>
      </fieldset>
      {picked
        .filter((sport) => sport !== "run")
        .map((sport) => (
          <label key={sport} className="wide">
            {SPORT_LABELS[sport]}的目標
            <input
              value={form[sportGoalKey(sport)] ?? ""}
              placeholder={GOAL_PLACEHOLDERS[sport]}
              onChange={(e) => setForm({ ...form, [sportGoalKey(sport)]: e.target.value })}
            />
          </label>
        ))}
    </>
  );
}

export function ProfileView() {
  const { coach, revision, touch } = useApp();
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // 重新讀取（例如別台同步過來）時，保留這裡改到一半、還沒儲存的欄位，其他的換成最新的
  const latest = useRef({ saved, form });
  latest.current = { saved, form };
  useEffect(() => {
    void coach.db.getProfile().then((profile) => {
      const { saved: before, form: editing } = latest.current;
      const edited = Object.fromEntries(Object.entries(editing).filter(([key, value]) => (value ?? "").trim() !== (before[key] ?? "")));
      setSaved(profile);
      setForm({ ...profile, ...edited });
    });
  }, [coach, revision]);

  const changed = [...new Set([...Object.keys(saved), ...Object.keys(form)])].filter(
    (key) => (form[key] ?? "").trim() !== (saved[key] ?? ""),
  );

  async function save() {
    try {
      for (const key of changed) {
        const value = (form[key] ?? "").trim();
        if (value) await coach.db.setProfileKey(key, value);
        else await coach.db.deleteProfileKey(key);
      }
      setMessage({ kind: "ok", text: "已儲存。這些資料只存在這台裝置，對話時會提供給教練。" });
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    }
  }

  return (
    <>
      <TrainingValuesCard />
      <ImportFromAi />
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {GROUPS.map((group) => (
          <section className="card" key={group.title}>
            <h2>{group.title}</h2>
            {group.note && <p className="small muted">{group.note}</p>}
            <div className="grid">
              {group.title === "訓練偏好" && featureEnabled("multisport") && <SportsPicker form={form} setForm={setForm} />}
              {group.fields.map((field) => (
                <label key={field.key} className={field.wide ? "wide" : ""}>
                  {field.label}
                  {field.options ? (
                    <select value={form[field.key] ?? ""} onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}>
                      <option value="">{field.emptyLabel ?? "未填"}</option>
                      {Object.entries(field.options).map(([value, text]) => (
                        <option key={value} value={value}>
                          {text}
                        </option>
                      ))}
                    </select>
                  ) : field.long ? (
                    <AutoGrowTextarea
                      enter="submit"
                      value={form[field.key] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                    />
                  ) : (
                    <input
                      value={form[field.key] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                    />
                  )}
                </label>
              ))}
            </div>
          </section>
        ))}
        {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
        <button type="submit" className="primary" disabled={changed.length === 0}>
          儲存選手資料
        </button>
      </form>
      <MemoriesCard />
      <ConversationSummaryCard />
    </>
  );
}
