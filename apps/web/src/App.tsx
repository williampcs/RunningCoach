import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Coach,
  FakeActivitySource,
  IntervalsClient,
  OpenMeteoWeather,
  openMeteoUrlsAt,
  localDate,
  type CoachConfig,
  type LlmProvider,
  type Logger,
} from "@running-coach/core";

import { AppContext, errorText, type AppState, type Panel, type Tab } from "./app-context";
import { HelpView } from "./views/Help";
import { IS_PREVIEW, PreviewBanner } from "./views/Preview";
import { useDeviceSync } from "./device-sync";
import { openBrowserDb, type BrowserDb } from "./db/driver";
import { buildProvider, llmProblem, loadSettings, resolvedModels, saveSettings, type AppSettings } from "./settings";
import {
  clockOffsetMs,
  loadTestMode,
  saveTestMode,
  TEST_DB_FILE,
  testActivities,
  testRunSettings,
  testWellness,
  type TestMode,
} from "./test-mode";
import { ChatView } from "./views/Chat";
import { HistoryView } from "./views/History";
import { PlanView } from "./views/Plan";
import { ProfileView } from "./views/Profile";
import { ReportView } from "./views/Report";
import { SettingsView } from "./views/Settings";
import { requestPersistentStorage, useNewVersion } from "./update-check";
import { BUILD, BUILD_DETAIL, STAGE_LABEL } from "./version";

// 設定在設定好之後很少用，放在標題列的齒輪，底部維持 5 個分頁（規格 12.9）
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "chat", label: "對話", icon: "💬" },
  { id: "report", label: "跑後回報", icon: "🏃" },
  { id: "history", label: "紀錄", icon: "📖" },
  { id: "plan", label: "計畫與賽事", icon: "📅" },
  { id: "profile", label: "選手資料", icon: "👤" },
];
const PAGE_LABELS = Object.fromEntries(TABS.map((t) => [t.id, t.label])) as Record<Tab, string>;
const PANEL_LABELS: Record<Panel, string> = { help: "使用說明", settings: "設定" };

/** 面板記在瀏覽器的歷史紀錄裡，手機的返回（上一頁）就是關閉面板 */
function panelInHistory(): Panel | null {
  const panel = (history.state as { panel?: unknown } | null)?.panel;
  return panel === "help" || panel === "settings" ? panel : null;
}

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

/** 網址的 #help 或 #help/主題（教練回覆裡的「看完整說明」）；讀到後從網址清掉，同一個連結再點一次也有反應 */
function readHelpLink(): string | null {
  const match = location.hash.match(/^#help(?:\/([a-z0-9-]+))?$/);
  if (!match) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return match[1] ?? "";
}

/** 網址的 #pair=配對碼.指紋（掃了另一台的 QR code）；讀到後從網址清掉 */
function readPairLink(): string | null {
  const match = location.hash.match(/^#pair=([0-9A-Za-z]{8})(\.[A-Za-z0-9_-]{22})?$/);
  if (!match) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return `${match[1]!.toUpperCase()}${match[2] ?? ""}`;
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
      ? new FakeActivitySource(testActivities(test), today, testWellness(test), testRunSettings(test))
      : new IntervalsClient({
          apiKey: settings.intervals.apiKey.trim(),
          athleteId: settings.intervals.athleteId.trim(),
          today,
          baseUrl: import.meta.env.VITE_INTERVALS_BASE_URL,
        }),
    weather: settings.weather
      ? new OpenMeteoWeather({
          place: settings.weather,
          timeZone: settings.timeZone,
          today,
          urls: import.meta.env.VITE_WEATHER_BASE_URL ? openMeteoUrlsAt(import.meta.env.VITE_WEATHER_BASE_URL) : undefined,
        })
      : null,
    settings: { timeZone: settings.timeZone, shell: "web" },
  };
}

export function App() {
  const [db, setDb] = useState<BrowserDb | null>(null);
  // 整個分頁只有一個 Coach，儲存設定時以 configure() 更新，不重建（理由見 Coach.configure）
  const [coach, setCoach] = useState<Coach | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const [testMode, setTestMode] = useState(loadTestMode);
  // 從說明的連結打開：直接到使用說明頁的那一段
  const [helpTopic, setHelpTopic] = useState<{ id: string } | null>(() => {
    const id = readHelpLink();
    return id === null ? null : { id };
  });
  const [tab, setTab] = useState<Tab>("chat");
  // 說明與設定是蓋在目前分頁上的面板（規格 12.17）：底下的分頁一直掛載，關閉後捲動位置與打到一半的字都還在
  // 重新載入（例如在設定裡切換測試模式）時，歷史紀錄裡還記著面板：照樣打開，和返回的行為一致
  const [panel, setPanel] = useState<Panel | null>(panelInHistory);
  // 打開時在歷史紀錄加一筆，返回就關閉；已經開著另一個面板時直接換掉那一筆。
  // here：目前這一筆就是剛點的連結（#help/…），換成面板，返回時回到點連結之前
  const openPanel = useCallback((next: Panel, here = false) => {
    if (here || panelInHistory()) history.replaceState({ panel: next }, "");
    else history.pushState({ panel: next }, "");
    setPanel(next);
  }, []);
  const closePanel = useCallback(() => {
    // 返回會觸發 popstate，在那裡關閉
    if (panelInHistory()) history.back();
    else setPanel(null);
  }, []);
  const showTab = useCallback(
    (next: Tab) => {
      closePanel();
      setTab(next);
    },
    [closePanel],
  );
  useEffect(() => {
    const onPop = () => setPanel(panelInHistory());
    window.addEventListener("popstate", onPop);
    // 從說明的連結打開頁面：加一筆，返回時回到底下的對話，而不是離開網站
    if (helpTopic) openPanel("help");
    return () => window.removeEventListener("popstate", onPop);
    // 只在第一次執行；helpTopic 之後的變化由 hashchange 處理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanel]);
  // 面板從標題列下方開始，標題列的 ❓ 與 ⚙️ 一直按得到（再點一次就關閉）
  const topbar = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = topbar.current;
    if (!panel || !el) return;
    const measure = () => document.documentElement.style.setProperty("--topbar-bottom", `${el.getBoundingClientRect().bottom}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // 標題列在資料庫開好後才出現
  }, [panel, coach]);
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, closePanel]);
  const [revision, setRevision] = useState(0);
  const [outbox, setOutbox] = useState<string | null>(null);
  const [reportPreselect, setReportPreselect] = useState<number | null>(null);
  // 用手機掃了另一台顯示的 QR code：網址的 #pair= 後面是配對碼（不會送到伺服器）
  const [pairFromLink, setPairFromLink] = useState<string | null>(readPairLink);
  // 已經開著的分頁貼上配對連結：只有 # 後面改變，頁面不會重新載入
  useEffect(() => {
    const onHash = () => {
      const code = readPairLink();
      if (code) setPairFromLink(code);
      const help = readHelpLink();
      if (help !== null) {
        setHelpTopic({ id: help });
        openPanel("help", true);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [openPanel]);
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
      // 資料庫開在瀏覽器的儲存空間；要求瀏覽器不要自動清掉（規格 12.18），設定頁顯示結果
      if (opened.persistent) void requestPersistentStorage();
    })().catch((e) => setFatal(errorText(e)));
  }, []);

  const touch = useCallback(() => setRevision((r) => r + 1), []);
  const newVersion = useNewVersion(BUILD.commit);
  const deviceSync = useDeviceSync(coach, settings, testMode.enabled, revision, touch);

  const activitiesReady = testMode.enabled || settings.intervals.apiKey.trim() !== "";

  // 手機把 App 放在背景、隔天再打開時，頁面不會重新載入：回到前景與跨日時重新讀取，
  // 恢復資料（手錶早上才同步的靜息心率、HRV、睡眠）過期時也重新取得（只讀取，不花 LLM 的費用）
  useEffect(() => {
    if (!coach) return;
    let day = coach.today();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const today = coach.today();
      if (today !== day) {
        day = today;
        touch();
      }
      if (activitiesReady) void coach.refreshWellness().then((fetched) => fetched && touch());
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(timer);
    };
  }, [coach, touch, activitiesReady]);

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
      activitiesReady,
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
        if (next === "help" || next === "settings") {
          if (next === "help") setHelpTopic(null);
          openPanel(next);
        } else showTab(next);
      },
      openReport(workoutId) {
        setReportPreselect(workoutId ?? null);
        showTab("report");
      },
      deviceSync,
      pairFromLink,
      clearPairFromLink: () => setPairFromLink(null),
    };
  }, [db, coach, settings, testMode, problem, revision, touch, activitiesReady, deviceSync, pairFromLink, openPanel, showTab]);

  // 從配對連結打開：直接打開設定，到同步區塊
  useEffect(() => {
    if (pairFromLink) openPanel("settings");
  }, [pairFromLink, openPanel]);

  // 同一個按鈕再點一次就關閉；開著另一個面板時直接換過去
  const togglePanel = (next: Panel) => {
    if (panel === next) closePanel();
    else {
      if (next === "help") setHelpTopic(null);
      openPanel(next);
    }
  };

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
        <header className="topbar" ref={topbar}>
          <h1>Running Coach</h1>
          <span className="version" title={BUILD_DETAIL}>
            {STAGE_LABEL}
          </span>
          <span className="page-label muted small">{PAGE_LABELS[tab]}</span>
          <button
            className={panel === "help" ? "help-button active" : "help-button"}
            aria-label="使用說明"
            aria-expanded={panel === "help"}
            aria-controls="side-panel"
            title="使用說明"
            onClick={() => togglePanel("help")}
          >
            <span aria-hidden="true">?</span>
          </button>
          <button
            className={panel === "settings" ? "settings-button active" : "settings-button"}
            aria-label="設定"
            aria-expanded={panel === "settings"}
            aria-controls="side-panel"
            title="設定"
            onClick={() => togglePanel("settings")}
          >
            <span aria-hidden="true">⚙️</span>
          </button>
        </header>
        {(!state.db.persistent || testMode.enabled || IS_PREVIEW || newVersion.commit) && (
          <div className="notices">
            {newVersion.commit && (
              // 不自動重新載入：打到一半的字會不見，由使用者決定什麼時候更新（規格 12.18）
              <div className="notice info update-banner" role="status">
                <button className="link" onClick={() => location.reload()}>
                  有新版本，點這裡更新
                </button>
                <button className="update-dismiss" aria-label="先不要更新" title="先不要更新" onClick={newVersion.dismiss}>
                  <span aria-hidden="true">✕</span>
                </button>
              </div>
            )}
            <PreviewBanner />
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
                <button className="link" onClick={() => openPanel("settings")}>
                  測試設定
                </button>
              </div>
            )}
          </div>
        )}
        <main className={tab === "chat" ? "page chat-page" : "page"}>
          {tab === "chat" && <ChatView outbox={outbox} onOutboxSent={() => setOutbox(null)} />}
          {tab === "report" && <ReportView preselect={reportPreselect} onPreselectUsed={() => setReportPreselect(null)} />}
          {tab === "history" && <HistoryView />}
          {tab === "plan" && <PlanView />}
          {tab === "profile" && <ProfileView />}
        </main>
        <nav className="tabbar" aria-label="主要分頁">
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? "active" : ""} aria-current={t.id === tab} onClick={() => showTab(t.id)}>
              <span aria-hidden="true">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
        {panel && (
          <>
            {/* 電腦上底下的頁面看得到（變暗），點暗的地方也關閉；側邊的分頁在暗幕之上，點了直接切過去 */}
            <div className="panel-backdrop" onClick={closePanel} />
            <aside id="side-panel" className="side-panel" role="dialog" aria-label={PANEL_LABELS[panel]}>
              <div className="side-panel-head">
                <h2>{PANEL_LABELS[panel]}</h2>
                <button className="side-panel-close" aria-label={`關閉${PANEL_LABELS[panel]}`} title="關閉" onClick={closePanel}>
                  <span aria-hidden="true">✕</span>
                </button>
              </div>
              <div className="side-panel-body">{panel === "settings" ? <SettingsView /> : <HelpView topic={helpTopic} />}</div>
            </aside>
          </>
        )}
      </div>
    </AppContext.Provider>
  );
}
