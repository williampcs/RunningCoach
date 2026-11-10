/**
 * 免費試用（邀請碼，規格 12.39）的畫面：貼邀請碼或連結碼、今天還剩幾則、在另一台裝置使用、這個帳號的裝置、
 * 刪除試用帳號、資料流向.
 * 設定的「AI 教練」、設定精靈與對話頁共用.
 */
import { useCallback, useEffect, useState } from "react";

import { CircleCheck, Link2, Ticket } from "lucide-react";

import { errorText, useApp } from "../app-context";
import { suggestedModels, type AppSettings } from "../settings";
import {
  createLinkCode,
  deleteTrialAccount,
  fetchTrialUsage,
  listTrialDevices,
  modelLabel,
  redeemInvite,
  removeTrialDevice,
  resetText,
  TRIAL_MODEL,
  TRIAL_PROXY_URL,
  type TrialDevice,
  type TrialUsage,
} from "../trial";
import { Icon } from "../ui";
import { PrivacyLink } from "./PrivacyLink";

/** 免費試用的資料流向（設定的 ⓘ、精靈的「資料會送到哪裡」） */
export function TrialDataFlow() {
  return (
    <ul>
      <li>你的對話、選手資料與訓練紀錄會經過 Zone2Mate 的代理，轉送給 Anthropic 產生回覆。</li>
      <li>代理不保存對話的內容，只記次數與用量：你的試用帳號（隨機的代號）、用著它的裝置（例「iPhone · Safari」）、每天用了幾則、每月的 token 數與金額。不需要 email 或名字。</li>
      <li>每天的次數留 90 天、每月的用量留 13 個月，到期自動刪除；在這裡按「刪除試用帳號」會馬上刪掉。</li>
      <li>Anthropic 如何保存與使用這些資料，依它的 API 條款而定，Zone2Mate 無法替它保證。</li>
      <li>
        完整的說明：<PrivacyLink />
      </li>
    </ul>
  );
}

/** 免費試用一天幾則、用什麼模型（說明用） */
export const TRIAL_SUMMARY = `用 ${modelLabel(TRIAL_MODEL)}（不思考），每天有則數的上限，不用申請 API key。`;

/**
 * 貼邀請碼 → 兌換 → 存成這台的設定（憑證只拿得到這一次，所以拿到就存）.
 * 存好之後交給 onDone；base 是要在上面改的設定（設定頁的草稿或目前的設定）
 */
export function InviteForm({ base, onDone }: { base: AppSettings; onDone?: (next: AppSettings) => void }) {
  const { updateSettings } = useApp();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function redeem() {
    setBusy(true);
    setError(null);
    try {
      const { token } = await redeemInvite(code.trim(), base.proxy.url.trim() || TRIAL_PROXY_URL);
      const next: AppSettings = {
        ...base,
        llmMode: "proxy",
        proxy: { url: base.proxy.url.trim() || TRIAL_PROXY_URL, token },
        models: suggestedModels("proxy", base.provider),
      };
      await updateSettings(next);
      setCode("");
      onDone?.(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim() && !busy) void redeem();
      }}
    >
      <label>
        邀請碼或連結碼
        <input value={code} placeholder="RC-XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" disabled={!code.trim() || busy}>
          <Icon as={Ticket} />
          {busy ? "啟用中…" : "啟用"}
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <p className="small muted">邀請碼由 Zone2Mate 的作者提供，一碼只能用一次。已經在另一台用了？在那台的設定按「在另一台裝置使用」，把連結碼貼在這裡。</p>
    </form>
  );
}

/** 今天還剩幾則；revision 變了就再查一次（對話完成之後） */
export function useTrialUsage(settings: AppSettings, revision = 0): { usage: TrialUsage | null; error: string | null; refresh: () => void } {
  const [usage, setUsage] = useState<TrialUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const active = settings.llmMode === "proxy" && settings.proxy.token.trim() !== "" && settings.proxy.url.trim() !== "";
  useEffect(() => {
    if (!active) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    fetchTrialUsage(settings)
      .then((u) => {
        if (cancelled) return;
        setUsage(u);
        setError(null);
      })
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
    // 只看憑證與網址，其他設定改了不用重查
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, settings.proxy.token, settings.proxy.url, revision, tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { usage, error, refresh };
}

/** 一行「今天還剩 N 則」（設定與對話頁） */
export function remainingText(usage: TrialUsage): string {
  const left = Math.max(0, usage.today.messagesLimit - usage.today.messagesUsed);
  return `今天還剩 ${left} 則（共 ${usage.today.messagesLimit} 則，${resetText(usage.today.resetsAt)}重置）`;
}

/** 設定的「AI 教練」：已經啟用免費試用時 */
export function TrialAccount({ onDeleted }: { onDeleted: (next: AppSettings) => void }) {
  const { settings, updateSettings, toast } = useApp();
  const { usage, error } = useTrialUsage(settings);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState<{ code: string; expiresAt: string } | null>(null);
  const [devices, setDevices] = useState<TrialDevice[] | null>(null);
  const [devicesTick, setDevicesTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listTrialDevices(settings)
      .then((list) => !cancelled && setDevices(list))
      .catch(() => !cancelled && setDevices(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.proxy.token, devicesTick]);

  /** 這台的憑證不能用了（帳號刪了、這台被移除）：清掉這台的憑證 */
  async function forgetHere(message: string) {
    const next = { ...settings, proxy: { ...settings.proxy, token: "" } };
    await updateSettings(next);
    onDeleted(next);
    toast(message);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const remove = () =>
    run(async () => {
      if (!confirm("刪除這個試用帳號？代理那邊的帳號、所有裝置的登入與用量紀錄都會刪掉；之後要再用免費試用，需要一張新的邀請碼。對話與訓練紀錄留在這台。")) return;
      await deleteTrialAccount(settings);
      await forgetHere("已刪除試用帳號。");
    });

  const newLink = () =>
    run(async () => {
      setLink(await createLinkCode(settings));
    });

  const removeDevice = (device: TrialDevice) =>
    run(async () => {
      const name = device.name ?? "這台裝置";
      if (!confirm(device.current ? "移除這台？這台之後要重新輸入邀請碼或連結碼才能用免費試用。" : `移除「${name}」？那台之後要重新輸入連結碼才能用免費試用。`)) return;
      await removeTrialDevice(settings, device.id);
      if (device.current) await forgetHere("已移除這台。");
      else setDevicesTick((n) => n + 1);
    });

  const expiresText = (iso: string) => new Date(iso).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <div className="stack trial-account">
      <p className="ok-text">
        <Icon as={CircleCheck} /> 已啟用免費試用
      </p>
      <p className="small">
        模型：{modelLabel(usage?.model ?? TRIAL_MODEL)}（{usage?.thinking ? "會思考" : "不思考"}，免費試用固定，不能改）
      </p>
      {usage && <p className="small trial-remaining">{remainingText(usage)}</p>}
      {usage?.paused && (
        <p className="small field-error">
          {usage.paused === "beta_budget" ? "這個月的免費額度用完了（所有試用的人合計）" : "你這個月的免費額度用完了"}，{resetText(usage.pausedUntil)}恢復。
        </p>
      )}
      {error && <p className="small field-error">{error}</p>}

      <h3>裝置</h3>
      {devices && (
        <ul className="trial-devices">
          {devices.map((d) => (
            <li key={d.id} className="row">
              <span>
                {d.name ?? "裝置"}
                {d.current && <span className="small muted">（這台）</span>}
              </span>
              <button className="text danger" disabled={busy} onClick={() => void removeDevice(d)}>
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
      {link ? (
        <p className="trial-link" role="status">
          在另一台的設定 →「AI 教練」→「免費試用（邀請碼）」輸入 <strong className="num">{link.code}</strong>（{expiresText(link.expiresAt)} 前有效，用一次）
        </p>
      ) : (
        <div className="actions">
          <button disabled={busy} onClick={() => void newLink()}>
            <Icon as={Link2} />
            在另一台使用
          </button>
        </div>
      )}
      <p className="small muted">同一個試用帳號、同一份每天的則數。</p>

      {problem && <p className="small field-error">{problem}</p>}
      <div className="actions">
        <button className="text danger" disabled={busy} onClick={() => void remove()}>
          刪除試用帳號
        </button>
      </div>
    </div>
  );
}
