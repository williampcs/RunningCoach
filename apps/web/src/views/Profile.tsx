import { useEffect, useState } from "react";

import { errorText, useApp } from "../app-context";

const GROUPS: { title: string; fields: { key: string; label: string; placeholder?: string; wide?: boolean }[] }[] = [
  {
    title: "目標與狀況",
    fields: [
      { key: "goal_long_term", label: "長期目標", placeholder: "例如：全馬破四", wide: true },
      { key: "weekly_km_target", label: "每週目標里程（km）", placeholder: "40" },
      { key: "injuries", label: "傷病注意", placeholder: "例如：右膝舊傷", wide: true },
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
    fields: [
      { key: "pref_long_run_day", label: "長跑日", placeholder: "週日" },
      { key: "pref_rest_days", label: "休息日", placeholder: "週一、週五" },
      { key: "pref_train_time", label: "偏好時段", placeholder: "清晨" },
    ],
  },
];

export function ProfileView() {
  const { coach, revision, touch } = useApp();
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    void coach.db.getProfile().then((profile) => {
      setSaved(profile);
      setForm(profile);
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
          <div className="grid">
            {group.fields.map((field) => (
              <label key={field.key} className={field.wide ? "wide" : ""}>
                {field.label}
                <input
                  value={form[field.key] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                />
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
  );
}
