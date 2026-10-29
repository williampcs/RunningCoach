import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  Coach,
  FakeActivitySource,
  IntervalsClient,
  OpenMeteoRaceWeather,
  OpenMeteoWeather,
  openMeteoUrlsAt,
  localDate,
  type CoachConfig,
  type LlmProvider,
  type Logger,
} from "@running-coach/core";

import { BookOpen, CalendarDays, CircleHelp, FlaskConical, MessageCircle, Settings as SettingsIcon, SquarePen, User, X, type LucideIcon } from "lucide-react";

import { PRIVACY_HTML, TERMS_HTML } from "virtual:legal-pages";

import { AppContext, errorText, type AppState, type HistoryFocus, type Panel, type SettingsSection, type Tab } from "./app-context";
import { EmojiText, Icon, ICON_TAB } from "./ui";
import { HelpView } from "./views/Help";
import { featureEnabled, FEATURES_ON, IS_STAGING, MOVED_TO } from "./environment";
import { MovedBanner } from "./views/Moved";
import { StagingBanner } from "./views/Staging";
import { TermsConfirm } from "./views/TermsConfirm";
import { RedFlagBanner } from "./views/RedFlag";
import { useRedFlagAlert } from "./red-flag-alert";
import { useDeviceSync } from "./device-sync";
import { openBrowserDb, type BrowserDb } from "./db/driver";
import { buildProvider, forgetLockedSecrets, llmProblem, loadSettings, needsTermsConfirm, resolvedModels, saveSettings, termsAccepted, type AppSettings } from "./settings";
import { deleteDeviceIdentity } from "./device-identity";
import { markRemoved, NewDevicesBanner, RemovedBanner, removedHere } from "./views/DeviceAlerts";
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

// 設定在設定好之後很少用，放在標題列的齒輪，底部維持 5 個分頁（規格 12.9）；線條圖示＋兩個字（規格 12.28）
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "chat", label: "對話", icon: MessageCircle },
  { id: "report", label: "回報", icon: SquarePen },
  { id: "history", label: "紀錄", icon: BookOpen },
  { id: "plan", label: "計畫", icon: CalendarDays },
  { id: "profile", label: "選手", icon: User },
];
/** 小提示留在畫面上多久 */
const TOAST_MS = 3000;
const PANEL_LABELS: Record<Panel, string> = { help: "使用說明", settings: "設定", terms: "使用須知", privacy: "隱私說明" };
/** 使用須知與隱私說明（KI-046）：從說明或設定點進來時，✕ 與返回回到那個面板；兩頁之間切換不疊加 */
const LEGAL_PANELS: Panel[] = ["terms", "privacy"];

/** 面板記在瀏覽器的歷史紀錄裡，手機的返回（上一頁）就是關閉面板 */
function panelInHistory(): Panel | null {
  const panel = (history.state as { panel?: unknown } | null)?.panel;
  return typeof panel === "string" && panel in PANEL_LABELS ? (panel as Panel) : null;
}

/** App 裡指到使用須知、隱私說明靜態頁的連結（TermsLink、PrivacyLink、教練回覆、兩頁之間的連結）：改在面板打開 */
function legalPanelOf(target: EventTarget | null): Panel | null {
  const link = target instanceof Element ? target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement) || link.origin !== location.origin) return null;
  const path = link.pathname.replace(/\.html$/, "").replace(/\/$/, "");
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  if (path === `${base}/terms`) return "terms";
  if (path === `${base}/privacy`) return "privacy";
  return null;
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
    // 比賽地點的天氣（規格 12.31）：地點在賽事上，不依賴天氣的設定
    raceWeather: new OpenMeteoRaceWeather({
      urls: import.meta.env.VITE_WEATHER_BASE_URL ? openMeteoUrlsAt(import.meta.env.VITE_WEATHER_BASE_URL) : undefined,
    }),
    settings: { timeZone: settings.timeZone, shell: "web", features: FEATURES_ON },
  };
}

export function App() {
  const [db, setDb] = useState<BrowserDb | null>(null);
  // 整個分頁只有一個 Coach，儲存設定時以 configure() 更新，不重建（理由見 Coach.configure）
  const [coach, setCoach] = useState<Coach | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const [termsAtOpen] = useState(() => needsTermsConfirm(loadSettings()));
  const redFlag = useRedFlagAlert();
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
  // 從說明或設定點進使用須知、隱私說明：說明或設定留在底下（不卸載），返回時回到原本的地方
  const [under, setUnder] = useState<Panel | null>(null);
  const openPanel = useCallback((next: Panel, here = false) => {
    const current = panelInHistory();
    if (LEGAL_PANELS.includes(next) && current && !LEGAL_PANELS.includes(current)) setUnder(current);
    // 使用須知與隱私說明之間互相切換時取代目前這頁，不疊上去：✕ 與返回一次就回到第一次打開它的地方
    const between = current && LEGAL_PANELS.includes(current) && LEGAL_PANELS.includes(next);
    if (here || between || (current && !LEGAL_PANELS.includes(next))) history.replaceState({ panel: next }, "");
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
  // 使用須知與隱私說明的連結在面板打開，不開新分頁：新分頁裡再回到 App 會開出第二個 App（KI-046）.
  // 按著 Ctrl／⌘ 等要開新分頁的點法照瀏覽器的做法
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const next = legalPanelOf(e.target);
      if (!next) return;
      e.preventDefault();
      if (panelInHistory() !== next) openPanel(next);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [openPanel]);
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
  if (under && (!panel || !LEGAL_PANELS.includes(panel))) setUnder(null);
  // 畫面上的面板：關閉後先留著滑出（leaving），動畫結束才移除；滑出途中再打開就直接換回來（規格 12.17 的後續）
  const [shown, setShown] = useState<Panel | null>(panel);
  const [leaving, setLeaving] = useState(false);
  if (panel && (panel !== shown || leaving)) {
    setShown(panel);
    setLeaving(false);
  } else if (!panel && shown && !leaving) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) setShown(null);
    else setLeaving(true);
  }
  const finishLeaving = useCallback(() => {
    setShown(null);
    setLeaving(false);
  }, []);
  useEffect(() => {
    if (!leaving) return;
    // 保險：動畫沒有觸發 animationend 時（例如分頁在背景）也會移除
    const timer = setTimeout(finishLeaving, 400);
    return () => clearTimeout(timer);
  }, [leaving, finishLeaving]);
  // 焦點：打開時移到面板的標題，關閉後回到打開它的按鈕（焦點留在面板裡或已經不見時才移，點了側邊的分頁就留在分頁上）
  const panelTitle = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(panel !== null);
  // 電腦上側邊的分頁在暗幕之上、點得到（12.17），面板打開時只有手機把它設成 inert
  const [wide, setWide] = useState(() => matchMedia("(min-width: 900px)").matches);
  useEffect(() => {
    const query = matchMedia("(min-width: 900px)");
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  useLayoutEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    const inPanel = !active || active === document.body || !!active.closest("#side-panel");
    if (panel && !wasOpen.current) {
      opener.current = active && active !== document.body ? active : null;
      panelTitle.current?.focus();
    } else if (panel && inPanel && !active?.closest(".side-panel-head")) {
      // 從面板裡的連結換到另一個面板：原本的內容不見了，焦點移到新的標題
      panelTitle.current?.focus();
    } else if (!panel && wasOpen.current) {
      const back = opener.current?.isConnected ? opener.current : null;
      if (inPanel) (back ?? document.querySelector<HTMLElement>(shown === "help" ? ".help-button" : ".settings-button"))?.focus();
      opener.current = null;
    }
    wasOpen.current = panel !== null;
    // shown 只用來找關閉的是哪個面板
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);
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
  const [reportPreselect, setReportPreselect] = useState<number | string | null>(null);
  // 課表頁「之前的週」點了某一趟：紀錄頁打開那一趟（規格 12.34）
  const [historyFocus, setHistoryFocus] = useState<HistoryFocus | null>(null);
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
  // 別台換了金鑰：同步引擎取得新的同步金鑰後存進設定（規格 12.27）
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const saveSyncKey = useCallback(async (key: string) => {
    const next = { ...settingsRef.current, sync: { ...settingsRef.current.sync, key } };
    await saveSettings(next);
    settingsRef.current = next;
    setSettings(next);
  }, []);
  // 這台已從同步移除（聲明與證明都對得上，規格 12.27）：清掉同步金鑰、API key 與這台的裝置金鑰；
  // 訓練資料、選手資料、對話留著，由使用者決定要清除、匯出，或用這台的資料重新開始同步
  const onRemoved = useCallback(() => {
    void (async () => {
      const current = settingsRef.current;
      const next: AppSettings = {
        ...current,
        apiKey: "",
        proxy: { ...current.proxy, token: "" },
        intervals: { ...current.intervals, apiKey: "" },
        sync: { ...current.sync, key: "" },
      };
      try {
        await saveSettings(next);
      } catch {
        // 密碼鎖沒解開時存不了：連加密的憑證一起刪掉
        forgetLockedSecrets();
        saveSettings({ ...next }).catch(() => undefined);
      }
      await deleteDeviceIdentity();
      markRemoved();
      location.reload();
    })();
  }, []);
  const deviceSync = useDeviceSync(coach, settings, testMode.enabled, revision, touch, saveSyncKey, onRemoved);
  // 新裝置加入的提醒點「查看」：打開設定並捲到多裝置同步
  const [devicesFocus, setDevicesFocus] = useState(0);
  // 打開設定時直接到哪一項；n 讓同一項再打開一次也有反應
  const [settingsSection, setSettingsSection] = useState<{ id: SettingsSection | null; n: number }>({ id: null, n: 0 });
  const openSettings = useCallback(
    (section?: SettingsSection) => {
      setSettingsSection((current) => ({ id: section ?? null, n: current.n + 1 }));
      openPanel("settings");
    },
    [openPanel],
  );
  // 畫面下方的小提示（規格 12.28）
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const toastId = useRef(0);
  const toast = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((list) => [...list, { id, text }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_MS);
  }, []);
  const [removed, setRemoved] = useState(removedHere);

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
        if (next === "settings") openSettings();
        else if (next === "help") {
          setHelpTopic(null);
          openPanel(next);
        } else if (next === "terms" || next === "privacy") openPanel(next);
        else showTab(next);
      },
      openHistory(target) {
        setHistoryFocus(target);
        showTab("history");
      },
      openReport(target) {
        setReportPreselect(target ?? null);
        showTab("report");
      },
      deviceSync,
      pairFromLink,
      clearPairFromLink: () => setPairFromLink(null),
      devicesFocus,
      showDevices() {
        setDevicesFocus((n) => n + 1);
        openSettings("sync");
      },
      openSettings,
      toast,
    };
  }, [db, coach, settings, testMode, problem, revision, touch, activitiesReady, deviceSync, pairFromLink, openPanel, showTab, devicesFocus, openSettings, toast]);

  // 從配對連結打開：直接打開設定，到同步那一項
  useEffect(() => {
    if (pairFromLink) openSettings("sync");
  }, [pairFromLink, openSettings]);

  // 同一個按鈕再點一次就關閉；開著另一個面板時直接換過去
  const togglePanel = (next: Panel) => {
    // 從說明點進使用須知時再點 ?：回到底下的說明（返回），不在歷史紀錄裡多疊一筆
    if (panel === next || (panel && LEGAL_PANELS.includes(panel) && under === next)) closePanel();
    else if (next === "settings") openSettings();
    else {
      setHelpTopic(null);
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

  // 用過 App、還沒確認過這一版的使用須知：打開時先確認，底下的畫面不能操作（規格 12.32）.
  // 只看打開時的設定：第一次設定時只勾了資料流向的人，在設定頁勾使用須知就好，不跳出來打斷
  const termsGate = termsAtOpen && !termsAccepted(settings);
  // 面板裡的說明或設定：使用須知與隱私說明蓋在它上面時也留著
  const base = shown === "help" || shown === "settings" ? shown : under;

  return (
    <AppContext.Provider value={state}>
      {termsGate && <TermsConfirm />}
      <div className="shell" inert={termsGate}>
        <header className="topbar" ref={topbar}>
          <h1>Zone2Mate</h1>
          <span className={IS_STAGING ? "version staging" : "version"} title={BUILD_DETAIL}>
            {STAGE_LABEL}
          </span>
          <button
            className={panel === "help" ? "icon-button help-button active" : "icon-button help-button"}
            aria-label="使用說明"
            aria-expanded={panel === "help"}
            aria-controls="side-panel"
            title="使用說明"
            onClick={() => togglePanel("help")}
          >
            <Icon as={CircleHelp} size={ICON_TAB} />
          </button>
          <button
            className={panel === "settings" ? "icon-button settings-button active" : "icon-button settings-button"}
            aria-label="設定"
            aria-expanded={panel === "settings"}
            aria-controls="side-panel"
            title="設定"
            onClick={() => togglePanel("settings")}
          >
            <Icon as={SettingsIcon} size={ICON_TAB} />
          </button>
        </header>
        {(!state.db.persistent || testMode.enabled || IS_STAGING || MOVED_TO || newVersion.commit || removed || deviceSync.newDevices.length > 0 || redFlag) && (
          <div className="notices" inert={!!panel}>
            {/* 就醫提示（規格 12.33）：最上面，按「我知道了」才收起 */}
            <RedFlagBanner />
            {newVersion.commit && (
              // 不自動重新載入：打到一半的字會不見，由使用者決定什麼時候更新（規格 12.18）
              <div className="notice info update-banner" role="status">
                <button className="link" onClick={() => location.reload()}>
                  有新版本，點這裡更新
                </button>
                <button className="icon-button update-dismiss" aria-label="先不要更新" title="先不要更新" onClick={newVersion.dismiss}>
                  <Icon as={X} />
                </button>
              </div>
            )}
            <MovedBanner />
            <StagingBanner />
            {removed && <RemovedBanner onDismiss={() => setRemoved(false)} />}
            <NewDevicesBanner />
            {!state.db.persistent && (
              <div className="notice warn">
                目前無法使用瀏覽器的持久儲存，資料只會留在這個分頁，關閉後就會消失。常見原因：無痕視窗。
              </div>
            )}
            {testMode.enabled && (
              <div className="notice test-banner">
                <span>
                  <Icon as={FlaskConical} size={16} /> 測試模式：用假資料，正式資料不受影響。
                  {testMode.today ? `模擬日期 ${testMode.today}。` : ""}
                </span>
                <button className="text" onClick={() => openSettings("testmode")}>
                  測試設定
                </button>
              </div>
            )}
          </div>
        )}
        <main className={tab === "chat" ? "page chat-page" : "page"} inert={!!panel}>
          {tab === "chat" && <ChatView outbox={outbox} onOutboxSent={() => setOutbox(null)} />}
          {tab === "report" && <ReportView preselect={reportPreselect} onPreselectUsed={() => setReportPreselect(null)} />}
          {tab === "history" && <HistoryView focus={historyFocus} onFocusUsed={() => setHistoryFocus(null)} />}
          {tab === "plan" && <PlanView />}
          {tab === "profile" && <ProfileView />}
        </main>
        <nav className="tabbar" aria-label="主要分頁" inert={!!panel && !wide}>
          {TABS.map((t) => (
            <button key={t.id} className={t.id === tab ? "active" : ""} aria-current={t.id === tab} onClick={() => showTab(t.id)}>
              <Icon as={t.icon} size={ICON_TAB} />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="toast" role="status">
              <EmojiText text={t.text} />
            </div>
          ))}
        </div>
      </div>
        {shown && (
          <>
            {/* 電腦上底下的頁面看得到（變暗），點暗的地方也關閉；側邊的分頁在暗幕之上，點了直接切過去 */}
            <div className={`panel-backdrop${leaving ? " leaving" : ""}${termsGate ? " over-gate" : ""}`} onClick={closePanel} />
            <aside
              id="side-panel"
              className={`side-panel${leaving ? " leaving" : ""}${termsGate ? " over-gate" : ""}`}
              role="dialog"
              aria-label={PANEL_LABELS[shown]}
              inert={leaving}
              onAnimationEnd={(e) => {
                if (e.target === e.currentTarget && e.animationName === "panel-out") finishLeaving();
              }}
            >
              <div className="side-panel-head">
                <h2 ref={panelTitle} tabIndex={-1}>
                  {PANEL_LABELS[shown]}
                </h2>
                <button className="icon-button side-panel-close" aria-label={`關閉${PANEL_LABELS[shown]}`} title="關閉" onClick={closePanel}>
                  <Icon as={X} />
                </button>
              </div>
              {base && (
                <div className="side-panel-body" hidden={base !== shown}>
                  {base === "settings" ? <SettingsView section={settingsSection} /> : <HelpView topic={helpTopic} />}
                </div>
              )}
              {base !== shown && (
                // 建置時由靜態頁產生的固定內容（vite.config.ts 的 legalPagesModule），不含使用者或模型的文字；換頁時從最上面看起
                <div className="side-panel-body" key={shown}>
                  <div className="legal-page" dangerouslySetInnerHTML={{ __html: shown === "terms" ? TERMS_HTML : PRIVACY_HTML }} />
                </div>
              )}
            </aside>
          </>
        )}
    </AppContext.Provider>
  );
}
