import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Coach, IntervalsClient, localDate, type LlmProvider } from "@running-coach/core";

import { AppContext, errorText, type AppState, type Tab } from "./app-context";
import { openBrowserDb, type BrowserDb } from "./db/driver";
import { buildProvider, llmProblem, loadSettings, resolvedModels, saveSettings, type AppSettings } from "./settings";
import { ChatView } from "./views/Chat";
import { PlanView } from "./views/Plan";
import { ProfileView } from "./views/Profile";
import { ReportView } from "./views/Report";
import { SettingsView } from "./views/Settings";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "chat", label: "對話", icon: "💬" },
  { id: "report", label: "跑後回報", icon: "🏃" },
  { id: "plan", label: "計畫與賽事", icon: "📅" },
  { id: "profile", label: "選手資料", icon: "👤" },
  { id: "settings", label: "設定", icon: "⚙️" },
];

/** LLM 尚未設定時的替身：資料頁照常可用，需要模型的動作會得到明確的錯誤 */
function unconfiguredProvider(problem: string): LlmProvider {
  return {
    effortFor: () => null,
    startChat: () => ({
      next: async () => {
        throw new Error(`${problem}，請先到「設定」完成。`);
      },
    }),
  };
}

function buildCoach(db: BrowserDb, settings: AppSettings, problem: string | null): Coach {
  return new Coach({
    driver: db,
    llm: {
      provider: problem ? unconfiguredProvider(problem) : buildProvider(settings),
      models: resolvedModels(settings),
      chatEffort: settings.chatEffort,
    },
    activities: new IntervalsClient({
      apiKey: settings.intervals.apiKey.trim(),
      athleteId: settings.intervals.athleteId.trim(),
      today: () => localDate(new Date(), settings.timeZone),
      baseUrl: import.meta.env.VITE_INTERVALS_BASE_URL,
    }),
    settings: { timeZone: settings.timeZone },
    logger: { info: () => undefined, warn: (m) => console.warn(m), error: (m) => console.error(m) },
  });
}

export function App() {
  const [db, setDb] = useState<BrowserDb | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const [tab, setTab] = useState<Tab>("chat");
  const [revision, setRevision] = useState(0);
  const [outbox, setOutbox] = useState<string | null>(null);
  const opening = useRef(false);

  const problem = llmProblem(settings);
  const coach = useMemo(() => (db ? buildCoach(db, settings, problem) : null), [db, settings, problem]);

  useEffect(() => {
    // StrictMode 在開發時會執行兩次 effect；OPFS 的檔案一次只能由一條連線開啟
    if (opening.current) return;
    opening.current = true;
    (async () => {
      const opened = await openBrowserDb();
      await buildCoach(opened, loadSettings(), "初始化").init();
      setDb(opened);
    })().catch((e) => setFatal(errorText(e)));
  }, []);

  const touch = useCallback(() => setRevision((r) => r + 1), []);

  const state = useMemo<AppState | null>(() => {
    if (!db || !coach) return null;
    return {
      coach,
      db,
      settings,
      llmProblem: problem,
      revision,
      touch,
      updateSettings(next) {
        saveSettings(next);
        setSettings(next);
      },
      async reload() {
        await coach.init();
        touch();
      },
      goTo(next, draft) {
        if (draft) setOutbox(draft);
        setTab(next);
      },
    };
  }, [db, coach, settings, problem, revision, touch]);

  if (fatal) {
    return (
      <main className="page">
        <div className="notice error">無法開啟本機資料庫：{fatal}</div>
      </main>
    );
  }
  if (!state) return <main className="page muted">載入中…</main>;

  return (
    <AppContext.Provider value={state}>
      <div className="shell">
        <header className="topbar">
          <h1>Running Coach</h1>
          <span className="muted small">{TABS.find((t) => t.id === tab)?.label}</span>
        </header>
        {!state.db.persistent && (
          <div className="notice warn">
            目前無法使用瀏覽器的持久儲存，資料只會留在這個分頁，關閉後就會消失。常見原因：無痕視窗，或本站已在另一個分頁開啟。
          </div>
        )}
        <main className={tab === "chat" ? "page chat-page" : "page"}>
          {tab === "chat" && <ChatView outbox={outbox} onOutboxSent={() => setOutbox(null)} />}
          {tab === "report" && <ReportView />}
          {tab === "plan" && <PlanView />}
          {tab === "profile" && <ProfileView />}
          {tab === "settings" && <SettingsView />}
        </main>
        <nav className="tabbar" aria-label="主要分頁">
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? "active" : ""} aria-current={t.id === tab} onClick={() => setTab(t.id)}>
              <span aria-hidden="true">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
      </div>
    </AppContext.Provider>
  );
}
