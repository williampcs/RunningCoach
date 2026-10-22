import { useCallback, useEffect, useRef, useState } from "react";

import { formatTokenFooter, type ChatEvent, type ConversationRow } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { Markdown } from "../Markdown";
import { CoachFeed } from "./CoachFeed";
import { GettingStarted } from "./GettingStarted";

// 執行工具時顯示的狀態
const TOOL_STATUS: Record<string, string> = {
  fetch_latest_activity: "讀取最新的跑步活動",
  save_workout: "儲存訓練並產生分析",
  save_pending_subjective: "暫存跑後感受",
  get_recent_workouts: "查看最近的訓練",
  get_pace_trend: "計算配速趨勢",
  get_training_plan: "查看訓練計畫",
  get_training_values: "計算訓練數值",
  get_full_message: "讀取較早的完整訊息",
  get_recovery_status: "查看恢復狀況",
  save_daily_checkin: "記錄今天的身體狀況",
  save_training_plan: "檢查並儲存課表",
  update_planned_session: "調整課表",
  add_race: "新增賽事",
  get_upcoming_races: "查看近期賽事",
  update_race: "更新賽事",
  cancel_race: "取消賽事",
  update_race_result: "記錄比賽成績",
  update_athlete_profile: "更新選手資料",
};

export function ChatView({ outbox, onOutboxSent }: { outbox: string | null; onOutboxSent: () => void }) {
  const { coach, llmProblem, revision, touch, goTo } = useApp();
  const [messages, setMessages] = useState<ConversationRow[]>([]);
  // 送出幾次：教練動態據此在開始對話後收成一行
  const [sentCount, setSentCount] = useState(0);
  const [hasSummary, setHasSummary] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  // 送出當下最後一則訊息的 id，用來判斷送出中的訊息是否已出現在讀回的對話裡
  const [baseId, setBaseId] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [footer, setFooter] = useState("");
  // 串流中的回覆：draft 是這次模型呼叫目前為止的文字，tool 是正在執行的工具
  const [draft, setDraft] = useState("");
  const [tool, setTool] = useState<string | null>(null);
  const draftText = useRef("");
  const frame = useRef<number | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // 以 ref 同步判斷是否送出中：state 要到下次 render 才更新，擋不住同一輪內的重複觸發
  const busy = useRef(false);

  // 文字片段很密集，每個畫面更新一次就好
  const showDraft = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setDraft(draftText.current);
    });
  }, []);

  const onEvent = useCallback(
    (event: ChatEvent) => {
      if (event.type === "text") {
        draftText.current += event.text;
      } else {
        // 新的一次模型呼叫或開始執行工具：先前的文字不是最終回覆
        draftText.current = "";
        setTool(event.type === "tool" ? event.name : null);
      }
      showDraft();
    },
    [showDraft],
  );

  const clearDraft = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    draftText.current = "";
    setDraft("");
    setTool(null);
  }, []);

  const load = useCallback(async () => {
    setMessages(await coach.db.getRecentConversations(200));
    setHasSummary((await coach.db.getLatestSummary()) !== null);
  }, [coach]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  // 有對話時捲到最新一則；還沒有對話時停在頂端，新手引導才看得到
  useEffect(() => {
    if (messages.length > 0 || sending !== null) bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, sending, error, draft, tool]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy.current) return;
      busy.current = true;
      setSentCount((n) => n + 1);
      // 從資料庫讀：其他分頁交辦的訊息在剛切到對話頁時就送出，這時對話可能還沒讀進來
      setBaseId((await coach.db.getRecentConversations(1)).at(-1)?.id ?? 0);
      setSending(content);
      setError(null);
      setFooter("");
      try {
        const { stats } = await coach.chat(content, onEvent);
        setFooter(formatTokenFooter(stats));
      } catch (e) {
        setError(errorText(e));
      } finally {
        await load();
        busy.current = false;
        clearDraft();
        setSending(null);
        // 模型執行工具時可能改了賽事、計畫或選手資料
        touch();
      }
    },
    [coach, touch, load, onEvent, clearDraft],
  );

  // 其他分頁交辦的訊息（例如跑後回報的「請教練分析」）
  useEffect(() => {
    if (!outbox || busy.current) return;
    onOutboxSent();
    void send(outbox);
  }, [outbox, send, onOutboxSent]);

  // 送出中的訊息已寫入資料庫；讀回的對話裡已經有它時就不必另外顯示
  const pendingShown = sending !== null && !messages.some((m) => m.id > baseId);
  // 讀回的對話裡已經有這次的回覆時，不再顯示串流中的版本
  const progressShown = sending !== null && !messages.some((m) => m.id > baseId && m.role === "assistant");

  return (
    <>
      <CoachFeed collapseSignal={sentCount} />
      <div className="messages">
        <GettingStarted />
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
            {m.sources?.length ? <p className="sources">參考了：{m.sources.join("、")}</p> : null}
          </div>
        ))}
        {pendingShown && <div className="bubble user">{sending}</div>}
        {progressShown &&
          (draft ? (
            <div className="bubble assistant streaming">
              <Markdown>{draft}</Markdown>
            </div>
          ) : (
            <div className="bubble assistant muted">{tool ? `${TOOL_STATUS[tool] ?? "處理中"}…` : "教練思考中…"}</div>
          ))}
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
