/**
 * 功能開關（規格 12.25）：建置時決定哪些功能開著.
 *
 * 大一點、可能要打磨的功能放在開關後面：程式照常合併、一起發版，正式版只開使用者說要上線的。
 * staging 一律全開。開關關著時，App 與教練的行為和沒有這個功能時一樣（資料庫的新增照常，只做向下相容的）。
 * 開了之後穩定一陣子，再把開關拿掉。
 */

/** 所有的開關與說明（設定頁最下面列出開著的） */
export const FEATURES = {
  /** 多運動（規格 12.24）：讀騎車等的運動設定、選手練哪些運動、交叉訓練的目標、課表外的運動主動建議調整、回報肌力 */
  multisport: "多運動",
  /** 測試模式（假的跑步紀錄、另一個資料庫、模擬日期，規格 6.1）：開發與 staging 用，正式版關著（規格 12.25） */
  testmode: "測試模式",
} as const;

export type Feature = keyof typeof FEATURES;

export const ALL_FEATURES = Object.keys(FEATURES) as Feature[];

/**
 * 建置時的設定 → 開著的功能。all：全開（staging 不論設定都全開）；否則是逗號分隔的名稱，不認得的略過.
 * 例：「multisport」「multisport, other」「all」
 */
export function parseFeatures(text: string | undefined, options: { staging?: boolean } = {}): Feature[] {
  if (options.staging) return [...ALL_FEATURES];
  const names = (text ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.includes("all")) return [...ALL_FEATURES];
  return ALL_FEATURES.filter((f) => names.includes(f.toLowerCase()));
}

/** 這個功能開著嗎；settings 是 CoachSettings 或任何帶 features 的物件 */
export function featureOn(settings: { features?: readonly string[] } | null | undefined, feature: Feature): boolean {
  return !!settings?.features?.includes(feature);
}
