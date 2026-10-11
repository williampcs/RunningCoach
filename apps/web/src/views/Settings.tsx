import { useEffect, useState } from "react";

import { formatStatus, type Effort, type Purpose } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { Markdown } from "../Markdown";
import {
  consentKey,
  PROVIDER_LABELS,
  PROVIDER_RECIPIENT,
  suggestedModels,
  type AppSettings,
  type ProviderKind,
} from "../settings";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const MODEL_LABELS: Record<Purpose, string> = { chat: "主對話", summary: "跑後摘要", compress: "對話壓縮" };

/** 目前選擇下，資料會送到哪裡 */
function DataFlow({ draft }: { draft: AppSettings }) {
  if (draft.llmMode === "proxy") {
    return (
      <ul>
        <li>你的對話、選手資料與訓練紀錄會經過 Running Coach 的代理伺服器，轉送給 Anthropic 產生回覆。</li>
        <li>代理只在記憶體中轉發，不儲存內容；會記錄的只有帳號識別、訂閱狀態與 token 用量。</li>
        <li>Anthropic 如何保存與使用這些資料，依它的 API 條款而定，Running Coach 無法替它保證。</li>
      </ul>
    );
  }
  const recipient = PROVIDER_RECIPIENT[draft.provider];
  return (
    <ul>
      <li>
        你的對話、選手資料與訓練紀錄會從這個瀏覽器直接送到 {recipient}，不經過 Running Coach 的任何伺服器。
      </li>
      <li>{recipient} 如何保存與使用這些資料，依它的 API 條款而定，Running Coach 無法替它保證。</li>
      <li>API key 以明文存在這個瀏覽器；能操作這台裝置的人都讀得到，請勿在共用電腦上使用。</li>
    </ul>
  );
}

export function SettingsView() {
  const { coach, db, settings, updateSettings, revision, reload } = useApp();
  const [draft, setDraft] = useState(settings);
  const [status, setStatus] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    void coach.status().then((s) => setStatus(formatStatus(s, coach.describeModels(), coach.settings)));
  }, [coach, revision]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
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
          <DataFlow draft={draft} />
          <label className="check">
            <input type="checkbox" checked={consented} onChange={(e) => toggleConsent(e.target.checked)} />
            我了解並同意以上的資料流向
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Intervals.icu</h2>
        <p className="muted small">
          在 intervals.icu 的 Settings → Developer Settings 取得 API key。key 只存在這個瀏覽器，活動資料由瀏覽器直接向 Intervals.icu 取得。
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
          onClick={() => {
            try {
              // 時區名稱無效時 Intl 會丟出錯誤，存檔前先擋下
              new Intl.DateTimeFormat("en-US", { timeZone: draft.timeZone });
            } catch {
              setMessage({ kind: "error", text: `時區名稱無效：${draft.timeZone}（例：Asia/Taipei）` });
              return;
            }
            updateSettings(draft);
            setMessage({ kind: "ok", text: "設定已儲存在這個瀏覽器。" });
          }}
        >
          儲存設定
        </button>
        {dirty && <button onClick={() => setDraft(settings)}>放棄變更</button>}
      </div>
      {message && <div className={`notice ${message.kind}`}>{message.text}</div>}

      <section className="card">
        <h2>資料</h2>
        <p className="muted small">
          所有對話、訓練紀錄、賽事與選手資料都存在這個瀏覽器
          {db.persistent ? "的本機儲存空間" : "分頁的記憶體（未持久化）"}
          ，不會自動備份。清除網站資料或換裝置前請先匯出。匯出的檔案是標準的 SQLite 資料庫，也可以匯入 v1（Discord 版）的 coach.db。
        </p>
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

      <section className="card">
        <Markdown>{status}</Markdown>
      </section>
    </>
  );
}
