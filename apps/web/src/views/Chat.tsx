import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  formatTokenFooter,
  MEMORY_MAX_CHARS,
  messageTimeLabel,
  REPLY_EXCERPT_CHARS,
  splitReplySections,
  type ChatEvent,
  type ConversationRow,
  type ReplyRef,
} from "@running-coach/core";

import { Archive, X } from "lucide-react";

import { errorText, useApp } from "../app-context";
import { Disclosure, EmojiText, Icon } from "../ui";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { TermsShort } from "./TermsLink";
import { checkRedFlags } from "../red-flag-alert";
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
  edit_planned_session: "修改一堂課",
  add_race: "新增賽事",
  list_races: "查看賽事",
  get_race_activity: "查比賽當天的手錶紀錄",
  update_race: "更新賽事",
  mark_race_not_started: "記下沒有出賽",
  record_race_result: "記錄比賽成績",
  update_athlete_profile: "更新選手資料",
  search_conversations: "查較早的對話",
  get_app_help: "查使用說明",
  get_weather: "查天氣預報",
  remember: "記下要記住的事",
  forget: "刪掉記住的事",
};

/** 一次讀幾則；往上捲到頂時再讀這麼多 */
const PAGE = 20;

/** 訊息的純文字（去掉 Markdown 的符號），回覆與記住時預填用 */
function plainText(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    // 表格的分隔列
    .replace(/:?-{3,}:?/g, " ")
    .replace(/[*_`>#|]/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** 小標裡的 Markdown 符號（粗體、程式碼）去掉，收起的那一列只寫字 */
const headingText = (title: string) => title.replace(/(\*\*|__|`)/g, "");

/** 哪些段落打開：each 是選手點過的，all 是按過「全部展開／收起」之後沒點過的段落的預設 */
interface ReplyOpen {
  all: boolean | null;
  each: Record<number, boolean>;
}

/**
 * 教練的回覆（規格 12.30 第 2 點）：有小標（##）時，第一個小標之前的結論一直顯示，每個小標收成一列，加「全部展開」；
 * 沒有小標的照舊整段.
 * 邊寫邊收：串流中（streaming）也是同一個樣子，結論逐字出現，每個小標一出現就是收起的一列，正在寫的那列標「寫作中」；
 * 選手可以在串流中點開，裡面照樣逐字出現。寫完時由 initial 接著用串流中的打開狀態，畫面不跳
 */
function CoachReply({
  content,
  streaming = false,
  initial,
  onOpenChange,
}: {
  content: string;
  streaming?: boolean;
  initial?: ReplyOpen;
  onOpenChange?: (open: ReplyOpen) => void;
}) {
  // 串流中最後一行還只是「#」「##」時先不顯示，等它成為小標，免得結論後面閃一下井字號
  const text = streaming ? content.replace(/\n? {0,3}#{1,6}[ \t]*$/, "") : content;
  const { lead, sections } = useMemo(() => splitReplySections(text), [text]);
  const [open, setOpenState] = useState<ReplyOpen>(() => initial ?? { all: null, each: {} });
  const setOpen = (next: ReplyOpen) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  if (!sections.length) return <Markdown>{text}</Markdown>;
  // 沒有結論（一開始就是小標）時打開第一段，不讓整則回覆只剩幾個標題
  const isOpen = (i: number) => open.each[i] ?? open.all ?? (i === 0 && !lead);
  const allOpen = sections.every((_, i) => isOpen(i));
  return (
    <div className="coach-reply">
      {lead && <Markdown>{lead}</Markdown>}
      <div className="reply-sections">
        {sections.map((s, i) => (
          <Disclosure
            key={i}
            summary={
              <>
                {headingText(s.title)}
                {streaming && i === sections.length - 1 && <span className="reply-writing">寫作中</span>}
              </>
            }
            className="reply-section"
            open={isOpen(i)}
            onToggle={(now) => now !== isOpen(i) && setOpen({ ...open, each: { ...open.each, [i]: now } })}
          >
            <Markdown>{s.body}</Markdown>
          </Disclosure>
        ))}
      </div>
      {sections.length > 1 && (
        <button type="button" className="text reply-toggle-all" onClick={() => setOpen({ all: !allOpen, each: {} })}>
          {allOpen ? "全部收起" : "全部展開"}
        </button>
      )}
    </div>
  );
}

const excerpt = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

export function ChatView({ outbox, onOutboxSent }: { outbox: string | null; onOutboxSent: () => void }) {
  const { coach, llmProblem, revision, touch, openSettings, toast } = useApp();
  const [messages, setMessages] = useState<ConversationRow[]>([]);
  // 畫面上要顯示幾則（往上捲時增加）、更早的還有沒有
  const [limit, setLimit] = useState(PAGE);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  // 正在「記住」的那一則與預填的文字
  const [remembering, setRemembering] = useState<{ id: number; text: string } | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  // 讀了更早的對話之後維持畫面位置，不捲到最下面
  const keepFromBottom = useRef<number | null>(null);
  // 送出幾次：教練動態據此在開始對話後收成一行
  const [sentCount, setSentCount] = useState(0);
  const [hasSummary, setHasSummary] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  // 送出中的那則回覆的是哪一則：存好之前也要顯示引用
  const [sendingReply, setSendingReply] = useState<ReplyRef | null>(null);
  // 送出當下最後一則訊息的 id，用來判斷送出中的訊息是否已出現在讀回的對話裡
  const [baseId, setBaseId] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [footer, setFooter] = useState("");
  // 串流中的回覆：draft 是這次模型呼叫目前為止的文字，tool 是正在執行的工具
  const [draft, setDraft] = useState("");
  const [tool, setTool] = useState<string | null>(null);
  const draftText = useRef("");
  // 串流中的回覆哪些段落打開（存好後的那一則接著用）
  const draftOpen = useRef<ReplyOpen>({ all: null, each: {} });
  // 這次送出的第幾次模型呼叫：換一次就是新的一段文字（串流中的回覆重新開始）
  const [draftRound, setDraftRound] = useState(0);
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
        draftOpen.current = { all: null, each: {} };
        setDraftRound((n) => n + 1);
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
    // 多讀一則，知道更早的還有沒有
    const rows = await coach.db.getConversationPage(limit + 1);
    setHasOlder(rows.length > limit);
    setMessages(rows.slice(-limit));
    setHasSummary((await coach.db.getLatestSummary()) !== null);
  }, [coach, limit]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const loadOlder = useCallback(() => {
    if (loadingOlder || !hasOlder) return;
    const el = list.current;
    keepFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    setLoadingOlder(true);
    setLimit((n) => n + PAGE);
  }, [loadingOlder, hasOlder]);

  // 捲到最上面附近時讀更早的
  useEffect(() => {
    const target = top.current;
    if (!target || !hasOlder) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadOlder(), {
      root: list.current,
      rootMargin: "200px 0px 0px 0px",
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasOlder, loadOlder]);

  // 讀了更早的：維持原本看到的位置
  useLayoutEffect(() => {
    const el = list.current;
    if (keepFromBottom.current === null || !el) return;
    el.scrollTop = el.scrollHeight - keepFromBottom.current;
    keepFromBottom.current = null;
    setLoadingOlder(false);
  }, [messages]);

  // 有對話時捲到最新一則；還沒有對話時停在頂端，新手引導才看得到
  useEffect(() => {
    if (loadingOlder) return;
    if (messages.length > 0 || sending !== null) bottom.current?.scrollIntoView({ block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sending, error, draft, tool]);

  const send = useCallback(
    async (text: string, reply: ReplyRef | null = null) => {
      const content = text.trim();
      if (!content || busy.current) return;
      busy.current = true;
      // 有紅旗的字詞（胸痛、昏倒…）時，畫面上直接出現就醫提示，不等教練回覆（規格 12.33）
      checkRedFlags(content);
      // 這次的兩則（訊息與回覆）也要留在畫面上
      setLimit((n) => n + 2);
      setSentCount((n) => n + 1);
      // 從資料庫讀：其他分頁交辦的訊息在剛切到對話頁時就送出，這時對話可能還沒讀進來
      setBaseId((await coach.db.getRecentConversations(1)).at(-1)?.id ?? 0);
      draftOpen.current = { all: null, each: {} };
      setSending(content);
      setSendingReply(reply);
      setError(null);
      setFooter("");
      try {
        const { stats } = await coach.chat(content, onEvent, { replyTo: reply });
        setFooter(formatTokenFooter(stats));
      } catch (e) {
        setError(errorText(e));
      } finally {
        await load();
        busy.current = false;
        clearDraft();
        setSending(null);
        setSendingReply(null);
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

  function startReply(m: ConversationRow) {
    setReplyTo({ role: m.role, timestamp: m.timestamp ?? "", text: plainText(m.content).slice(0, REPLY_EXCERPT_CHARS) });
    document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  }

  async function saveMemory() {
    if (!remembering) return;
    try {
      await coach.db.addMemory(remembering.text, "user");
      setRemembering(null);
      setNotice(null);
      toast("已記住。可以在「選手」頁查看與修改。");
      touch();
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
    }
  }

  /** 點回覆裡的引用：捲到那一則（在畫面上的話） */
  function jumpTo(reply: ReplyRef) {
    const target = messages.find((m) => m.timestamp === reply.timestamp && m.role === reply.role);
    if (target) document.getElementById(`msg-${target.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  const quote = (reply: ReplyRef, onClick?: () => void) => {
    const body = (
      <>
        <span className="quote-who">回覆{reply.role === "user" ? "自己" : "教練"}</span>
        {excerpt(reply.text, 60)}
      </>
    );
    return onClick ? (
      <button type="button" className="quote" onClick={onClick}>
        {body}
      </button>
    ) : (
      <span className="quote">{body}</span>
    );
  };

  // 訊息下方的時間：依設定的時區；沒有時間的舊訊息不顯示
  const clock = coach.currentTime();
  const timeOf = (m: ConversationRow) => messageTimeLabel(m.timestamp, clock, coach.settings.timeZone);

  // 已整理進摘要的最後一則：在它後面畫分隔線
  const lastArchived = messages.reduce((at, m, i) => (m.archived ? i : at), -1);

  return (
    <>
      <CoachFeed collapseSignal={sentCount} />
      <div className="messages" ref={list}>
        {/* 讀更早的對話的觸發點放在最上面：新手引導比畫面還高時（手機上），捲到最上面也要觸發得到 */}
        <div ref={top} />
        <GettingStarted />
        {hasOlder && (
          <button className="text" disabled={loadingOlder} onClick={loadOlder}>
            {loadingOlder ? "讀取中…" : "載入更早的對話"}
          </button>
        )}
        {!hasOlder && hasSummary && lastArchived < 0 && <div className="muted small center">較早的對話已整理成摘要，教練仍記得重點。</div>}
        {messages.length === 0 && sending === null && (
          <div className="empty">
            <p>跟教練說說你的目標、最近的訓練，或直接問問題。</p>
            <p className="muted small">例如：「我想在明年三月完成第一場半馬，目前一週跑三次。」</p>
          </div>
        )}
        {messages.map((m, i) => (
          <Fragment key={m.id}>
            <div id={`msg-${m.id}`} className={`msg ${m.role}${m.archived ? " archived" : ""}`}>
              {m.reply_to && quote(m.reply_to, () => jumpTo(m.reply_to!))}
              <div className={`bubble ${m.role}`}>
                {m.role === "assistant" ? (
                  // 這次的回覆剛存好：接著用串流中的打開狀態（邊寫邊收，寫完畫面不跳）
                  <CoachReply content={m.content} initial={sending !== null && m.id > baseId ? draftOpen.current : undefined} />
                ) : (
                  m.content
                )}
                {m.sources?.length ? <p className="sources">參考了：{m.sources.join("、")}</p> : null}
              </div>
              <div className="msg-meta">
                {timeOf(m) && (
                  <time className="msg-time" dateTime={m.timestamp ?? undefined}>
                    {timeOf(m)}
                  </time>
                )}
                {remembering?.id !== m.id && (
                  <span className="msg-actions">
                    <button className="link small" onClick={() => startReply(m)} disabled={sending !== null}>
                      回覆
                    </button>
                    <button
                      className="link small"
                      onClick={() => {
                        setNotice(null);
                        setRemembering({ id: m.id, text: plainText(m.content).slice(0, MEMORY_MAX_CHARS) });
                      }}
                    >
                      記住
                    </button>
                  </span>
                )}
              </div>
              {remembering?.id === m.id && (
                <form
                  className="remember-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (remembering.text.trim()) void saveMemory();
                  }}
                >
                  <label className="small">
                    要記住的事（改成一句話，{MEMORY_MAX_CHARS} 字以內）
                    <AutoGrowTextarea
                      enter="submit"
                      value={remembering.text}
                      maxLength={MEMORY_MAX_CHARS}
                      onChange={(e) => setRemembering({ id: m.id, text: e.target.value })}
                    />
                  </label>
                  <div className="row">
                    <button type="submit" className="primary" disabled={!remembering.text.trim()}>
                      記住
                    </button>
                    <button className="text" type="button" onClick={() => setRemembering(null)}>
                      取消
                    </button>
                  </div>
                </form>
              )}
            </div>
            {i === lastArchived && i < messages.length - 1 && (
              <div className="archived-divider" role="separator">
                <span>
                  <span>
                    <Icon as={Archive} size={16} /> 以上已整理成摘要
                  </span>
                  <span className="archived-sub">教練記得重點，也能查回原文</span>
                </span>
              </div>
            )}
          </Fragment>
        ))}
        {pendingShown && (
          <div className="msg user">
            {sendingReply && quote(sendingReply)}
            <div className="bubble user">{sending}</div>
          </div>
        )}
        {progressShown &&
          (draft ? (
            <div className="bubble assistant streaming">
              <CoachReply key={draftRound} content={draft} streaming initial={draftOpen.current} onOpenChange={(o) => (draftOpen.current = o)} />
            </div>
          ) : (
            <div className="bubble assistant muted">{tool ? `${TOOL_STATUS[tool] ?? "處理中"}…` : "教練思考中…"}</div>
          ))}
        {error && <div className="notice error">沒有收到回覆：{error}</div>}
        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
        {footer && sending === null && (
          <div className="muted small footer">
            <EmojiText text={footer} size={14} />
          </div>
        )}
        <div ref={bottom} />
      </div>
      {llmProblem ? (
        <div className="notice warn inline">
          <span>{llmProblem}，目前無法對話。</span>
          <button className="text" onClick={() => openSettings("ai")}>
            前往設定
          </button>
        </div>
      ) : (
        <form
          className={`composer${replyTo ? " replying" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            const text = input;
            const reply = replyTo;
            setInput("");
            setReplyTo(null);
            void send(text, reply);
          }}
        >
          {replyTo && (
            <div className="reply-bar">
              {quote(replyTo)}
              <button type="button" className="icon-button" aria-label="取消回覆" title="取消回覆" onClick={() => setReplyTo(null)}>
                <Icon as={X} />
              </button>
            </div>
          )}
          {/* Enter 送出、Shift+Enter 換行，輸入法選字時不送出；平常一行高，打字時長高到 6 行 */}
          <AutoGrowTextarea enter="send" value={input} placeholder="輸入訊息…" aria-label="訊息" onChange={(e) => setInput(e.target.value)} />
          <button type="submit" className="primary" disabled={sending !== null || !input.trim()}>
            送出
          </button>
        </form>
      )}
      {/* 精簡版的使用須知一直顯示在輸入框下方（規格 12.32） */}
      <TermsShort />
    </>
  );
}
