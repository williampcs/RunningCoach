/**
 * 我的鑰匙與帳號（規格 12.47「使用者要保管的東西」第一段）：使用者要管的每一樣東西一列，
 * 寫有沒有、存在哪裡、換手機會不會自動回來、弄丟會怎樣. 點一列到那一樣的設定.
 */
import { Gift, KeyRound, Lock, QrCode, Sparkles, Watch, type LucideIcon } from "lucide-react";

import { useApp, type SettingsSection } from "../app-context";
import { intervalsConnected, lockEnabled, type AppSettings } from "../settings";
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
      lost: "到 AI 服務的後台撤銷，再產生一把新的",
      section: "ai",
    },
    {
      id: "intervals",
      icon: Watch,
      title: "Intervals.icu 的連線",
      status: intervalsConnected(s) ? ["已連接", true] : ["沒有", false],
      where: carried ? `${local}＋加密的同步` : local,
      newPhone: carried ? "開了同步就自動回來" : "要在新的那台重新連接",
      lost: "到 Intervals.icu 重新登入，或重新產生 API key",
      section: "records",
    },
    {
      id: "lock",
      icon: Lock,
      title: "密碼鎖",
      status: opts.locked ? ["開", true] : ["關", false],
      where: "密碼不存在任何地方，只用來加密這台的 key",
      newPhone: "每台各自設",
      lost: carried ? "這台的 key 要重填；開著同步時從另一台帶回來" : "這台的 key 要重新填",
      section: "lock",
    },
  );
  return items;
}

export function KeysOverview({ onOpen }: { onOpen: (section: SettingsSection) => void }) {
  const { settings, deviceSync, secretSync, testMode } = useApp();
  const items = keyItems(settings, {
    syncOn: deviceSync.enabled && !testMode.enabled,
    share: secretSync.share !== false,
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
