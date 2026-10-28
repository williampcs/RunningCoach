import { useEffect, useMemo, useState } from "react";

import { appGuide } from "@running-coach/core";

import { FEATURES_ON } from "../environment";
import { Markdown } from "../Markdown";
import { PrivacyLink } from "./PrivacyLink";

/** 使用說明（規格 12.12）：和教練查的是同一份；可以搜尋，從教練回覆的連結打開時捲到那一段 */
export function HelpView({ topic }: { topic: { id: string } | null }) {
  // 開關關著的功能的段落不列（規格 12.25）
  const sections = useMemo(() => appGuide("web", FEATURES_ON), []);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return sections;
    return sections.filter((s) => {
      const text = [s.title, ...s.keywords, s.body].join(" ").toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [query, sections]);

  useEffect(() => {
    if (!topic?.id) return;
    setQuery("");
    requestAnimationFrame(() => document.getElementById(`help-${topic.id}`)?.scrollIntoView({ block: "start" }));
  }, [topic]);

  return (
    <div className="stack">
      {/* 標題在面板的標題列 */}
      <section className="card">
        <p className="small muted">
          每個分頁與按鈕的用途。也可以直接問教練，例如“多裝置同步怎麼用？”。資料存在哪裡、會送到哪裡見 <PrivacyLink />。
        </p>
        <input type="search" value={query} placeholder="搜尋，例如：同步、密碼鎖、課表" aria-label="搜尋使用說明" onChange={(e) => setQuery(e.target.value)} />
        <ul className="help-toc">
          {shown.map((s) => (
            <li key={s.id}>
              <button onClick={() => document.getElementById(`help-${s.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}>{s.title}</button>
            </li>
          ))}
        </ul>
        {shown.length === 0 && <p className="muted small">找不到相關的說明，試試別的字，或直接問教練。</p>}
      </section>
      {shown.map((s) => (
        <section key={s.id} id={`help-${s.id}`} className={`card help-section${topic?.id === s.id ? " target" : ""}`}>
          <h2>{s.title}</h2>
          <Markdown>{s.body}</Markdown>
        </section>
      ))}
    </div>
  );
}
