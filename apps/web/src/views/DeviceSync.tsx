import { useEffect, useRef, useState } from "react";

import QRCode from "qrcode";

import {
  deriveKeys,
  fromBase64url,
  newPairKey,
  newRootKey,
  openRoot,
  pairSecrets,
  parseRecoveryCode,
  recoveryCode,
  sealRoot,
  SyncEngine,
  toBase64url,
  type PairKey,
  type PairSecrets,
} from "@running-coach/core";

import { errorText, useApp } from "../app-context";

interface Slot {
  newPub: string;
  oldPub: string | null;
  box: string | null;
}

const POLL_MS = 2_000;
const PAIR_TTL_MS = 10 * 60_000;

function timeText(iso: string | null): string {
  if (!iso) return "還沒同步過";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 新裝置：顯示 QR code 與配對碼，等舊裝置傳來加密的同步金鑰 */
function JoinFlow({ onDone, onCancel }: { onDone: (root: Uint8Array) => Promise<void>; onCancel: () => void }) {
  const { deviceSync } = useApp();
  const api = deviceSync.api!;
  const [slot, setSlot] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [box, setBox] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<PairKey | null>(null);
  const secrets = useRef<PairSecrets | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    (async () => {
      key.current = await newPairKey();
      const { slot: code } = await api.request<{ slot: string }>("POST", "/v1/pair", { pub: key.current.pub });
      if (!alive) return;
      setSlot(code);
      const link = `${location.origin}${location.pathname}#pair=${code}`;
      const svg = await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      if (alive) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      const poll = async () => {
        if (!alive) return;
        if (Date.now() - started > PAIR_TTL_MS) {
          setError("配對碼已經過期，請重新開始。");
          return;
        }
        try {
          const s = await api.request<Slot>("GET", `/v1/pair/${code}`);
          if (s.oldPub && !secrets.current) {
            secrets.current = await pairSecrets(key.current!, s.oldPub, key.current!.pub, s.oldPub);
            if (alive) setConfirm(secrets.current.confirm);
          }
          if (s.box) {
            if (alive) setBox(s.box);
            return;
          }
        } catch (e) {
          if (alive) setError(errorText(e));
          return;
        }
        timer = setTimeout(() => void poll(), POLL_MS);
      };
      void poll();
    })().catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api]);

  async function accept() {
    try {
      const root = await openRoot(secrets.current!, box!);
      await api.request("DELETE", `/v1/pair/${slot}`).catch(() => undefined);
      await onDone(root);
    } catch (e) {
      setError(`無法解開另一台傳來的金鑰（${errorText(e)}）。請重新開始。`);
    }
  }

  async function cancel() {
    if (slot) await api.request("DELETE", `/v1/pair/${slot}`).catch(() => undefined);
    onCancel();
  }

  return (
    <div className="pairing">
      <ol className="small">
        <li>在已經開啟同步的那台：手機可以直接用相機掃下面的 QR code；電腦的話到「設定 → 多裝置同步 → 新增裝置」輸入配對碼。</li>
        <li>兩台會顯示同一組六位數字，確認一樣後，在那台按「傳送」，再在這台按「加入」。</li>
      </ol>
      {qr && <img className="pair-qr" src={qr} alt={`配對用的 QR code，配對碼 ${slot}`} />}
      {slot && (
        <p>
          配對碼：<strong className="pair-code">{slot.slice(0, 4)}-{slot.slice(4)}</strong>
          <span className="muted small">（10 分鐘內有效）</span>
        </p>
      )}
      {!slot && !error && <p className="muted small">建立配對碼…</p>}
      {confirm && (
        <div className="notice info">
          <span>
            確認數字：<strong className="pair-confirm">{confirm}</strong>
          </span>
          <span className="small">另一台顯示的數字一樣才繼續；不一樣的話按取消。</span>
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
      <div className="row">
        <button className="primary" disabled={!box || !confirm} onClick={() => void accept()}>
          {box ? "數字一樣，加入" : confirm ? "等另一台按傳送…" : "等另一台…"}
        </button>
        <button onClick={() => void cancel()}>取消</button>
      </div>
    </div>
  );
}

/** 舊裝置：輸入或從連結帶入配對碼，確認數字後把加密的同步金鑰傳給新裝置 */
function AddDeviceFlow({ initialCode, onClose }: { initialCode: string; onClose: () => void }) {
  const { deviceSync, settings } = useApp();
  const api = deviceSync.api!;
  const [code, setCode] = useState(initialCode);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secrets = useRef<PairSecrets | null>(null);
  const slot = code.toUpperCase().replace(/[^0-9A-Z]/g, "");

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const s = await api.request<Slot>("GET", `/v1/pair/${slot}`);
      const mine = await newPairKey();
      await api.request("POST", `/v1/pair/${slot}/hello`, { pub: mine.pub });
      secrets.current = await pairSecrets(mine, s.newPub, s.newPub, mine.pub);
      setConfirm(secrets.current.confirm);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // 從連結打開時直接開始
  const started = useRef(false);
  useEffect(() => {
    if (initialCode && !started.current) {
      started.current = true;
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  async function send() {
    setBusy(true);
    try {
      await api.request("POST", `/v1/pair/${slot}/box`, { box: await sealRoot(secrets.current!, fromBase64url(settings.sync.key)) });
      setSent(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pairing">
      {!confirm && (
        <>
          <label>
            新裝置上顯示的配對碼
            <input value={code} placeholder="例：K7P2-9QX4" autoCapitalize="characters" onChange={(e) => setCode(e.target.value)} />
          </label>
          <div className="row">
            <button className="primary" disabled={busy || slot.length !== 8} onClick={() => void start()}>
              {busy ? "連線中…" : "下一步"}
            </button>
            <button onClick={onClose}>取消</button>
          </div>
        </>
      )}
      {confirm && !sent && (
        <>
          <div className="notice info">
            <span>
              確認數字：<strong className="pair-confirm">{confirm}</strong>
            </span>
            <span className="small">新裝置上顯示的數字一樣才傳送；不一樣的話按取消，可能有人用了這組配對碼。</span>
          </div>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void send()}>
              一樣，傳送
            </button>
            <button onClick={onClose}>取消</button>
          </div>
        </>
      )}
      {sent && (
        <div className="notice ok">
          <span>已傳送。在新裝置上按「加入」，它就會取回所有資料。</span>
          <button className="link" onClick={onClose}>
            完成
          </button>
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}

/** 設定頁的多裝置同步（規格 12.10） */
export function DeviceSyncCard() {
  const { settings, updateSettings, deviceSync, testMode, pairFromLink, clearPairFromLink, coach } = useApp();
  const [mode, setMode] = useState<"idle" | "start" | "join" | "add" | "restore" | "showCode">("idle");
  const [linkCode, setLinkCode] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [newRoot, setNewRoot] = useState<Uint8Array | null>(null);
  const [saved, setSaved] = useState(false);
  const [restoreText, setRestoreText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "warn"; text: string } | null>(null);
  const card = useRef<HTMLElement>(null);

  // 從配對連結打開（或在開著的分頁貼上連結）：直接進入「新增裝置」
  useEffect(() => {
    if (!pairFromLink) return;
    setLinkCode(pairFromLink);
    setMode("add");
    clearPairFromLink();
    card.current?.scrollIntoView({ block: "start" });
  }, [pairFromLink, clearPairFromLink]);

  const saveKey = (root: Uint8Array | null) => updateSettings({ ...settings, sync: { ...settings.sync, key: root ? toBase64url(root) : "" } });

  async function begin() {
    setBusy(true);
    setMessage(null);
    try {
      const root = newRootKey();
      await new SyncEngine(coach.db, deviceSync.api!, root).ensureSpace();
      setNewRoot(root);
      setCode(await recoveryCode(root));
      setMode("start");
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setBusy(true);
    setMessage(null);
    try {
      const root = await parseRecoveryCode(restoreText);
      if (!root) throw new Error("復原碼不對：請檢查有沒有少字或打錯。");
      const keys = await deriveKeys(root);
      // 先確認雲端有這組資料，不要用打錯的碼建立一個空的同步空間
      await deviceSync.api!.request("GET", `/v1/spaces/${keys.space}/changes?since=0&limit=1`, undefined, keys.token).catch((e: { status?: number }) => {
        throw new Error(e.status === 404 ? "雲端找不到這組復原碼的資料（可能已經刪除）。" : errorText(e));
      });
      await saveKey(root);
      setMode("idle");
      setMessage({ kind: "ok", text: "已還原，正在取回資料…" });
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function stopHere() {
    if (!confirm("停止這台的同步？這台的資料保留，雲端與其他裝置不受影響；之後可以用配對或復原碼再加入。")) return;
    await deviceSync.engine?.forget();
    await saveKey(null);
    setMode("idle");
    setMessage({ kind: "ok", text: "這台已停止同步。" });
  }

  async function deleteRemote() {
    if (!confirm("刪除雲端的同步資料？每台裝置上的資料都保留，但其他裝置之後會同步失敗，要在那些裝置停止同步。這個動作無法復原。")) return;
    setBusy(true);
    try {
      await deviceSync.engine?.deleteRemote();
      await saveKey(null);
      setMode("idle");
      setMessage({ kind: "ok", text: "雲端的同步資料已刪除。其他裝置請到設定頁停止同步。" });
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function showCode() {
    setCode(await recoveryCode(fromBase64url(settings.sync.key)));
    setMode("showCode");
  }

  let body;
  if (testMode.enabled) {
    body = <p className="muted small">測試模式使用另一個資料庫，不同步。</p>;
  } else if (!deviceSync.available) {
    body = <p className="muted small">同步服務還沒設定好。部署之後，這裡就可以開始同步。</p>;
  } else if (mode === "start" && newRoot) {
    body = (
      <div className="pairing">
        <p>
          這是你的<strong>復原碼</strong>。所有裝置都不見時，只能靠它取回同步的資料；連我們也沒有辦法幫你找回。請截圖、印出來，或存進密碼管理器。
        </p>
        <code className="recovery-code">{code}</code>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          我已經把復原碼存好了
        </label>
        <div className="row">
          <button
            className="primary"
            disabled={!saved}
            onClick={() =>
              void saveKey(newRoot).then(() => {
                setMode("idle");
                setNewRoot(null);
                setMessage({ kind: "ok", text: "已開啟同步。要加入另一台時，在那台按「加入已經在同步的裝置」。" });
              })
            }
          >
            開始同步
          </button>
        </div>
      </div>
    );
  } else if (mode === "join") {
    body = (
      <JoinFlow
        onDone={async (root) => {
          await saveKey(root);
          setMode("idle");
          setMessage({ kind: "ok", text: "已加入，正在取回資料…" });
        }}
        onCancel={() => setMode("idle")}
      />
    );
  } else if (mode === "restore") {
    body = (
      <div className="pairing">
        <label>
          復原碼
          <textarea rows={3} value={restoreText} placeholder="例：ABCD-EFGH-…" onChange={(e) => setRestoreText(e.target.value)} />
        </label>
        <div className="row">
          <button className="primary" disabled={busy || !restoreText.trim()} onClick={() => void restore()}>
            {busy ? "確認中…" : "還原"}
          </button>
          <button onClick={() => setMode("idle")}>取消</button>
        </div>
      </div>
    );
  } else if (!deviceSync.enabled) {
    body = (
      <>
        {linkCode && mode === "add" && (
          <div className="notice warn">這台還沒開啟同步，無法把同步加到另一台。請用已經在同步的那台掃 QR code。</div>
        )}
        <p className="small">
          在電腦、手機之間同步你的選手資料、賽事、課表、每日自評、和教練的對話，以及跑步的體感與分析。跑步紀錄本身每台各自從 Intervals.icu 抓；API key 不同步，每台各自填。
        </p>
        <p className="muted small">
          資料在這台加密後才送出，同步服務只存加密後的內容，看不到也解不開；解開用的金鑰只在你的裝置上。這台已有的資料會和雲端的合併。
        </p>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void begin()}>
            這是第一台：開始同步
          </button>
          <button onClick={() => setMode("join")}>加入已經在同步的裝置</button>
          <button className="link" onClick={() => setMode("restore")}>
            用復原碼還原
          </button>
        </div>
      </>
    );
  } else {
    const last = deviceSync.last;
    body = (
      <>
        <p>
          <span className="badge achieved">已開啟</span> 上次同步：{timeText(deviceSync.lastAt)}
          {last && (
            <span className="muted small">
              （收到 {last.received}、送出 {last.sent}
              {last.pending ? `；${last.pending} 筆等這台同步到對應的跑步` : ""}）
            </span>
          )}
        </p>
        {deviceSync.error && <div className="notice error">同步失敗：{deviceSync.error}</div>}
        {mode === "add" ? (
          <AddDeviceFlow
            key={linkCode}
            initialCode={linkCode}
            onClose={() => {
              setMode("idle");
              setLinkCode("");
            }}
          />
        ) : mode === "showCode" ? (
          <div className="pairing">
            <p className="small">復原碼：所有裝置都不見時用它取回資料。請存在安全的地方，不要傳給別人。</p>
            <code className="recovery-code">{code}</code>
            <div className="row">
              <button onClick={() => setMode("idle")}>收起</button>
            </div>
          </div>
        ) : (
          <div className="row wrap">
            <button disabled={deviceSync.busy} onClick={() => void deviceSync.run()}>
              {deviceSync.busy ? "同步中…" : "立即同步"}
            </button>
            <button onClick={() => setMode("add")}>新增裝置</button>
            <button onClick={() => void showCode()}>顯示復原碼</button>
            <button className="link" onClick={() => void stopHere()}>
              停止這台的同步
            </button>
            <button className="link danger" disabled={busy} onClick={() => void deleteRemote()}>
              刪除雲端的資料
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <section className="card" ref={card}>
      <h2>多裝置同步</h2>
      {body}
      {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
    </section>
  );
}
