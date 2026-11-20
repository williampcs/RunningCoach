/**
 * 我的鑰匙與帳號（規格 12.47「使用者要保管的東西」第一段）：使用者要管的每一樣東西一列，
 * 寫有沒有、存在哪裡、換手機會不會自動回來、弄丟會怎樣. 點一列到那一樣的設定.
 */
import { Gift, KeyRound, Lock, QrCode, Sparkles, Watch, type LucideIcon } from "lucide-react";

import { useState } from "react";

import { useApp, type SettingsSection } from "../app-context";
import type { PendingReason } from "../secret-sync";
import { intervalsConnected, lockEnabled, SECRET_NAMES, type AppSettings, type IntervalsSecret, type SecretName } from "../settings";
import { trialAvailable } from "../trial";
import { trialActive } from "../trial-sync";
import { Icon, ListRow } from "../ui";

interface KeyItem {
  id: string;
  icon: LucideIcon;
  title: string;
  /** 右邊的狀態；好的狀態是綠色 */
  status: [string, boolean];
  where: string;
  newPhone: string;
  lost: string;
  /** 點了到哪一項設定 */
  section: SettingsSection;
}

/** 每一樣的現況與說明（給畫面與測試） */
export function keyItems(s: AppSettings, opts: { syncOn: boolean; share: boolean; locked: boolean; trial: boolean }): KeyItem[] {
  const carried = opts.syncOn && opts.share;
  const local = opts.locked ? "這台，用密碼鎖加密" : "這台";
  const items: KeyItem[] = [
    {
      id: "sync",
      icon: KeyRound,
      title: "同步金鑰與復原碼",
      status: opts.syncOn ? ["有", true] : ["沒有開同步", false],
      where: opts.syncOn ? `金鑰在${local}；復原碼要你自己存` : "開始同步時產生",
      newPhone: "用舊的那台配對，或輸入復原碼",
      lost: "所有裝置都不見又沒有復原碼，同步的資料就回不來",
      section: "sync",
    },
    {
      id: "pair",
      icon: QrCode,
      title: "配對碼",
      status: ["臨時", false],
      where: "不存：加入新裝置時才產生，10 分鐘內用一次",
      newPhone: "舊的那台要在手上",
      lost: "沒關係，再產生一組",
      section: "sync",
    },
  ];
  if (opts.trial) {
    const using = trialActive(s);
    items.push({
      id: "trial",
      icon: Gift,
      title: "免費試用",
      status: using ? ["使用中", true] : ["沒有用", false],
      where: "每台一個自己的憑證；帳號跟著加密的同步",
      newPhone: opts.syncOn ? "新的那台沒設定 AI 時自動回來" : "開了同步才會自動回來",
      lost: "在用著的那台按「在另一台使用」；每台可以單獨移除",
      section: "ai",
    });
  }
  const hasKey = s.llmMode === "byok" && s.apiKey.trim() !== "";
  items.push(
    {
      id: "llm",
      icon: Sparkles,
      title: "AI 的 API key",
      status: hasKey ? ["有", true] : s.llmMode === "proxy" ? ["用免費試用", false] : ["沒有", false],
      where: carried ? `${local}＋加密的同步` : local,
      newPhone: carried ? "開了同步就自動回來" : opts.syncOn ? "要重新填：同步設定裡沒有勾「帶到其他裝置」" : "要在新的那台重新填",
      lost: "裝置弄丟或 key 外流：到 AI 服務的後台撤銷，換一把新的",
      section: "ai",
    },
    {
      id: "intervals",
      icon: Watch,
      title: "Intervals.icu 的連線",
      status: intervalsConnected(s) ? ["已連接", true] : ["沒有", false],
      where: carried ? `${local}＋加密的同步` : local,
      newPhone: carried ? "開了同步就自動回來" : "要在新的那台重新連接",
      lost: "裝置弄丟：到 Intervals.icu 中斷連結，或重新產生 API key",
      section: "records",
    },
    {
      id: "lock",
      icon: Lock,
      title: "密碼鎖",
      status: opts.locked ? ["開", true] : ["關", false],
      where: "密碼不存在任何地方，只用來加密這台的 key",
      newPhone: "每台各自設",
      lost: carried ? "這台的 key 與同步金鑰會清掉：重新配對加入同步後，key 會從另一台帶回來" : "這台的 key 要重新填",
      section: "lock",
    },
  );
  return items;
}

export function KeysOverview({ onOpen }: { onOpen: (section: SettingsSection) => void }) {
  const { settings, deviceSync, secretSync, testMode } = useApp();
  const items = keyItems(settings, {
    syncOn: deviceSync.enabled && !testMode.enabled,
    share: secretSync.share === true,
    locked: lockEnabled(),
    trial: trialAvailable(),
  });
  return (
    <section className="card settings-list keys-overview">
      <ul className="rows">
        {items.map((item) => (
          <li key={item.id} data-key={item.id}>
            <ListRow
              icon={<Icon as={item.icon} />}
              title={item.title}
              sub={item.where}
              end={<span className={item.status[1] ? "status ok" : "status"}>{item.status[0]}</span>}
              chevron
              label={`${item.title}：${item.status[0]}`}
              onClick={() => onOpen(item.section)}
            />
            <dl className="key-facts small">
              <dt>換手機</dt>
              <dd>{item.newPhone}</dd>
              <dt>弄丟了</dt>
              <dd>{item.lost}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

const REASON_TEXT: Record<PendingReason, string> = {
  recipient: "另一台換了 AI 服務或服務網址。改用的話，你的資料會送到那裡，要在這台重新確認資料流向。",
  "both-changed": "兩台都改過，不知道要用哪一份。",
  unknown: "這台的是之前填的，不知道哪一份比較新。",
};

/** 另一台的 key 和這台的不一樣、要使用者決定的（規格 12.47）；only：只顯示那一樣 */
export function SecretPrompts({ only }: { only?: SecretName }) {
  const { secretSync } = useApp();
  const [busy, setBusy] = useState(false);
  const names = SECRET_NAMES.filter((n) => secretSync.pending[n] && (!only || n === only));
  if (!names.length && !secretSync.shareAsk) return null;
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    try {
      await job();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {secretSync.shareAsk && (
        <div className="notice warn secret-prompt" data-secret="share">
          <span>
            <strong>另一台打開了「帶 key 到其他裝置」</strong>
            <br />
            要把這台的 API key 與 Intervals.icu 的連線也加密後帶上去嗎？不帶的話，這台照樣拿得到別台的。如果不是你打開的，選「這台不帶」，到「多裝置同步」取消勾選並移除不認得的裝置。
          </span>
          <div className="actions">
            <button disabled={busy} onClick={() => void run(() => secretSync.answerShare(true))}>
              這台也帶
            </button>
            <button disabled={busy} onClick={() => void run(() => secretSync.answerShare(false))}>
              這台不帶
            </button>
          </div>
        </div>
      )}
      {names.map((name) => {
        const item = secretSync.pending[name]!;
        const intervals = item.value as Partial<IntervalsSecret>;
        const other =
          "cleared" in item.value
            ? name === "llm"
              ? "另一台清掉了 API key"
              : "另一台中斷了 Intervals.icu 的連線"
            : name === "llm"
              ? `另一台的 AI 服務：${item.recipient ?? ""}`
              : `另一台的 Intervals.icu：${intervals.account?.name ?? (intervals.accessToken ? "用登入連接" : "用 API key 連接")}`;
        return (
          <div key={name} className="notice warn secret-prompt" data-secret={name}>
            <span>
              <strong>{name === "llm" ? "另一台的 API key 和這台的不一樣" : "另一台的 Intervals.icu 連線和這台的不一樣"}</strong>
              <br />
              {other}。{REASON_TEXT[item.reason]}
            </span>
            <div className="actions">
              <button disabled={busy} onClick={() => void run(() => secretSync.accept(name))}>
                改用另一台的
              </button>
              <button disabled={busy} onClick={() => void run(() => secretSync.keep(name))}>
                保留這台的
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
