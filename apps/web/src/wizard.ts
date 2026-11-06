/**
 * 設定精靈（規格 12.35 的 A、12.37）的步驟與進度：一次一件事，中途離開再回來從停下的那一步繼續.
 *
 * 只給新的使用者：第一次打開時這個瀏覽器沒有存過設定、資料庫也是空的；已經設定好的人（之前就在用的）
 * 記成「已完成」，之後都不會出現。進度只存在這個瀏覽器（localStorage），不同步.
 */
import type { Coach } from "@running-coach/core";

import { featureEnabled } from "./environment";
import { hasStoredSettings } from "./settings";
import { SCOPED_KEYS, storageKey } from "./storage-scope";

// 測試模式用自己一份（storage-scope.ts）
const KEY = () => storageKey(SCOPED_KEYS.wizard);

export type WizardStep =
  /** 第一頁：開始設定／先看看 */
  | "welcome"
  /** 你用什麼記錄跑步 */
  | "record"
  /** AI：選供應商 */
  | "provider"
  /** AI：貼上 key（馬上檢查、自動存） */
  | "key"
  /** 資料流向與使用須知：同意並繼續 */
  | "consent"
  /** 紀錄的來源：Intervals.icu（登入或 API key）或手動記 */
  | "source"
  /** 練的運動（多運動開著時） */
  | "sports"
  /** 抓紀錄（Intervals.icu）或記第一筆（手動） */
  | "first"
  /** 選手資料（可以略過） */
  | "profile";

type Stored = { step: WizardStep } | { done: true };

function read(): Stored | null {
  try {
    return JSON.parse(localStorage.getItem(KEY()) ?? "null") as Stored | null;
  } catch {
    return null;
  }
}

function write(value: Stored): void {
  try {
    localStorage.setItem(KEY(), JSON.stringify(value));
  } catch {
    // 存不了時只是下次不能從這一步繼續
  }
}

/** 這次的步驟順序；多運動關著時沒有「練的運動」 */
export function wizardSteps(multisport: boolean): WizardStep[] {
  return ["welcome", "record", "provider", "key", "consent", "source", ...(multisport ? (["sports"] as const) : []), "first", "profile"];
}

/**
 * 打開時要不要出現、從哪一步開始. 判斷新的使用者：沒有存過設定、沒有任何訓練紀錄、對話與選手資料.
 * 不是新的使用者時記成已完成，之後清掉資料也不會再出現（要重來用「重置」裡的全部重置）
 */
export async function wizardStart(coach: Coach, options: { enabled?: boolean; storedSettings?: boolean } = {}): Promise<WizardStep | null> {
  if (!(options.enabled ?? featureEnabled("onboarding"))) return null;
  const stored = read();
  if (stored && "done" in stored) return null;
  if (stored && "step" in stored) return stored.step;
  const [workouts, others, profile, conversations] = await Promise.all([
    coach.db.countWorkouts(),
    coach.db.countOtherActivities(),
    coach.db.getProfile(),
    coach.db.getRecentConversations(1),
  ]);
  const fresh = !(options.storedSettings ?? hasStoredSettings()) && workouts === 0 && others === 0 && Object.keys(profile).length === 0 && conversations.length === 0;
  if (!fresh) {
    write({ done: true });
    return null;
  }
  write({ step: "welcome" });
  return "welcome";
}

export function saveWizardStep(step: WizardStep): void {
  write({ step });
}

/** 走完或略過：之後不再出現 */
export function finishWizard(): void {
  write({ done: true });
}

/** 全部重置時：下次打開當成新的使用者 */
export function resetWizard(): void {
  try {
    localStorage.removeItem(KEY());
  } catch {
    // 略過
  }
}
