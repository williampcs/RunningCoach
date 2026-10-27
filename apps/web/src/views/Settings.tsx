import { useEffect, useState, type ReactNode } from "react";

import { ChevronLeft, ChevronRight, CloudSun, Database, FlaskConical, Gauge, Lock, RotateCcw, Smartphone, Sparkles, Watch, type LucideIcon } from "lucide-react";

import { formatStatus, type Effort, type Purpose } from "@running-coach/core";

import { errorText, useApp, type SettingsSection } from "../app-context";
import { featureEnabled } from "../environment";
import { Markdown } from "../Markdown";
import { Disclosure, Icon, InfoTip, ListRow, stripEmoji } from "../ui";
import { useSync } from "../use-sync";
import { clearRemoved } from "./DeviceAlerts";
import { DeviceSyncCard } from "./DeviceSync";
import { MovedCard } from "./Moved";
import { FirstSync } from "./FirstSync";
import { WeatherCard } from "./WeatherSettings";
import { IntervalsGuide, resetGettingStarted } from "./GettingStarted";
import { storageProtection, type StorageProtection } from "../update-check";
import { BUILD_DETAIL, FEATURES_LABEL } from "../version";
import { PhoneGuide, SyncNotice, syncNoticeShown } from "./PhoneGuide";
import { PrivacyLink } from "./PrivacyLink";
import { TestModeCard } from "./TestMode";
import {
  clearSettings,
  consentKey,
  disableLock,
  enableLock,
  lockEnabled,
  PROVIDER_LABELS,
  PROVIDER_RECIPIENT,
  suggestedModels,
  type AppSettings,
  type ProviderKind,
} from "../settings";

// AGPL 第 13 條：對外提供服務時，使用者要能取得對應的原始碼。部署修改過的版本時，請把連結改成你的版本
const SOURCE_URL = "https://github.com/williampcs/RunningCoach";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const MODEL_LABELS: Record<Purpose, string> = { chat: "主對話", summary: "跑後摘要", compress: "對話壓縮" };

/** 設定的第一層：每一項的圖示與名稱（規格 12.28） */
const SECTIONS: Record<SettingsSection, { title: string; icon: LucideIcon }> = {
  ai: { title: "AI 教練", icon: Sparkles },
  records: { title: "訓練紀錄", icon: Watch },
  weather: { title: "天氣", icon: CloudSun },
  sync: { title: "多裝置同步", icon: Smartphone },
  lock: { title: "密碼鎖", icon: Lock },
  data: { title: "資料", icon: Database },
  testmode: { title: "測試模式", icon: FlaskConical },
  reset: { title: "重置", icon: RotateCcw },
  status: { title: "系統狀態", icon: Gauge },
};

/** 目前選擇下，資料會送到哪裡（收在 ⓘ 裡） */
function DataFlow({ draft, locked }: { draft: AppSettings; locked: boolean }) {
  if (draft.llmMode === "proxy") {
    return (
      <ul>
        <li>你的對話、選手資料與訓練紀錄會經過 Zone2Mate 的代理伺服器，轉送給 Anthropic 產生回覆。</li>
        <li>代理只在記憶體中轉發，不儲存內容；會記錄的只有帳號識別、訂閱狀態與 token 用量。</li>
        <li>Anthropic 如何保存與使用這些資料，依它的 API 條款而定，Zone2Mate 無法替它保證。</li>
      </ul>
    );
  }
  const recipient = PROVIDER_RECIPIENT[draft.provider];
  return (
    <ul>
      <li>你的對話、選手資料與訓練紀錄會從這個瀏覽器直接送到 {recipient}，不經過 Zone2Mate 的任何伺服器。</li>
      <li>{recipient} 如何保存與使用這些資料，依它的 API 條款而定，Zone2Mate 無法替它保證。</li>
      <li>
        {locked ? "API key 以你的密碼加密後存在這個瀏覽器。" : "API key 以明文存在這個瀏覽器；能操作這台裝置的人都讀得到。可以在「密碼鎖」加密。"}
      </li>
      <li>
        完整的說明：<PrivacyLink />
      </li>
    </ul>
  );
}

const MIN_PASSWORD = 8;

/** 密碼鎖：把 API key 用密碼加密後再保存；降低外洩風險的建議收在 ⓘ */
function KeyProtection({ settings, locked, onChange }: { settings: AppSettings; locked: boolean; onChange: (locked: boolean) => void }) {
  const { toast } = useApp();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enable() {
    if (password.length < MIN_PASSWORD) {
      setError(`密碼至少要 ${MIN_PASSWORD} 個字元。`);
      return;
    }
    if (password !== confirmPassword) {
      setError("兩次輸入的密碼不一樣。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await enableLock(password, settings);
      setPassword("");
      setConfirmPassword("");
      onChange(true);
      toast("已啟用密碼鎖。下次開啟網頁時要輸入密碼。");
    } catch (e) {
      setError(`啟用失敗：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function disable() {
    if (!confirm("停用後，API key 會改回以明文保存在這個瀏覽器。確定要停用密碼鎖嗎？")) return;
    disableLock(settings);
    onChange(false);
    toast("已停用密碼鎖。");
  }

  return (
    <section className="card">
      <p className="row">
        <span>{locked ? "已啟用：每次開啟網頁都要輸入密碼。" : "用密碼把 API key 加密後再保存。"}</span>
        <InfoTip label="密碼鎖的說明">
          <ul>
            <li>每次開啟網頁要輸入一次密碼。可以防止別人用這台裝置、或拷走瀏覽器資料時讀到 key；解鎖之後擋不住惡意的瀏覽器擴充功能。</li>
            <li>對話與訓練紀錄不會加密。忘記密碼就只能重新填寫 key。</li>
            <li>建議替 Zone2Mate 另外建立一把專用的 key，並在供應商的後台設定每月金額上限；懷疑外洩時到後台撤銷再產生新的。</li>
            <li>匯出的資料庫不含 API key。</li>
          </ul>
        </InfoTip>
      </p>
      {locked ? (
        <div className="actions">
          <button onClick={() => location.reload()}>立即鎖定</button>
          <button className="text" onClick={disable}>
            停用密碼鎖
          </button>
        </div>
      ) : (
        <>
          <div className="grid">
            <label>
              密碼
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label>
              再輸入一次
              <input type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </label>
          </div>
          {error && <p className="field-error">{error}</p>}
          <div className="actions">
            <button className="primary" disabled={busy || password === ""} onClick={() => void enable()}>
              {busy ? "加密中…" : "啟用密碼鎖"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

const PROTECTION_TEXT: Record<StorageProtection, string> = {
  persisted: "已受保護。瀏覽器答應不會自動清掉這個網站的資料；自己清除網站資料、或刪掉主畫面的圖示時，資料仍會一起刪掉。",
  "not-persisted":
    "瀏覽器沒有答應。空間不足或很久沒打開時，資料可能被瀏覽器自動清掉；建議開啟多裝置同步，或定期匯出資料庫。iPhone 建議加到主畫面，從主畫面的圖示打開。",
  unsupported: "這個瀏覽器不支援。資料可能被瀏覽器自動清掉；建議開啟多裝置同步，或定期匯出資料庫。",
};

const PROTECTION_STATUS: Record<StorageProtection, string> = {
  persisted: "已受保護",
  "not-persisted": "可能被清掉",
  unsupported: "可能被清掉",
};

/** 瀏覽器有沒有答應不自動清掉資料（App 開啟時已經要求過，規格 12.18） */
function StorageProtectionNote({ state }: { state: StorageProtection | null }) {
  if (!state) return null;
  return (
    <p className={state === "persisted" ? "muted small storage-protection" : "notice warn storage-protection"} data-state={state}>
      <span>
        <strong>資料保護：</strong>
        {PROTECTION_TEXT[state]}
      </span>
    </p>
  );
}

/** 設定裡的一項：返回、標題，下面是那一項的欄位 */
function Subpage({ id, onBack, children }: { id: SettingsSection; onBack: () => void; children: ReactNode }) {
  return (
    <div className="stack subpage" data-section={id}>
      <div className="subpage-head">
        <button className="back-button" aria-label="回到設定的清單" onClick={onBack}>
          <Icon as={ChevronLeft} />
          設定
        </button>
      </div>
      <h3 className="title">{SECTIONS[id].title}</h3>
      {children}
    </div>
  );
}

export function SettingsView({ section }: { section: { id: SettingsSection | null; n: number } }) {
  const { coach, db, settings, llmProblem, updateSettings, revision, reload, activitiesReady, testMode, deviceSync, toast } = useApp();
  const [page, setPage] = useState<SettingsSection | null>(section.id);
  useEffect(() => setPage(section.id), [section]);
  const [draft, setDraft] = useState(settings);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [workouts, setWorkouts] = useState<number | null>(null);
  const [locked, setLocked] = useState(lockEnabled);
  const [protection, setProtection] = useState<StorageProtection | null>(null);
  // 「進階」：開放相容服務還沒填模型時自動打開（不填就不能對話）
  const [advanced, setAdvanced] = useState(false);
  const sync = useSync();

  useEffect(() => {
    void coach.status().then((s) => setStatus(stripEmoji(formatStatus(s, coach.describeModels(), coach.settings))));
    void coach.db.countWorkouts().then(setWorkouts);
  }, [coach, settings, revision]);

  useEffect(() => {
    if (db.persistent) void storageProtection().then(setProtection);
  }, [db]);

  // 換一項時回到面板的最上面
  useEffect(() => {
    document.querySelector(".side-panel-body")?.scrollTo({ top: 0 });
    setError(null);
  }, [page]);

  // 這張表單只管 AI 模型與 Intervals.icu（還有時區、同意紀錄）；同步金鑰與天氣的城市由各自的卡片管理，
  // 表單打開之後才改的，存檔不能用表單打開時的舊值蓋掉
  const formOf = (s: AppSettings) => ({ ...s, sync: null, weather: null });
  const dirty = JSON.stringify(formOf(draft)) !== JSON.stringify(formOf(settings));
  // 已儲存的設定可以同步、但還沒有任何訓練紀錄：提示下一步
  const syncNext = !dirty && llmProblem === null && activitiesReady && workouts === 0;
  const consented = draft.consents.includes(consentKey(draft));
  const claudeOnly = draft.llmMode === "proxy" || draft.provider === "anthropic";
  const showAdvanced = advanced || !draft.models.chat.trim();

  function switchLlm(llmMode: AppSettings["llmMode"], provider: ProviderKind) {
    setDraft({ ...draft, llmMode, provider, models: suggestedModels(llmMode, provider) });
  }

  function toggleConsent(checked: boolean) {
    const key = consentKey(draft);
    const consents = draft.consents.filter((c) => c !== key);
    setDraft({ ...draft, consents: checked ? [...consents, key] : consents });
  }

  async function save() {
    try {
      // 時區名稱無效時 Intl 會丟出錯誤，存檔前先擋下
      new Intl.DateTimeFormat("en-US", { timeZone: draft.timeZone });
    } catch {
      setError(`時區名稱無效：${draft.timeZone}（例：Asia/Taipei）`);
      return;
    }
    try {
      await updateSettings({ ...draft, sync: settings.sync, weather: settings.weather });
      setError(null);
      toast("設定已儲存在這個瀏覽器。");
    } catch (e) {
      setError(`儲存失敗：${errorText(e)}`);
    }
  }

  async function exportDb() {
    setError(null);
    try {
      const bytes = await db.exportFile();
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.sqlite3" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `running-coach-${coach.today()}.db`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`匯出失敗：${errorText(e)}`);
    }
  }

  /**
   * keep：保留設定與 API key 時，同步要停止（stop）還是重新從雲端取回（refetch）；
   * 沒有開啟同步時兩者一樣。全部重置（keep 為 null）會連同步金鑰一起清掉
   */
  async function reset(keep: "stop" | "refetch" | null) {
    const syncing = deviceSync.enabled && !testMode.enabled;
    const cloudNote = syncing ? "\n雲端的同步資料與其他裝置不受影響；要刪雲端的資料，請先在「多裝置同步」按「刪除雲端的資料」。" : "";
    const what = testMode.enabled
      ? "這會刪除測試資料庫中的對話、訓練紀錄、賽事、計畫與選手資料；正式資料不受影響。"
      : keep === null
        ? `這會刪除這台裝置上的所有資料與設定（包括 API key 與同步金鑰），回到第一次使用的狀態。${cloudNote}`
        : !syncing
          ? "這會刪除這台裝置上的對話、訓練紀錄、賽事、計畫與選手資料；設定與 API key 會保留。"
          : keep === "stop"
            ? `這會刪除這台裝置上的資料，並停止這台的同步（清掉的資料不會再從雲端回來）；設定與 API key 會保留。${cloudNote}`
            : "這會刪除這台裝置上的資料，接著從雲端重新取回同步的資料（選手資料、賽事、課表、自評、對話、跑步的體感與分析）；跑步紀錄會從 Intervals.icu 重新抓。其他裝置不受影響。";
    if (!confirm(`${what}\n無法復原，確定要繼續嗎？`)) return;
    setError(null);
    try {
      // 先停止同步，清除的過程中不會再送出或取回
      if (syncing && keep === "stop") await updateSettings({ ...settings, sync: { ...settings.sync, key: "" } });
      await db.reset();
      resetGettingStarted();
      if (keep === null) {
        clearSettings();
        clearRemoved();
      }
      // 重新載入，讓 Coach 與各頁的狀態（進行中的對話壓縮、未送出的內容）一併回到初始
      location.reload();
    } catch (e) {
      setError(`重置失敗：${errorText(e)}`);
    }
  }

  async function importDb(file: File) {
    if (!confirm("匯入會取代這台裝置上目前的所有資料（對話、訓練紀錄、賽事、選手資料），無法復原。確定要繼續嗎？")) return;
    setError(null);
    try {
      await db.importFile(new Uint8Array(await file.arrayBuffer()));
      await reload();
      toast(`已匯入 ${file.name}。`);
    } catch (e) {
      setError(`匯入失敗：${errorText(e)}`);
    }
  }

  // 儲存設定（AI 教練與訓練紀錄共用同一份草稿）
  const saveRow = (
    <>
      {error && <p className="field-error">{error}</p>}
      <div className="actions">
        <button className="primary" disabled={!dirty} onClick={() => void save()}>
          儲存設定
        </button>
        {dirty && (
          <button className="text" onClick={() => setDraft(settings)}>
            放棄變更
          </button>
        )}
      </div>
    </>
  );

  // 已存好、還沒有紀錄時的下一步（新手引導之外的入口）
  const nextStep = (syncNext || syncNoticeShown(sync.message)) && (
    <div className="notice info">
      <strong>下一步：抓進你的跑步紀錄</strong>
      {syncNext ? <FirstSync sync={sync} /> : <SyncNotice message={sync.message} />}
    </div>
  );

  const back = () => setPage(null);

  if (page === "ai") {
    return (
      <Subpage id="ai" onBack={back}>
        <section className="card">
          <div className="row" role="radiogroup" aria-label="怎麼使用 AI">
            <label className="check">
              <input type="radio" name="mode" checked={draft.llmMode === "byok"} onChange={() => switchLlm("byok", draft.provider)} />
              用自己的 API key
            </label>
            <label className="check">
              <input type="radio" name="mode" checked={draft.llmMode === "proxy"} onChange={() => switchLlm("proxy", draft.provider)} />
              訂閱（經代理）
            </label>
          </div>
          {draft.llmMode === "byok" ? (
            <div className="grid">
              <label>
                供應商
                <select value={draft.provider} onChange={(e) => switchLlm("byok", e.target.value as ProviderKind)}>
                  {(Object.keys(PROVIDER_LABELS) as ProviderKind[]).map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABELS[p]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                API key
                <input type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
              </label>
              {draft.provider === "openai-compatible" && (
                <label className="wide">
                  服務網址
                  <input value={draft.baseURL} placeholder="https://example.com/v1" onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })} />
                </label>
              )}
            </div>
          ) : (
            <div className="grid">
              <label className="wide">
                代理網址
                <input value={draft.proxy.url} placeholder="https://" onChange={(e) => setDraft({ ...draft, proxy: { ...draft.proxy, url: e.target.value } })} />
              </label>
              <label className="wide">
                訂閱憑證
                <input
                  type="password"
                  autoComplete="off"
                  value={draft.proxy.token}
                  onChange={(e) => setDraft({ ...draft, proxy: { ...draft.proxy, token: e.target.value } })}
                />
              </label>
            </div>
          )}
          {/* 很少改的收進「進階」；沒填主對話模型時自動打開 */}
          <details className="disclosure advanced" open={showAdvanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
            <summary>
              <Icon as={ChevronRight} size={16} className="icon chev" />
              進階
            </summary>
            <div className="disclosure-body">
              <div className="grid">
                {(Object.keys(MODEL_LABELS) as Purpose[]).map((purpose) => (
                  <label key={purpose}>
                    {MODEL_LABELS[purpose]}模型
                    <input
                      value={draft.models[purpose]}
                      placeholder={purpose === "chat" ? "模型 ID" : "留空則沿用主對話模型"}
                      onChange={(e) => setDraft({ ...draft, models: { ...draft.models, [purpose]: e.target.value } })}
                    />
                  </label>
                ))}
                <label>
                  主對話思考強度
                  <select value={draft.chatEffort} onChange={(e) => setDraft({ ...draft, chatEffort: e.target.value as Effort })}>
                    {EFFORTS.map((effort) => (
                      <option key={effort}>{effort}</option>
                    ))}
                  </select>
                </label>
              </div>
              {!claudeOnly && <p className="field-note">填該供應商可用的模型 ID；思考強度對應到 low / medium / high。</p>}
            </div>
          </details>
          <div className="section">
            <p className="row">
              <span>
                對話與訓練紀錄會{draft.llmMode === "proxy" ? "經過代理送到 Anthropic" : `直接送到 ${PROVIDER_RECIPIENT[draft.provider]}`}。
              </span>
              <InfoTip label="資料會送到哪裡">
                <DataFlow draft={draft} locked={locked} />
              </InfoTip>
            </p>
            <label className="check">
              <input type="checkbox" checked={consented} onChange={(e) => toggleConsent(e.target.checked)} />
              我了解並同意以上的資料流向
            </label>
          </div>
          {saveRow}
        </section>
        {nextStep}
      </Subpage>
    );
  }

  if (page === "records") {
    return (
      <Subpage id="records" onBack={back}>
        <section className="card">
          {testMode.enabled && <div className="notice info">測試模式中使用假資料，不會連線 Intervals.icu。</div>}
          <p className="row">
            <span>教練透過 Intervals.icu 讀取你手錶的紀錄。</span>
            <InfoTip label="怎麼取得 API key">
              <IntervalsGuide where="下面的「API key」" />
              <p>key 只存在這個瀏覽器，活動資料由瀏覽器直接向 Intervals.icu 取得（<PrivacyLink />）。</p>
            </InfoTip>
          </p>
          <PhoneGuide />
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={draft.intervals.apiKey}
              onChange={(e) => setDraft({ ...draft, intervals: { ...draft.intervals, apiKey: e.target.value } })}
            />
          </label>
          <Disclosure summary="進階" className="advanced">
            <div className="grid">
              <label>
                Athlete ID
                <input
                  value={draft.intervals.athleteId}
                  placeholder="可留空"
                  onChange={(e) => setDraft({ ...draft, intervals: { ...draft.intervals, athleteId: e.target.value } })}
                />
              </label>
              <label>
                時區
                <input value={draft.timeZone} onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })} />
              </label>
            </div>
          </Disclosure>
          {saveRow}
        </section>
        {nextStep}
      </Subpage>
    );
  }

  if (page === "weather") {
    return (
      <Subpage id="weather" onBack={back}>
        <WeatherCard />
      </Subpage>
    );
  }

  if (page === "sync") {
    return (
      <Subpage id="sync" onBack={back}>
        <DeviceSyncCard onLock={() => setPage("lock")} />
      </Subpage>
    );
  }

  if (page === "lock") {
    return (
      <Subpage id="lock" onBack={back}>
        <KeyProtection settings={settings} locked={locked} onChange={setLocked} />
      </Subpage>
    );
  }

  if (page === "data") {
    return (
      <Subpage id="data" onBack={back}>
        <section className="card">
          <p className="row">
            <span>資料都存在這個瀏覽器{db.persistent ? "" : "分頁的記憶體（未持久化）"}，不會自動備份。換裝置前先匯出。</span>
            <InfoTip label="匯出的檔案">
              匯出的檔案是標準的 SQLite 資料庫，含對話、訓練紀錄、賽事與選手資料，不含 API key；也可以匯入 v1（Discord 版）的 coach.db。
            </InfoTip>
          </p>
          {db.persistent && <StorageProtectionNote state={protection} />}
          {error && <p className="field-error">{error}</p>}
          <div className="actions">
            <button onClick={() => void exportDb()}>匯出資料庫</button>
            <label className="button">
              匯入資料庫
              <input
                type="file"
                accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3,application/octet-stream"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void importDb(file);
                }}
              />
            </label>
          </div>
        </section>
      </Subpage>
    );
  }

  if (page === "testmode" && featureEnabled("testmode")) {
    return (
      <Subpage id="testmode" onBack={back}>
        <TestModeCard />
      </Subpage>
    );
  }

  if (page === "reset") {
    return (
      <Subpage id="reset" onBack={back}>
        <section className="card">
          {testMode.enabled ? (
            <>
              <p>測試模式中只會清除測試資料庫；正式資料與設定不受影響。</p>
              <div className="actions">
                <button className="danger" onClick={() => void reset("stop")}>
                  清除測試資料
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="row">
                <span>重置無法復原，需要的話先匯出資料庫。</span>
                <InfoTip label="重置的說明">
                  重置會讓新手引導重新出現。
                  {deviceSync.enabled &&
                    "這台開啟了多裝置同步：重置只影響這台，雲端與其他裝置的資料不受影響。只清除資料時，可以選擇停止這台的同步，或從雲端重新取回。"}
                </InfoTip>
              </p>
              {error && <p className="field-error">{error}</p>}
              <div className="actions">
                {deviceSync.enabled ? (
                  <>
                    <button className="danger" onClick={() => void reset("stop")}>
                      清除這台並停止同步
                    </button>
                    <button className="danger" onClick={() => void reset("refetch")}>
                      清除這台，重新從雲端取回
                    </button>
                  </>
                ) : (
                  <button className="danger" onClick={() => void reset("stop")}>
                    清除資料，保留設定與 API key
                  </button>
                )}
                <button className="danger" onClick={() => void reset(null)}>
                  全部重置
                </button>
              </div>
            </>
          )}
        </section>
      </Subpage>
    );
  }

  if (page === "status") {
    return (
      <Subpage id="status" onBack={back}>
        <section className="card">
          <Markdown>{status}</Markdown>
        </section>
      </Subpage>
    );
  }

  // 第一層：清單，每一列是圖示、名稱與一行副標，右邊是狀態（好的狀態是綠色）
  const providerName = PROVIDER_LABELS[settings.provider].replace(/（(.*)）/, "").replace("其他 OpenAI 相容服務", "相容服務");
  const rowSub: Record<SettingsSection, string> = {
    ai: settings.llmMode === "proxy" ? "訂閱" : `${providerName} · 自己的 key`,
    records: "Intervals.icu",
    weather: settings.weather?.label ?? "還沒設定",
    sync: "電腦、手機之間",
    lock: "保護 API key",
    data: "匯出、匯入",
    testmode: "假資料，正式資料不受影響",
    reset: "清除這台的資料",
    status: "模型與資料量",
  };
  const rowStatus: Partial<Record<SettingsSection, [string, boolean]>> = {
    ai: llmProblem ? ["還沒設定", false] : ["可用", true],
    records: testMode.enabled ? ["測試模式", false] : activitiesReady ? ["已連接", true] : ["還沒連接", false],
    sync: testMode.enabled ? ["不同步", false] : deviceSync.enabled ? ["已開啟", true] : ["關", false],
    lock: locked ? ["開", true] : ["關", false],
    data: protection ? [PROTECTION_STATUS[protection], protection === "persisted"] : db.persistent ? undefined : ["未持久化", false],
    testmode: testMode.enabled ? ["使用中", false] : ["關", false],
  };
  const order: SettingsSection[] = ["ai", "records", "weather", "sync", "lock", "data", ...(featureEnabled("testmode") ? (["testmode"] as const) : []), "reset", "status"];

  return (
    <>
      <MovedCard />
      {nextStep}
      <section className="card settings-list">
        <ul className="rows">
          {order.map((id) => (
            <li key={id}>
              <ListRow
                icon={<Icon as={SECTIONS[id].icon} />}
                title={SECTIONS[id].title}
                sub={rowSub[id]}
                end={rowStatus[id] && <span className={rowStatus[id]![1] ? "status ok" : "status"}>{rowStatus[id]![0]}</span>}
                chevron
                className={id === "reset" ? "danger" : ""}
                label={SECTIONS[id].title}
                onClick={() => setPage(id)}
              />
            </li>
          ))}
        </ul>
      </section>

      <p className="muted small center">
        {BUILD_DETAIL}
        <br />
        {FEATURES_LABEL && (
          <>
            <span className="features-on">{FEATURES_LABEL}</span>
            <br />
          </>
        )}
        Zone2Mate 是自由軟體，以 AGPL-3.0 授權、不附任何擔保。
        <a href={SOURCE_URL} target="_blank" rel="noreferrer">
          原始碼
        </a>
        ・<PrivacyLink />
      </p>
    </>
  );
}
