import { useCallback, useEffect, useRef, useState } from "react";

import { formatTokenFooter, type ConversationRow } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { Markdown } from "../Markdown";

export function ChatView({ outbox, onOutboxSent }: { outbox: string | null; onOutboxSent: () => void }) {
  const { coach, llmProblem, revision, touch, goTo } = useApp();
  const [messages, setMessages] = useState<ConversationRow[]>([]);
  const [hasSummary, setHasSummary] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  // 送出當下最後一則訊息的 id，用來判斷送出中的訊息是否已出現在讀回的對話裡
  const [baseId, setBaseId] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [footer, setFooter] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  // 以 ref 同步判斷是否送出中：state 要到下次 render 才更新，擋不住同一輪內的重複觸發
  const busy = useRef(false);

  const load = useCallback(async () => {
    setMessages(await coach.db.getRecentConversations(200));
    setHasSummary((await coach.db.getLatestSummary()) !== null);
  }, [coach]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, sending, error]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy.current) return;
      busy.current = true;
      setBaseId(messages.at(-1)?.id ?? 0);
      setSending(content);
      setError(null);
      setFooter("");
      try {
        const { stats } = await coach.chat(content);
        setFooter(formatTokenFooter(stats));
      } catch (e) {
        setError(errorText(e));
      } finally {
        await load();
        busy.current = false;
        setSending(null);
        // 模型執行工具時可能改了賽事、計畫或選手資料
        touch();
      }
    },
    [coach, touch, load, messages],
  );

  // 其他分頁交辦的訊息（例如跑後回報的「請教練分析」）
  useEffect(() => {
    if (!outbox || busy.current) return;
    onOutboxSent();
    void send(outbox);
  }, [outbox, send, onOutboxSent]);

  // 送出中的訊息已寫入資料庫；讀回的對話裡已經有它時就不必另外顯示
  const pendingShown = sending !== null && !messages.some((m) => m.id > baseId);

  return (
    <>
      <div className="messages">
        {hasSummary && <div className="muted small center">較早的對話已整理成摘要，教練仍記得重點。</div>}
        {messages.length === 0 && sending === null && (
          <div className="empty">
            <p>跟教練說說你的目標、最近的訓練，或直接問問題。</p>
            <p className="muted small">例如：「我想在明年三月完成第一場半馬，目前一週跑三次。」</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.role === "assistant" ? <Markdown>{m.content}</Markdown> : m.content}
          </div>
        ))}
        {pendingShown && <div className="bubble user">{sending}</div>}
        {sending !== null && <div className="bubble assistant muted">教練思考中…</div>}
        {error && <div className="notice error">沒有收到回覆：{error}</div>}
        {footer && sending === null && <div className="muted small footer">{footer}</div>}
        <div ref={bottom} />
      </div>
      {llmProblem ? (
        <div className="notice warn">
          {llmProblem}，目前無法對話。
          <button className="link" onClick={() => goTo("settings")}>
            前往設定
          </button>
        </div>
      ) : (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            const text = input;
            setInput("");
            void send(text);
          }}
        >
          <textarea
            value={input}
            rows={2}
            placeholder="輸入訊息…"
            aria-label="訊息"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 輸入法選字時的 Enter 不送出
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button type="submit" className="primary" disabled={sending !== null || !input.trim()}>
            送出
          </button>
        </form>
      )}
    </>
  );
}
