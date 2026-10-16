import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Coach,
  FakeActivitySource,
  IntervalsClient,
  localDate,
  type CoachConfig,
  type LlmProvider,
  type Logger,
} from "@running-coach/core";

import { AppContext, errorText, type AppState, type Tab } from "./app-context";
import { openBrowserDb, type BrowserDb } from "./db/driver";
import { buildProvider, llmProblem, loadSettings, resolvedModels, saveSettings, type AppSettings } from "./settings";
import {
  clockOffsetMs,
  loadTestMode,
  saveTestMode,
  TEST_DB_FILE,
  testActivities,
  testWellness,
  type TestMode,
} from "./test-mode";
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

const logger: Logger = { info: () => undefined, warn: (m) => console.warn(m), error: (m) => console.error(m) };

// 測試模式可以模擬今天的日期：Coach 與活動來源都經由這個時鐘取得現在時間
let clockOffset = 0;
const now = () => new Date(Date.now() + clockOffset);

function coachConfig(settings: AppSettings, test: TestMode): CoachConfig {
  const problem = llmProblem(settings);
  const today = () => localDate(now(), settings.timeZone);
  return {
    llm: {
      provider: problem ? unconfiguredProvider(problem) : buildProvider(settings),
      models: resolvedModels(settings),
      chatEffort: settings.chatEffort,
    },
    // 測試模式只用假資料，完全不連線 Intervals.icu
    activities: test.enabled
      ? new FakeActivitySource(testActivities(test), today, testWellness(test))
      : new IntervalsClient({
          apiKey: settings.intervals.apiKey.trim(),
          athleteId: settings.intervals.athleteId.trim(),
          today,
          baseUrl: import.meta.env.VITE_INTERVALS_BASE_URL,
        }),
    settings: { timeZone: settings.timeZone },
  };
}

export function App() {
  const [db, setDb] = useState<BrowserDb | null>(null);
  // 整個分頁只有一個 Coach，儲存設定時以 configure() 更新，不重建（理由見 Coach.configure）
  const [coach, setCoach] = useState<Coach | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const [testMode, setTestMode] = useState(loadTestMode);
  const [tab, setTab] = useState<Tab>("chat");
  const [revision, setRevision] = useState(0);
  const [outbox, setOutbox] = useState<string | null>(null);
  const opening = useRef(false);

  const problem = llmProblem(settings);

  useEffect(() => {
    // StrictMode 在開發時會執行兩次 effect；OPFS 的檔案一次只能由一條連線開啟
    if (opening.current) return;
    opening.current = true;
    (async () => {
      const initialSettings = loadSettings();
      const initialTest = loadTestMode();
      clockOffset = clockOffsetMs(initialTest, initialSettings.timeZone);
      // 測試模式用另一個資料庫檔案，正式資料不受影響
      const opened = await openBrowserDb(initialTest.enabled ? TEST_DB_FILE : undefined);
      const created = new Coach({ driver: opened, ...coachConfig(initialSettings, initialTest), now, logger });
      await created.init();
      setDb(opened);
      setCoach(created);
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
      async updateSettings(next) {
        await saveSettings(next);
        clockOffset = clockOffsetMs(testMode, next.timeZone);
        coach.configure(coachConfig(next, testMode));
        setSettings(next);
      },
      testMode,
      activitiesReady: testMode.enabled || settings.intervals.apiKey.trim() !== "",
      updateTestMode(next) {
        saveTestMode(next);
        // 切換正式／測試資料庫要重新載入；其餘（假資料、模擬日期）直接套用
        if (next.enabled !== testMode.enabled) {
          location.reload();
          return;
        }
        clockOffset = clockOffsetMs(next, settings.timeZone);
        coach.configure(coachConfig(settings, next));
        setTestMode(next);
        touch();
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
  }, [db, coach, settings, testMode, problem, revision, touch]);

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
        {(!state.db.persistent || testMode.enabled) && (
          <div className="notices">
            {!state.db.persistent && (
              <div className="notice warn">
                目前無法使用瀏覽器的持久儲存，資料只會留在這個分頁，關閉後就會消失。常見原因：無痕視窗，或本站已在另一個分頁開啟。
              </div>
            )}
            {testMode.enabled && (
              <div className="notice test-banner">
                <span>
                  🧪 測試模式：使用假資料與另一個資料庫，正式資料不受影響。
                  {testMode.today ? `模擬日期 ${testMode.today}。` : ""}
                </span>
                <button className="link" onClick={() => setTab("settings")}>
                  測試設定
                </button>
              </div>
            )}
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
