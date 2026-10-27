import { useEffect, useRef, useState } from "react";

import QRCode from "qrcode";

import {
  deriveKeys,
  fromBase64url,
  newPairKey,
  newPairNonce,
  newRootKey,
  openRoot,
  pairCommitment,
  pairFingerprint,
  pairSecrets,
  parseRecoveryCode,
  recoveryCode,
  sealRoot,
  SyncApiError,
  SyncCooldownError,
  SyncEngine,
  toBase64url,
  type PairSecrets,
  type SyncDevice,
  type SyncDevices,
} from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { defaultDeviceLabel, deleteDeviceIdentity, loadDeviceIdentity } from "../device-identity";
import { checkPassword, lockEnabled } from "../settings";
import { clearRemoved, deviceName, deviceTime, removedHere } from "./DeviceAlerts";
import { PrivacyLink } from "./PrivacyLink";

interface Slot {
  newPub: string;
  commitment: string;
  oldPub: string | null;
  nonce: string | null;
  box: string | null;
}

const POLL_MS = 2_000;
const PAIR_TTL_MS = 10 * 60_000;
/** 舊裝置送出公開金鑰後，等新裝置回應多久 */
const HELLO_WAIT_MS = 60_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function timeText(iso: string | null): string {
  if (!iso) return "還沒同步過";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * 新裝置：顯示 QR code 與配對碼，等舊裝置的公開金鑰；收到後才公開亂數（規格 12.10 的配對），
 * 顯示確認數字讓使用者在舊裝置輸入，再等舊裝置傳來加密的同步金鑰
 */
function JoinFlow({ onDone, onCancel }: { onDone: (root: Uint8Array) => Promise<void>; onCancel: () => void }) {
  const { deviceSync } = useApp();
  const api = deviceSync.api!;
  const [slot, setSlot] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [box, setBox] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const secrets = useRef<PairSecrets | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    (async () => {
      const key = await newPairKey();
      const nonce = newPairNonce();
      const commitment = await pairCommitment(nonce);
      const { slot: code } = await api.request<{ slot: string }>("POST", "/v1/pair", { pub: key.pub, commitment });
      if (!alive) return;
      setSlot(code);
      const link = `${location.origin}${location.pathname}#pair=${code}.${await pairFingerprint(key.pub, commitment)}`;
      const svg = await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      if (alive) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      let oldPub: string | null = null;
      const poll = async () => {
        if (!alive) return;
        if (Date.now() - started > PAIR_TTL_MS) {
          setError("配對碼已經過期，請重新開始。");
          return;
        }
        try {
          const s = await api.request<Slot>("GET", `/v1/pair/${code}`);
          // 只用第一次收到的公開金鑰；之後被換掉就整個作廢
          if (oldPub !== null && s.oldPub !== oldPub) throw new Error("配對的資料被改過，請重新開始。");
          if (s.oldPub && !secrets.current) {
            oldPub = s.oldPub;
            secrets.current = await pairSecrets(key, s.oldPub, key.pub, s.oldPub, nonce);
            await api.request("POST", `/v1/pair/${code}/nonce`, { nonce });
            if (alive) setConfirm(secrets.current.confirm);
          }
          if (s.box && secrets.current) {
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
        <li>這裡會顯示一組六位數字，在那台輸入。那台顯示「已傳送」之後，再在這台按「加入」。</li>
      </ol>
      {qr && !confirm && <img className="pair-qr" src={qr} alt={`配對用的 QR code，配對碼 ${slot}`} />}
      {slot && !confirm && (
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
          <span className="small">在另一台輸入這組數字。另一台顯示「已傳送」之後才按「加入」；另一台說數字不對的話，按取消。</span>
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
      <div className="row">
        <button className="primary" disabled={!box || !confirm || Boolean(error)} onClick={() => void accept()}>
          {box ? "另一台已傳送，加入" : confirm ? "等另一台輸入數字…" : "等另一台…"}
        </button>
        <button onClick={() => void cancel()}>取消</button>
      </div>
    </div>
  );
}

/** 配對碼與 QR code 帶的指紋（手動輸入時沒有指紋） */
function parsePairCode(text: string): { slot: string; fingerprint: string | null } {
  const [code = "", fingerprint] = text.trim().split(".");
  return { slot: code.toUpperCase().replace(/[^0-9A-Z]/g, ""), fingerprint: fingerprint ?? null };
}

/**
 * 顯示中的復原碼與配對碼的輸入畫面：多久後自動收起（規格 12.26 的後續）. 切到別的 App 時視窗沒有隱藏，
 * 不會觸發 visibilitychange，所以加上時間的限制；E2E 可以用 window.__zone2mateAutoHideSeconds 縮短
 */
const AUTO_HIDE_SECONDS = 60;
const autoHideSeconds = () => {
  const override = (globalThis as { __zone2mateAutoHideSeconds?: unknown }).__zone2mateAutoHideSeconds;
  return typeof override === "number" && override > 0 ? override : AUTO_HIDE_SECONDS;
};

/** 倒數；active 時從頭開始，到 0 時呼叫 onExpire。restart 讓使用者「再顯示一分鐘」 */
function useAutoHide(active: boolean, onExpire: () => void): { left: number; restart: () => void } {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const expire = useRef(onExpire);
  expire.current = onExpire;
  useEffect(() => {
    setDeadline(active ? Date.now() + autoHideSeconds() * 1000 : null);
  }, [active]);
  useEffect(() => {
    if (deadline === null) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= deadline) {
        setDeadline(null);
        expire.current();
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [deadline]);
  return {
    left: deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000)),
    restart: () => setDeadline(Date.now() + autoHideSeconds() * 1000),
  };
}

/** 「N 秒後收起」與「再顯示一分鐘」（不用再確認） */
function AutoHideNote({ left, restart }: { left: number; restart: () => void }) {
  return (
    <p className="small muted auto-hide" role="timer" aria-live="off">
      <span className="auto-hide-left">{left} 秒後收起</span>{" "}
      <button type="button" className="link" onClick={restart}>
        再顯示一分鐘
      </button>
    </p>
  );
}

/** 舊裝置：輸入或從連結帶入配對碼，輸入新裝置上顯示的數字，相符才把加密的同步金鑰傳給新裝置 */
function AddDeviceFlow({ initialCode, onClose }: { initialCode: string; onClose: () => void }) {
  const { deviceSync, settings } = useApp();
  const api = deviceSync.api!;
  const fromLink = Boolean(initialCode);
  const [code, setCode] = useState(initialCode);
  const [ready, setReady] = useState(false);
  const [typed, setTyped] = useState("");
  const [tries, setTries] = useState(0);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secrets = useRef<PairSecrets | null>(null);
  const { slot, fingerprint } = parsePairCode(code);
  // 輸入配對碼的畫面一段時間後收起；配對進行中（等新裝置、輸入數字、已傳送）不收起
  const autoHide = useAutoHide(!busy && !ready && !sent, onClose);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      // 新裝置的公開金鑰與承諾只讀這一次
      const first = await api.request<Slot>("GET", `/v1/pair/${slot}`);
      if (fingerprint && (await pairFingerprint(first.newPub, first.commitment)) !== fingerprint) {
        throw new Error("配對的資料和 QR code 不符，可能被改過。已停止配對。");
      }
      const mine = await newPairKey();
      await api.request("POST", `/v1/pair/${slot}/hello`, { pub: mine.pub });
      // 等新裝置公開亂數，確認和一開始的承諾相符
      const until = Date.now() + HELLO_WAIT_MS;
      let nonce: string | null = null;
      while (!nonce) {
        if (Date.now() > until) throw new Error("新裝置沒有回應。請確認那台還開著配對畫面，再重新開始。");
        await wait(POLL_MS);
        const s = await api.request<Slot>("GET", `/v1/pair/${slot}`);
        if (s.newPub !== first.newPub || s.commitment !== first.commitment || s.oldPub !== mine.pub) {
          throw new Error("配對的資料被改過。已停止配對。");
        }
        nonce = s.nonce;
      }
      if ((await pairCommitment(nonce)) !== first.commitment) throw new Error("配對的資料被改過。已停止配對。");
      secrets.current = await pairSecrets(mine, first.newPub, first.newPub, mine.pub, nonce);
      setReady(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const digits = typed.replace(/\D/g, "");
    if (`${digits.slice(0, 3)} ${digits.slice(3)}` !== secrets.current!.confirm) {
      const next = tries + 1;
      setTries(next);
      setError(
        next >= 3
          ? "數字還是不一樣，已停止配對。如果你確定輸入的是新裝置上的數字，可能有人在中間攔截，請不要繼續。"
          : "數字不一樣。請再看一次新裝置上的數字；如果確定沒有看錯，按取消，可能有人在中間攔截。",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.request("POST", `/v1/pair/${slot}/box`, { box: await sealRoot(secrets.current!, fromBase64url(settings.sync.key)) });
      setSent(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const stopped = tries >= 3;
  return (
    <div className="pairing">
      {!ready && (
        <>
          {fromLink ? (
            <div className="notice warn">
              <span>
                你打開了一個配對連結。<strong>只有在你自己的另一台裝置正顯示這個 QR code 時才繼續</strong>
                ：別人傳給你的連結，繼續的話會讓對方取得你所有的同步資料。
              </span>
            </div>
          ) : (
            <label>
              新裝置上顯示的配對碼
              <input value={code} placeholder="例：K7P2-9QX4" autoCapitalize="characters" onChange={(e) => setCode(e.target.value)} />
            </label>
          )}
          <div className="row">
            <button className="primary" disabled={busy || slot.length !== 8} onClick={() => void start()}>
              {busy ? "等新裝置回應…" : fromLink ? "是我的裝置，繼續" : "下一步"}
            </button>
            <button onClick={onClose}>取消</button>
          </div>
          {!busy && <AutoHideNote {...autoHide} />}
        </>
      )}
      {ready && !sent && (
        <>
          <label>
            新裝置上顯示的六位數字
            <input
              value={typed}
              inputMode="numeric"
              autoComplete="off"
              placeholder="例：482 913"
              disabled={stopped}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          <div className="row">
            <button className="primary" disabled={busy || stopped || typed.replace(/\D/g, "").length !== 6} onClick={() => void send()}>
              傳送
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

type ConfirmPurpose = "code" | "add" | "remove" | "rekey";

const CONFIRM_TEXT: Record<ConfirmPurpose, { password: string; wrong: string; noLock: string; go: string; then: string }> = {
  code: {
    password: "再輸入一次密碼鎖的密碼，才顯示復原碼",
    wrong: "不顯示復原碼",
    noLock: "這台沒有設定密碼鎖，拿到這台的人都能看到復原碼。",
    go: "我了解，顯示",
    then: "顯示復原碼",
  },
  add: {
    password: "再輸入一次密碼鎖的密碼，才開始配對",
    wrong: "不能新增裝置",
    noLock: "這台沒有設定密碼鎖，拿到這台的人都能把同步加到他的裝置。",
    go: "我了解，繼續",
    then: "新增裝置",
  },
  remove: {
    password: "再輸入一次密碼鎖的密碼，才移除",
    wrong: "不移除",
    noLock: "這台沒有設定密碼鎖，拿到這台的人都能移除你的其他裝置。",
    go: "移除並換金鑰",
    then: "移除裝置",
  },
  rekey: {
    password: "再輸入一次密碼鎖的密碼，才換金鑰",
    wrong: "不換金鑰",
    noLock: "這台沒有設定密碼鎖，拿到這台的人都能換掉同步金鑰。",
    go: "換金鑰",
    then: "換金鑰",
  },
};

/**
 * 顯示復原碼、新增裝置、移除裝置、換金鑰前再確認身分（規格 12.26、12.27）：開了密碼鎖要再輸入一次密碼；
 * 沒開的先說明風險、建議開密碼鎖，按確認才繼續
 */
function ConfirmIdentity({
  purpose,
  risk: customRisk,
  onConfirmed,
  onCancel,
}: {
  purpose: ConfirmPurpose;
  risk?: string;
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const locked = lockEnabled();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = CONFIRM_TEXT[purpose];
  const risk =
    customRisk ??
    (purpose === "code"
      ? "看得到復原碼的人可以在他的裝置還原，之後一直同步到你的資料。"
      : "把同步加到另一台後，那台會一直同步到你的資料。只有在你自己的另一台裝置正顯示配對碼時才繼續。");

  async function check() {
    setBusy(true);
    setError(null);
    try {
      if (await checkPassword(password)) onConfirmed();
      else setError(`密碼不正確，${text.wrong}。`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pairing confirm-identity">
      <p className="small">{risk}</p>
      {locked ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password && !busy) void check();
          }}
        >
          <label>
            {text.password}
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <div className="row">
            <button className="primary" type="submit" disabled={busy || !password}>
              {busy ? "確認中…" : "確認"}
            </button>
            <button type="button" onClick={onCancel}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="notice warn">
            <span>
              {text.noLock}
              建議先到上面的「保護 API key」設定密碼鎖，之後{text.then}前要輸入密碼。
            </span>
          </div>
          <div className="row">
            <button className="primary" onClick={onConfirmed}>
              {text.go}
            </button>
            <button onClick={onCancel}>取消</button>
          </div>
        </>
      )}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}

/** 冷卻期還剩多久，例：「3 小時 20 分」 */
function waitText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} 小時${minutes % 60 ? ` ${minutes % 60} 分` : ""}` : `${minutes} 分`;
}

/** 還在冷卻期時的剩餘時間（毫秒）；沒有限制時是 0 */
function cooldownLeft(devices: SyncDevices | null): number {
  return devices ? Math.max(0, devices.cooldownUntil - devices.serverTime) : 0;
}

/**
 * 裝置清單（規格 12.27）：每台的名稱、加入與最後同步的時間、「這台」；改名、移除、換金鑰.
 * 最後同步的時間是伺服器記的，不靠各台自己寫
 */
function DeviceList({
  devices,
  busy,
  onRemove,
  onRekey,
}: {
  devices: SyncDevices;
  busy: boolean;
  onRemove: (device: SyncDevice) => void;
  onRekey: () => void;
}) {
  const { deviceSync } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const wait = cooldownLeft(devices);
  const fresh = new Set(deviceSync.newDevices.map((d) => d.id));

  async function rename(device: SyncDevice) {
    setError(null);
    try {
      deviceSync.setDevices(
        await deviceSync.engine!.renameDevice(device.id, { name: name.trim() || defaultDeviceLabel().name, platform: device.label?.platform ?? "" }),
      );
      setEditing(null);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="device-list">
      <h3>已同步的裝置</h3>
      <ul>
        {devices.devices.map((d) => (
          <li key={d.id} className={fresh.has(d.id) ? "device fresh" : "device"} data-device={d.id}>
            {editing === d.id ? (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void rename(d);
                }}
              >
                <input aria-label="裝置名稱" value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} />
                <button className="primary" type="submit">
                  儲存
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  取消
                </button>
              </form>
            ) : (
              <div className="device-head">
                <strong className="device-name">{deviceName(d)}</strong>
                {d.self && <span className="badge achieved">這台</span>}
                {fresh.has(d.id) && <span className="badge warn">新加入</span>}
              </div>
            )}
            <div className="small muted">
              {d.legacy ? "升級前就在同步" : `加入 ${deviceTime(d.joinedAt)}`} · 最後同步 {deviceTime(d.lastSeenAt)}
            </div>
            {!d.label && <div className="small muted">這台的資料解不開（可能被改過）。換金鑰時會一起移除。</div>}
            {editing !== d.id && (
              <div className="row">
                {d.label && (
                  <button
                    className="link"
                    onClick={() => {
                      setName(d.label?.name ?? "");
                      setEditing(d.id);
                    }}
                  >
                    改名
                  </button>
                )}
                {!d.self && (
                  <button className="link danger" disabled={busy || wait > 0} onClick={() => onRemove(d)}>
                    移除
                  </button>
                )}
                {fresh.has(d.id) && (
                  <button className="link" onClick={() => deviceSync.acknowledge([d.id])}>
                    是我的
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <div className="notice error">{error}</div>}
      {wait > 0 && (
        <p className="small notice info cooldown-note">
          這台加入還不到 24 小時，{waitText(wait)}後才能移除別台或換金鑰。這是為了防止拿到復原碼的人加入後馬上把你的裝置移除：你原本的裝置可以先移除它，它卻不能先移除你。
        </p>
      )}
      <p className="small muted">
        移除某台時會換一把新的同步金鑰與復原碼：留下的裝置下次同步自動換過去，不用重新配對；被移除的那台之後連不上，下次打開時清掉它的同步金鑰與 API key（訓練資料留在那台，由那台的人決定清除或匯出）。已經被下載的資料收不回來。
      </p>
      <div className="row">
        <button disabled={busy || wait > 0} onClick={onRekey}>
          只換金鑰（懷疑復原碼外流）
        </button>
      </div>
    </div>
  );
}

function rekeyError(e: unknown, what: string): string {
  if (e instanceof SyncCooldownError) return `這台加入還不到 24 小時，還不能${what}（${e.until ? `${deviceTime(e.until)} 之後可以` : "請稍後再試"}）。`;
  if (e instanceof SyncApiError && (e.state === "devices_changed" || e.state === "rekey_conflict")) return `${what}失敗：裝置清單剛剛變了（有裝置加入，或另一台也在換金鑰）。請看一下下面最新的清單，再試一次。`;
  return `${what}失敗：${errorText(e)}`;
}

/** 設定頁的多裝置同步（規格 12.10） */
export function DeviceSyncCard() {
  const { settings, updateSettings, deviceSync, testMode, pairFromLink, clearPairFromLink, coach, devicesFocus } = useApp();
  const [mode, setMode] = useState<
    "idle" | "start" | "join" | "confirmAdd" | "add" | "restore" | "confirmCode" | "showCode" | "confirmRemove" | "confirmRekey" | "newCode"
  >("idle");
  /** 要移除的那台（規格 12.27） */
  const [target, setTarget] = useState<SyncDevice | null>(null);
  const [linkCode, setLinkCode] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [newRoot, setNewRoot] = useState<Uint8Array | null>(null);
  const [saved, setSaved] = useState(false);
  const [restoreText, setRestoreText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "warn"; text: string } | null>(null);
  const card = useRef<HTMLElement>(null);

  // 從配對連結打開（或在開著的分頁貼上連結）：直接進入「新增裝置」（一樣先確認身分）
  useEffect(() => {
    if (!pairFromLink) return;
    setLinkCode(pairFromLink);
    setMode("confirmAdd");
    clearPairFromLink();
    card.current?.scrollIntoView({ block: "start" });
  }, [pairFromLink, clearPairFromLink]);

  // 新裝置加入的提醒點了「查看與移除」：捲到這裡
  useEffect(() => {
    if (devicesFocus > 0) card.current?.scrollIntoView({ block: "start" });
  }, [devicesFocus]);

  // 顯示中的復原碼：切到別的分頁、App 到背景就收起，下次要再確認（關閉設定面板時這張卡整個移除）
  useEffect(() => {
    if (mode !== "showCode") return;
    const hide = () => {
      if (document.visibilityState !== "hidden") return;
      setMode("idle");
      setCode(null);
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", hide);
    };
  }, [mode]);

  // 顯示中的復原碼一段時間後也收起（切到別的 App 時視窗沒有隱藏，上面的不會觸發）
  const codeAutoHide = useAutoHide(mode === "showCode", () => {
    setMode("idle");
    setCode(null);
  });

  const saveKey = (root: Uint8Array | null) => updateSettings({ ...settings, sync: { ...settings.sync, key: root ? toBase64url(root) : "" } });

  async function begin() {
    setBusy(true);
    setMessage(null);
    try {
      const root = newRootKey();
      // 裝置模式：新的空間一開始就只接受登記過的裝置，並登記這台
      const device = deviceSync.devicesMode
        ? { identity: await loadDeviceIdentity(), label: () => defaultDeviceLabel(), onRootChanged: async () => undefined }
        : null;
      await new SyncEngine(coach.db, deviceSync.api!, root, undefined, device).ensureSpace();
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
      // （已經是裝置模式的空間回「要用登記過的裝置」也表示存在，這台下次同步時登記）
      await deviceSync.api!.request("GET", `/v1/spaces/${keys.space}/changes?since=0&limit=1`, undefined, keys.token).catch((e: unknown) => {
        if (e instanceof SyncApiError && e.state === "devices_required") return;
        if (e instanceof SyncApiError && e.status === 410) throw new Error("這組復原碼已經換掉了（另一台換過金鑰）。請用新的復原碼，或用配對加入。");
        throw new Error(e instanceof SyncApiError && e.status === 404 ? "雲端找不到這組復原碼的資料（可能已經刪除）。" : errorText(e));
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

  async function stopHere(ask = true) {
    if (ask && !confirm("停止這台的同步？這台的資料保留，雲端與其他裝置不受影響；之後可以用配對或復原碼再加入。")) return;
    // 裝置模式：從裝置清單移除自己，這台的裝置金鑰也刪掉（下次加入是新的裝置）
    if (deviceSync.devicesMode) {
      await deviceSync.engine?.leave();
      await deleteDeviceIdentity();
    } else await deviceSync.engine?.forget();
    await saveKey(null);
    setMode("idle");
    setMessage({ kind: "ok", text: "這台已停止同步。" });
  }

  /** 雲端已經在別台刪除：用這台重新開始（新的金鑰與復原碼），這台的資料會送上去 */
  async function restartHere() {
    await deviceSync.engine?.forget();
    await saveKey(null);
    await begin();
  }

  async function deleteRemote() {
    if (!confirm("刪除雲端的同步資料？每台裝置上的資料都保留，但其他裝置之後會同步失敗，要在那些裝置停止同步。這個動作無法復原。")) return;
    setBusy(true);
    try {
      await deviceSync.engine?.deleteRemote();
      if (deviceSync.devicesMode) await deleteDeviceIdentity();
      await saveKey(null);
      setMode("idle");
      setMessage({ kind: "ok", text: "雲端的同步資料已刪除。其他裝置請到設定頁停止同步。" });
    } catch (e) {
      setMessage({ kind: "error", text: rekeyError(e, "刪除雲端的資料") });
    } finally {
      setBusy(false);
    }
  }

  /** 移除某台並換金鑰，或只換金鑰（規格 12.27）；成功後顯示新的復原碼 */
  async function rekey(remove: SyncDevice | null) {
    setBusy(true);
    setMode("idle");
    setMessage(null);
    try {
      // 使用者確認時看到的清單：換金鑰時的清單和它不同就停止，請使用者重新確認
      const root = await deviceSync.engine!.rekey(remove ? [remove.id] : [], deviceSync.devices?.devices.map((d) => d.id));
      setCode(await recoveryCode(root));
      setSaved(false);
      setMode("newCode");
      void deviceSync.run();
    } catch (e) {
      setMode("idle");
      setMessage({ kind: "error", text: rekeyError(e, remove ? "移除" : "換金鑰") });
      // 清單變了：重新取一次，讓使用者看到現在有哪些裝置再決定
      void deviceSync.run();
    } finally {
      setBusy(false);
      setTarget(null);
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
                // 被移除的這台用自己的資料重新開始：不再顯示「已移除」
                clearRemoved();
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
  } else if (deviceSync.enabled && deviceSync.gone) {
    body = (
      <>
        <div className="notice warn">
          <span>
            <strong>雲端的同步資料已經在另一台刪除。</strong>這台的資料都還在，只是不再同步；舊的復原碼也不能用了。
          </span>
        </div>
        <p className="small">
          要繼續同步的話，用這台重新開始：會產生新的同步金鑰與復原碼，這台的資料送上去之後，其他裝置再用配對加入（加入前先在那台停止同步）。
        </p>
        <div className="row wrap">
          <button className="primary" disabled={busy} onClick={() => void restartHere()}>
            用這台重新開始同步
          </button>
          <button onClick={() => void stopHere(false)}>停止這台的同步</button>
        </div>
      </>
    );
  } else if (!deviceSync.enabled) {
    body = (
      <>
        {linkCode && (mode === "add" || mode === "confirmAdd") && (
          <div className="notice warn">這台還沒開啟同步，無法把同步加到另一台。請用已經在同步的那台掃 QR code。</div>
        )}
        {removedHere() && (
          <div className="notice warn removed-note">
            <span>
              這台已經被你的另一台從同步移除，這台的資料還在。如果不是你移除的，你的復原碼可能已經外流：按「用這台的資料重新開始同步」會產生新的同步空間與新的復原碼（舊的都不能用了），你的其他裝置再重新加入。
            </span>
          </div>
        )}
        <p className="small">
          在電腦、手機之間同步你的選手資料、賽事、課表、每日自評、和教練的對話，以及跑步的體感與分析。跑步紀錄本身每台各自從 Intervals.icu 抓；API key 不同步，每台各自填。
        </p>
        <p className="muted small">
          資料在這台加密後才送出，同步服務只存加密後的內容，看不到也解不開；解開用的金鑰只在你的裝置上。這台已有的資料會和雲端的合併。同步服務存了什麼見
          <PrivacyLink />。
        </p>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void begin()}>
            {removedHere() ? "用這台的資料重新開始同步" : "這是第一台：開始同步"}
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
              （共同步 {last.total} 筆；這次收到 {last.received}、送出 {last.sent}
              {last.pending ? `；${last.pending} 筆等這台同步到對應的跑步` : ""}）
            </span>
          )}
        </p>
        {deviceSync.error && <div className="notice error">同步失敗：{deviceSync.error}</div>}
        {!lockEnabled() && mode !== "confirmAdd" && mode !== "confirmCode" && mode !== "confirmRemove" && mode !== "confirmRekey" && (
          <div className="notice warn">
            建議到上面的「保護 API key」設定密碼鎖：沒有密碼鎖時，同步金鑰和 API key 以明文存在這個瀏覽器裡，能用這個瀏覽器的人就讀得到。
          </div>
        )}
        {mode === "newCode" ? (
          <div className="pairing new-code">
            <div className="notice ok">
              <span>
                已換金鑰。這是<strong>新的復原碼</strong>，舊的已經失效。留下的裝置下次同步會自動換過去，不用重新配對。請把新的存好（截圖、印出來或存進密碼管理器），取代舊的。
              </span>
            </div>
            <code className="recovery-code">{code}</code>
            <label className="check">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              我已經把新的復原碼存好了
            </label>
            <div className="row">
              <button
                className="primary"
                disabled={!saved}
                onClick={() => {
                  setMode("idle");
                  setCode(null);
                }}
              >
                完成
              </button>
            </div>
          </div>
        ) : mode === "confirmRemove" && target ? (
          <ConfirmIdentity
            purpose="remove"
            risk={`移除「${deviceName(target)}」：它之後連不上同步，下次打開時清掉它的同步金鑰與 API key（訓練資料留在那台）。同時會換一把新的同步金鑰與復原碼，舊的復原碼失效；留下的裝置自動換過去，不用重新配對。它已經下載的資料收不回來。`}
            onConfirmed={() => void rekey(target)}
            onCancel={() => {
              setMode("idle");
              setTarget(null);
            }}
          />
        ) : mode === "confirmRekey" ? (
          <ConfirmIdentity
            purpose="rekey"
            risk="換一把新的同步金鑰與復原碼：舊的復原碼失效，拿著舊復原碼的人之後連不上；所有裝置都留著，下次同步自動換過去，不用重新配對。已經被同步走的資料收不回來。"
            onConfirmed={() => void rekey(null)}
            onCancel={() => setMode("idle")}
          />
        ) : mode === "confirmAdd" || mode === "confirmCode" ? (
          <ConfirmIdentity
            purpose={mode === "confirmAdd" ? "add" : "code"}
            onConfirmed={() => (mode === "confirmAdd" ? setMode("add") : void showCode())}
            onCancel={() => {
              setMode("idle");
              setLinkCode("");
            }}
          />
        ) : mode === "add" ? (
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
            <p className="small">
              復原碼只在新裝置還原時需要（所有裝置都不見、或沒有另一台可以配對時）。請存在安全的地方，不要傳給別人；離開這個畫面或一分鐘後就會收起。
            </p>
            <code className="recovery-code">{code}</code>
            <AutoHideNote {...codeAutoHide} />
            {deviceSync.devicesMode ? (
              <p className="muted small">懷疑復原碼外流：按裝置清單下面的「只換金鑰」，舊的復原碼就失效，其他裝置自動換過去（已經被同步走的資料收不回來）。</p>
            ) : (
              <p className="muted small">
                懷疑復原碼外流：目前的做法是按「刪除雲端的資料」，再用這台「這是第一台：開始同步」產生新的金鑰與復原碼，其他裝置停止同步後重新配對加入；舊的復原碼就不能用了（已經被同步走的資料收不回來）。
              </p>
            )}
            <div className="row">
              <button
                onClick={() => {
                  setMode("idle");
                  setCode(null);
                }}
              >
                收起
              </button>
            </div>
          </div>
        ) : (
          <>
            {busy && <p className="muted small">{target ? "移除並換金鑰中…" : "處理中…"}</p>}
            {deviceSync.devicesMode && deviceSync.devices && (
              <DeviceList
                devices={deviceSync.devices}
                busy={busy || deviceSync.busy}
                onRemove={(d) => {
                  setMessage(null);
                  setTarget(d);
                  setMode("confirmRemove");
                }}
                onRekey={() => {
                  setMessage(null);
                  setTarget(null);
                  setMode("confirmRekey");
                }}
              />
            )}
            <div className="row wrap">
              <button disabled={deviceSync.busy} onClick={() => void deviceSync.run()}>
                {deviceSync.busy ? "同步中…" : "立即同步裝置"}
              </button>
              <button
                onClick={() => {
                  setMessage(null);
                  setMode("confirmAdd");
                }}
              >
                新增裝置
              </button>
              <button
                onClick={() => {
                  setMessage(null);
                  setMode("confirmCode");
                }}
              >
                顯示復原碼
              </button>
              <button className="link" onClick={() => void stopHere()}>
                停止這台的同步
              </button>
              <button className="link danger" disabled={busy} onClick={() => void deleteRemote()}>
                刪除雲端的資料
              </button>
            </div>
          </>
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
