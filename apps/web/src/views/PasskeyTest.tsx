import { useEffect, useRef, useState } from "react";

import { Check, ChevronLeft, Fingerprint, KeyRound, Smartphone } from "lucide-react";

import {
  attachmentLabel,
  buildReport,
  createLine,
  createPasskey,
  detectEnvironment,
  evaluatePrf,
  getLine,
  loadCredentialId,
  PASSKEY_TEST_NAME,
  prfEnabledLabel,
  saveCredentialId,
  type CreateResult,
  type Environment,
  type Failure,
  type GetResult,
} from "../passkey-test";
import { Disclosure, Icon } from "../ui";
import { VERSION_LABEL } from "../version";

/** 已複製的提示留多久 */
const COPIED_MS = 3000;

const yesNo = (v: boolean | null) => (v === null ? "不知道" : v ? "有" : "沒有");

/** 一列：左邊名稱，右邊結果 */
function Fact({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <li className="passkey-fact">
      <span className="small">{label}</span>
      <span className={ok === undefined ? "" : ok ? "status ok" : "status"}>{value}</span>
    </li>
  );
}

/**
 * passkey（PRF）的測試頁（規格 12.44）：只在 staging 與開發用的建置出現，從設定最下面或網址 #passkey-test 打開。
 * 不開資料庫、不連伺服器；按鈕按下去的同一個動作裡就呼叫 WebAuthn（iOS 的 Safari 不能先 await 別的東西）。
 */
export function PasskeyTestView() {
  const [env, setEnv] = useState<Environment | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(loadCredentialId);
  const [create, setCreate] = useState<(CreateResult | Failure) | null>(null);
  const [gets, setGets] = useState<(GetResult | Failure)[]>([]);
  const [busy, setBusy] = useState<"create" | "get" | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void detectEnvironment().then(setEnv);
    return () => window.clearTimeout(copiedTimer.current);
  }, []);

  const webauthn = env?.webauthn ?? (typeof PublicKeyCredential !== "undefined");

  function onCreate() {
    setBusy("create");
    // 第一個 await 之前就呼叫（在 createPasskey 裡）
    void createPasskey().then((r) => {
      setCreate(r);
      if (r.ok) {
        setCredentialId(r.credentialId);
        saveCredentialId(r.credentialId);
      }
      setBusy(null);
    });
  }

  function onGet(pick: boolean) {
    setBusy("get");
    void evaluatePrf(pick ? null : credentialId, credentialId).then((r) => {
      setGets((list) => [...list, r]);
      setBusy(null);
    });
  }

  function forget() {
    saveCredentialId(null);
    setCredentialId(null);
  }

  const report = buildReport({ version: VERSION_LABEL, at: new Date(), env, create, gets });

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      // 沒有剪貼簿的權限：選起來讓使用者自己複製
      const area = document.getElementById("passkey-report") as HTMLTextAreaElement | null;
      area?.closest("details")?.setAttribute("open", "");
      area?.select();
      return;
    }
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }

  const prev: (string | null)[] = [];
  const getRows = gets.map((g, i) => {
    const line = getLine(g, prev);
    prev.push(g.ok ? g.fingerprint : null);
    return { n: i + 1, line, ok: g.ok && !!g.fingerprint };
  });

  return (
    <main className="page passkey-test">
      <div className="stack passkey-column">
        <div className="subpage-head">
          <button className="back-button" onClick={() => location.assign(location.pathname + location.search)}>
            <Icon as={ChevronLeft} />
            回到 App
          </button>
        </div>
        <h1 className="title">passkey 測試</h1>
        <p className="small muted">只在這個瀏覽器裡測，不連伺服器、不碰你的資料。</p>

        <section className="card" data-part="device">
          <h2>
            <Icon as={Smartphone} />
            這台裝置
          </h2>
          <ul className="passkey-facts">
            <Fact label="系統與瀏覽器" value={env?.platform ?? "讀取中…"} />
            <Fact label="WebAuthn" value={yesNo(env ? env.webauthn : null)} ok={env ? env.webauthn : undefined} />
            <Fact label="內建的驗證器" value={yesNo(env?.platformAuthenticator ?? null)} ok={env?.platformAuthenticator ?? undefined} />
            {env?.capabilities === null ? (
              <Fact label="瀏覽器回報的能力" value="瀏覽器沒有回報" />
            ) : (
              env &&
              Object.entries(env.capabilities).map(([k, v]) => <Fact key={k} label={k} value={v ? "有" : "沒有"} ok={v} />)
            )}
          </ul>
        </section>

        <section className="card" data-part="create">
          <h2>
            <Icon as={KeyRound} />
            1. 建立 passkey
          </h2>
          <p className="small">名稱是「{PASSKEY_TEST_NAME}」，會存進這台的密碼管理工具。</p>
          {!webauthn && <div className="notice warn">這個瀏覽器不支援 passkey。</div>}
          <div className="actions">
            <button className="primary" disabled={!webauthn || busy !== null} onClick={onCreate}>
              {busy === "create" ? "建立中…" : "建立"}
            </button>
            {credentialId && (
              <button className="text" disabled={busy !== null} onClick={forget}>
                忘記這把
              </button>
            )}
          </div>
          {create && (
            <ul className="passkey-facts" data-result="create">
              {create.ok ? (
                <>
                  <Fact label="建立" value="成功" ok />
                  <Fact label="PRF" value={prfEnabledLabel(create.prfEnabled)} ok={create.prfEnabled === true} />
                  <Fact label="驗證器" value={attachmentLabel(create.attachment)} />
                </>
              ) : (
                <li className="field-error">{createLine(create)}</li>
              )}
            </ul>
          )}
          {!create && credentialId && <p className="small muted">這台已經建過一把，可以直接算。</p>}
        </section>

        <section className="card" data-part="get">
          <h2>
            <Icon as={Fingerprint} />
            2. 用 passkey 算
          </h2>
          <p className="small">算兩次，指紋一樣才表示拿得到固定的鑰匙。</p>
          <div className="actions">
            <button className="primary" disabled={!webauthn || busy !== null} onClick={() => onGet(false)}>
              {busy === "get" ? "等待中…" : "算一次"}
            </button>
            {credentialId && (
              <button className="text" disabled={!webauthn || busy !== null} onClick={() => onGet(true)}>
                自己選 passkey
              </button>
            )}
          </div>
          {!credentialId && <p className="small muted">這台沒有記下測試的 passkey：會讓你自己選，例如同步過來的、或用手機掃 QR。</p>}
          {getRows.length > 0 && (
            <ol className="passkey-gets" data-result="get">
              {getRows.map((r) => (
                <li key={r.n} className={r.ok ? "" : "muted"}>
                  {r.ok && <Icon as={Check} size={14} />}
                  <span>
                    第 {r.n} 次：{r.line}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="card" data-part="report">
          <h2>3. 把結果貼回來</h2>
          <p className="small">不含 passkey 的 id 與算出來的值，只有指紋。</p>
          <div className="actions">
            <button className="primary" onClick={() => void copy()}>
              {copied ? "已複製" : "複製結果"}
            </button>
          </div>
          <Disclosure summary="細節">
            <textarea id="passkey-report" className="passkey-report" readOnly rows={8} value={report} />
          </Disclosure>
        </section>

        <Disclosure summary="測完之後">
          <ul className="small passkey-notes">
            <li>到密碼管理工具刪掉「{PASSKEY_TEST_NAME}」：iPhone 是「設定 → 密碼」，Android 是「Google 密碼管理工具」。</li>
            <li>在電腦上按「自己選 passkey」，選「使用手機或平板」掃 QR，可以測手機的 passkey 經 QR 拿不拿得到。</li>
            <li>staging 建的 passkey 只能在 staging 用。</li>
          </ul>
        </Disclosure>
      </div>
    </main>
  );
}
