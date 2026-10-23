import { useEffect, useState } from "react";

import { MEMORY_MAX_CHARS, MEMORY_MAX_ITEMS, type Memory } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { Markdown } from "../Markdown";

function dateText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
}

/** 記住的事（規格 12.11）：每次對話都帶給教練；選手與教練都能新增，這裡可以改、可以刪 */
export function MemoriesCard() {
  const { coach, revision, touch } = useApp();
  const [items, setItems] = useState<Memory[] | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    void coach.db.getMemories().then(setItems);
  }, [coach, revision]);

  async function act(fn: () => Promise<unknown>, ok: string | null = null) {
    try {
      await fn();
      setMessage(ok ? { kind: "ok", text: ok } : null);
      setItems(await coach.db.getMemories());
      touch();
      return true;
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
      return false;
    }
  }

  const full = (items?.length ?? 0) >= MEMORY_MAX_ITEMS;
  return (
    <section className="card memories">
      <h2>記住的事</h2>
      <p className="small muted">
        教練每次對話都會看到這裡的每一條。在對話裡按訊息下方的「記住」，或跟教練說「幫我記住…」都會加到這裡；教練自己記下的也會在回覆裡告訴你。最多{" "}
        {MEMORY_MAX_ITEMS} 條。
      </p>
      {items?.length === 0 && <p className="muted small">還沒有。例如：「週三晚上要接小孩，不能練」「鞋子跑到 600 公里要換」。</p>}
      <ul className="memory-list">
        {items?.map((m) => (
          <li key={m.id}>
            {editing?.id === m.id ? (
              <form
                className="memory-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(() => coach.db.updateMemory(m.id, editing.text)).then((ok) => ok && setEditing(null));
                }}
              >
                <textarea
                  rows={2}
                  value={editing.text}
                  maxLength={MEMORY_MAX_CHARS}
                  aria-label="修改記住的事"
                  onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                />
                <div className="row">
                  <button type="submit" className="primary" disabled={!editing.text.trim()}>
                    儲存
                  </button>
                  <button type="button" onClick={() => setEditing(null)}>
                    取消
                  </button>
                </div>
              </form>
            ) : (
              <>
                <span className="memory-text">{m.content}</span>
                <span className="memory-meta small muted">
                  {m.source === "coach" ? "教練記的" : "我記的"}・{dateText(m.updated_at)}
                </span>
                <span className="memory-actions">
                  <button className="link small" onClick={() => setEditing({ id: m.id, text: m.content })}>
                    修改
                  </button>
                  <button className="link small danger" onClick={() => confirm(`刪掉這一條？教練之後不會再看到：\n${m.content}`) && void act(() => coach.db.deleteMemory(m.id))}>
                    刪除
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="memory-add"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => coach.db.addMemory(draft, "user")).then((ok) => ok && setDraft(""));
        }}
      >
        <input
          value={draft}
          maxLength={MEMORY_MAX_CHARS}
          placeholder={full ? `已經有 ${MEMORY_MAX_ITEMS} 條，先刪掉或合併幾條` : "新增一條，例如：右腳踝扭過，下坡要小心"}
          aria-label="新增記住的事"
          disabled={full}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={full || !draft.trim()}>
          新增
        </button>
      </form>
      {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
    </section>
  );
}

/** 對話摘要（唯讀）：較早的對話整理成的重點，教練每次都會看到；下次整理時會改寫 */
export function ConversationSummaryCard() {
  const { coach, revision } = useApp();
  const [summary, setSummary] = useState<{ content: string; created_at: string } | null | undefined>(undefined);

  useEffect(() => {
    void coach.db.getLatestSummary().then(setSummary);
  }, [coach, revision]);

  return (
    <section className="card">
      <h2>對話摘要</h2>
      <p className="small muted">
        對話多了之後，較早的部分會整理成這段重點，教練每次都會看到；原文仍保留在對話頁。這段會在下次整理時改寫，要確定記得的事請用上面的「記住的事」。
      </p>
      {summary === null && <p className="muted small">還沒有。對話超過 20 則時會開始整理。</p>}
      {summary && (
        <>
          <div className="summary-text">
            <Markdown>{summary.content}</Markdown>
          </div>
          <p className="small muted">整理於 {new Date(summary.created_at).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
        </>
      )}
    </section>
  );
}
