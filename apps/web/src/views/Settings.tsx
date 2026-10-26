import { useEffect, useState } from "react";

import { formatStatus, type Effort, type Purpose } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { Markdown } from "../Markdown";
import { useSync } from "../use-sync";
import { DeviceSyncCard } from "./DeviceSync";
import { MovedCard } from "./Moved";
import { FirstSync } from "./FirstSync";
import { WeatherCard } from "./WeatherSettings";
import { IntervalsGuide, resetGettingStarted } from "./GettingStarted";
import { storageProtection, type StorageProtection } from "../update-check";
import { BUILD_DETAIL } from "../version";
import { PhoneGuide, SyncNotice } from "./PhoneGuide";
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

/** 目前選擇下，資料會送到哪裡 */
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
      <li>
        你的對話、選手資料與訓練紀錄會從這個瀏覽器直接送到 {recipient}，不經過 Zone2Mate 的任何伺服器。
      </li>
      <li>{recipient} 如何保存與使用這些資料，依它的 API 條款而定，Zone2Mate 無法替它保證。</li>
      <li>
        {locked
          ? "API key 以你的密碼加密後存在這個瀏覽器。"
          : "API key 以明文存在這個瀏覽器；能操作這台裝置的人都讀得到。可以在下方的「保護 API key」啟用密碼鎖。"}
      </li>
      <li>
        資料存在哪裡、會送到哪裡的完整說明：<PrivacyLink />
      </li>
    </ul>
  );
}

const MIN_PASSWORD = 8;

/** 降低 API key 外洩風險的建議，以及選用的密碼鎖 */
function KeyProtection({
  settings,
  locked,
  onChange,
}: {
  settings: AppSettings;
  locked: boolean;
  onChange: (locked: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function enable() {
    if (password.length < MIN_PASSWORD) {
      setMessage({ kind: "error", text: `密碼至少要 ${MIN_PASSWORD} 個字元。` });
      return;
    }
    if (password !== confirmPassword) {
      setMessage({ kind: "error", text: "兩次輸入的密碼不一樣。" });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await enableLock(password, settings);
      setPassword("");
      setConfirmPassword("");
      onChange(true);
      setMessage({ kind: "ok", text: "已啟用密碼鎖。下次開啟網頁時要輸入密碼。" });
    } catch (e) {
      setMessage({ kind: "error", text: `啟用失敗：${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  function disable() {
    if (!confirm("停用後，API key 會改回以明文保存在這個瀏覽器。確定要停用密碼鎖嗎？")) return;
    disableLock(settings);
    onChange(false);
    setMessage({ kind: "ok", text: "已停用密碼鎖。" });
  }

  return (
    <section className="card">
      <h2>保護 API key</h2>
      <ul className="guide small">
        <li>替 Zone2Mate 另外建立一把專用的 key，並在供應商的後台設定每月金額上限，外洩時損失有限。</li>
        <li>懷疑外洩時，到供應商的後台撤銷這把 key 再產生新的；Intervals.icu 的 key 也可以在它的設定頁重新產生。</li>
        <li>匯出的資料庫不含 API key。</li>
      </ul>
      <strong>密碼鎖（選用）</strong>
      {locked ? (
        <>
          <p className="small">已啟用：API key 以你的密碼加密保存，每次開啟網頁都要輸入密碼。</p>
          <div className="row">
            <button onClick={() => location.reload()}>立即鎖定</button>
            <button onClick={disable}>停用密碼鎖</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">
            用你設定的密碼把 API key 加密後再保存，每次開啟網頁要輸入一次密碼。可以防止別人用這台裝置、或拷走瀏覽器資料時讀到
            key；解鎖之後擋不住惡意的瀏覽器擴充功能。對話與訓練紀錄不會加密。忘記密碼就只能重新填寫 key。
          </p>
          <div className="grid">
            <label>
              密碼
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              再輸入一次
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
          </div>
          <div className="row">
            <button className="primary" disabled={busy || password === ""} onClick={() => void enable()}>
              {busy ? "加密中…" : "啟用密碼鎖"}
            </button>
          </div>
        </>
      )}
      {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
    </section>
  );
}

const PROTECTION_TEXT: Record<StorageProtection, string> = {
  persisted: "已受保護。瀏覽器答應不會自動清掉這個網站的資料；自己清除網站資料、或刪掉主畫面的圖示時，資料仍會一起刪掉。",
  "not-persisted":
    "瀏覽器沒有答應。空間不足或很久沒打開時，資料可能被瀏覽器自動清掉；建議開啟多裝置同步，或定期匯出資料庫。iPhone 建議加到主畫面，從主畫面的圖示打開。",
  unsupported: "這個瀏覽器不支援。資料可能被瀏覽器自動清掉；建議開啟多裝置同步，或定期匯出資料庫。",
};

/** 瀏覽器有沒有答應不自動清掉資料（App 開啟時已經要求過，規格 12.18） */
function StorageProtectionNote() {
  const [state, setState] = useState<StorageProtection | null>(null);
  useEffect(() => {
    void storageProtection().then(setState);
  }, []);
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

export function SettingsView() {
  const { coach, db, settings, llmProblem, updateSettings, revision, reload, activitiesReady, testMode, deviceSync } = useApp();
  const [draft, setDraft] = useState(settings);
  const [status, setStatus] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [workouts, setWorkouts] = useState<number | null>(null);
  const [locked, setLocked] = useState(lockEnabled);
  const sync = useSync();

  useEffect(() => {
    void coach.status().then((s) => setStatus(formatStatus(s, coach.describeModels(), coach.settings)));
    void coach.db.countWorkouts().then(setWorkouts);
  }, [coach, settings, revision]);

  // 這張表單只管 AI 模型與 Intervals.icu（還有時區、同意紀錄）；同步金鑰與天氣的城市由各自的卡片管理，
  // 表單打開之後才改的，存檔不能用表單打開時的舊值蓋掉
  const formOf = (s: AppSettings) => ({ ...s, sync: null, weather: null });
  const dirty = JSON.stringify(formOf(draft)) !== JSON.stringify(formOf(settings));
  // 已儲存的設定可以同步、但還沒有任何訓練紀錄：提示下一步
  const syncNext = !dirty && llmProblem === null && activitiesReady && workouts === 0;
  const consented = draft.consents.includes(consentKey(draft));
  const claudeOnly = draft.llmMode === "proxy" || draft.provider === "anthropic";

  function switchLlm(llmMode: AppSettings["llmMode"], provider: ProviderKind) {
    setDraft({ ...draft, llmMode, provider, models: suggestedModels(llmMode, provider) });
  }

  function toggleConsent(checked: boolean) {
    const key = consentKey(draft);
    const consents = draft.consents.filter((c) => c !== key);
    setDraft({ ...draft, consents: checked ? [...consents, key] : consents });
  }

  async function exportDb() {
    setMessage(null);
    try {
      const bytes = await db.exportFile();
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.sqlite3" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `running-coach-${coach.today()}.db`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMessage({ kind: "error", text: `匯出失敗：${errorText(e)}` });
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
    setMessage(null);
    try {
      // 先停止同步，清除的過程中不會再送出或取回
      if (syncing && keep === "stop") await updateSettings({ ...settings, sync: { ...settings.sync, key: "" } });
      await db.reset();
      resetGettingStarted();
      if (keep === null) clearSettings();
      // 重新載入，讓 Coach 與各頁的狀態（進行中的對話壓縮、未送出的內容）一併回到初始
      location.reload();
    } catch (e) {
      setMessage({ kind: "error", text: `重置失敗：${errorText(e)}` });
    }
  }

  async function importDb(file: File) {
    if (!confirm("匯入會取代這台裝置上目前的所有資料（對話、訓練紀錄、賽事、選手資料），無法復原。確定要繼續嗎？")) return;
    setMessage(null);
    try {
      await db.importFile(new Uint8Array(await file.arrayBuffer()));
      await reload();
      setMessage({ kind: "ok", text: `已匯入 ${file.name}。` });
    } catch (e) {
      setMessage({ kind: "error", text: `匯入失敗：${errorText(e)}` });
    }
  }

  return (
    <>
      <MovedCard />
      <section className="card">
        <h2>AI 模型</h2>
        <div className="row">
          <label className="check">
            <input type="radio" name="mode" checked={draft.llmMode === "byok"} onChange={() => switchLlm("byok", draft.provider)} />
            使用自己的 API key
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
              <input
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
            </label>
            {draft.provider === "openai-compatible" && (
              <label className="wide">
                服務網址
                <input
                  value={draft.baseURL}
                  placeholder="https://example.com/v1"
                  onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })}
                />
              </label>
            )}
          </div>
        ) : (
          <div className="grid">
            <label className="wide">
              代理網址
              <input
                value={draft.proxy.url}
                placeholder="https://"
                onChange={(e) => setDraft({ ...draft, proxy: { ...draft.proxy, url: e.target.value } })}
              />
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
        {!claudeOnly && <p className="muted small">請填入該供應商目前可用的模型 ID；思考強度會對應到 low / medium / high。</p>}

        <div className="notice info">
          <strong>資料會送到哪裡</strong>
          <DataFlow draft={draft} locked={locked} />
          <label className="check">
            <input type="checkbox" checked={consented} onChange={(e) => toggleConsent(e.target.checked)} />
            我了解並同意以上的資料流向
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Intervals.icu</h2>
        {testMode.enabled && <div className="notice info">測試模式中使用假資料，不會連線 Intervals.icu。</div>}
        <p className="small">教練透過 Intervals.icu 讀取你的跑步紀錄：</p>
        <IntervalsGuide where="下方的「API key」欄位" />
        <PhoneGuide />
        <p className="muted small">
          key 只存在這個瀏覽器，活動資料由瀏覽器直接向 Intervals.icu 取得（<PrivacyLink />）。
        </p>
        <div className="grid">
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={draft.intervals.apiKey}
              onChange={(e) => setDraft({ ...draft, intervals: { ...draft.intervals, apiKey: e.target.value } })}
            />
          </label>
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
      </section>

      <div className="row">
        <button
          className="primary"
          disabled={!dirty}
          onClick={async () => {
            try {
              // 時區名稱無效時 Intl 會丟出錯誤，存檔前先擋下
              new Intl.DateTimeFormat("en-US", { timeZone: draft.timeZone });
            } catch {
              setMessage({ kind: "error", text: `時區名稱無效：${draft.timeZone}（例：Asia/Taipei）` });
              return;
            }
            try {
              await updateSettings({ ...draft, sync: settings.sync, weather: settings.weather });
              setMessage({ kind: "ok", text: "設定已儲存在這個瀏覽器。" });
            } catch (e) {
              setMessage({ kind: "error", text: `儲存失敗：${errorText(e)}` });
            }
          }}
        >
          儲存設定
        </button>
        {dirty && <button onClick={() => setDraft(settings)}>放棄變更</button>}
      </div>
      {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
      {(syncNext || sync.message) && (
        <div className="notice info">
          <strong>下一步：抓進你的跑步紀錄</strong>
          {syncNext ? <FirstSync sync={sync} /> : <SyncNotice message={sync.message} />}
        </div>
      )}

      <KeyProtection settings={settings} locked={locked} onChange={setLocked} />

      <WeatherCard />

      <DeviceSyncCard />

      <section className="card">
        <h2>資料</h2>
        <p className="muted small">
          所有對話、訓練紀錄、賽事與選手資料都存在這個瀏覽器
          {db.persistent ? "的本機儲存空間" : "分頁的記憶體（未持久化）"}
          ，不會自動備份。清除網站資料或換裝置前請先匯出。匯出的檔案是標準的 SQLite 資料庫，也可以匯入 v1（Discord 版）的 coach.db。
        </p>
        {db.persistent && <StorageProtectionNote />}
        <div className="row">
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

      <TestModeCard />

      <section className="card">
        <h2>重置</h2>
        {testMode.enabled ? (
          <>
            <p className="muted small">測試模式中只會清除測試資料庫；正式資料與設定不受影響。</p>
            <div className="row">
              <button onClick={() => void reset("stop")}>清除測試資料</button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">方便測試或重新開始。重置會讓新手引導重新出現，而且無法復原；需要的話先匯出資料庫。</p>
            {deviceSync.enabled && (
              <p className="muted small">
                這台開啟了多裝置同步：重置只影響這台，雲端與其他裝置的資料不受影響。只清除資料時，可以選擇停止這台的同步，或從雲端重新取回。
              </p>
            )}
            <div className="row wrap">
              {deviceSync.enabled ? (
                <>
                  <button onClick={() => void reset("stop")}>清除這台並停止同步</button>
                  <button onClick={() => void reset("refetch")}>清除這台，重新從雲端取回</button>
                </>
              ) : (
                <button onClick={() => void reset("stop")}>清除資料，保留設定與 API key</button>
              )}
              <button className="danger" onClick={() => void reset(null)}>
                全部重置
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <Markdown>{status}</Markdown>
      </section>

      <p className="muted small center">
        {BUILD_DETAIL}
        <br />
        Zone2Mate 是自由軟體，以 AGPL-3.0 授權、不附任何擔保。
        <a href={SOURCE_URL} target="_blank" rel="noreferrer">
          原始碼
        </a>
        ・<PrivacyLink />
      </p>
    </>
  );
}
