/**
 * 共用的介面元件（設計準則 doc/design-guidelines.md，規格 12.28）：圖示、收起的細節、ⓘ、列表的一列、體感 1–10、提示.
 * 圖示用 Lucide（ISC 授權）：只打包用到的，不從 CDN 載入
 */
import { useId, useState, type ReactNode } from "react";

import {
  Activity,
  Bike,
  ChevronRight,
  Dumbbell,
  Flag,
  Footprints,
  Info,
  Moon,
  Waves,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

/** 圖示的大小：分頁 22、行內 20、標籤裡 14 */
export const ICON_TAB = 22;
export const ICON_INLINE = 20;
export const ICON_CHIP = 14;

/** 圖示一律不給螢幕閱讀器讀（意思由旁邊的字或按鈕的名稱說） */
export function Icon({ as: Shape, size = ICON_INLINE, ...props }: { as: LucideIcon } & LucideProps) {
  return <Shape size={size} strokeWidth={2} className="icon" aria-hidden="true" focusable="false" {...props} />;
}

/** 運動種類用圖示分，不用顏色分：跑步、騎車、肌力、游泳、其他；休息與賽事也有自己的圖示 */
export type SportKey = "run" | "ride" | "strength" | "swim" | "other" | "rest" | "race";

const SPORT_SHAPES: Record<SportKey, LucideIcon> = {
  run: Footprints,
  ride: Bike,
  strength: Dumbbell,
  swim: Waves,
  other: Activity,
  rest: Moon,
  race: Flag,
};

export const SPORT_NAMES: Record<SportKey, string> = {
  run: "跑步",
  ride: "騎車",
  strength: "肌力訓練",
  swim: "游泳",
  other: "其他運動",
  rest: "休息",
  race: "賽事",
};

export function SportIcon({ sport, size = ICON_INLINE }: { sport: SportKey; size?: number }) {
  return <Icon as={SPORT_SHAPES[sport]} size={size} />;
}

/** 收起的細節：全 App 同一個樣子（› 加「細節」或「為什麼」）；用原生的 details，鍵盤與螢幕閱讀器都照常 */
export function Disclosure({
  summary = "細節",
  className = "",
  open,
  children,
}: {
  summary?: ReactNode;
  className?: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className={`disclosure ${className}`.trim()} open={open}>
      <summary>
        <Icon as={ChevronRight} size={16} className="icon chev" />
        {summary}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/** 按鈕版的「細節」：卡片整張可以點的地方（不能放 details 的） */
export function DisclosureButton({ open, onToggle, children = "細節", controls }: { open: boolean; onToggle: () => void; children?: ReactNode; controls?: string }) {
  return (
    <button type="button" className="disclosure-button" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <Icon as={ChevronRight} size={16} className="icon chev" />
      {children}
    </button>
  );
}

/** ⓘ：超過一行的說明收在這裡，點了在下面展開 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <span className="info-tip">
        <button type="button" className="info-button" aria-label={label} title={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          <Icon as={Info} size={18} />
        </button>
      </span>
      {open && (
        <div id={id} className="info-pop">
          {children}
        </div>
      )}
    </>
  );
}

/** 列表的一列：左邊圖示，中間標題加一行副標，右邊數字、狀態或 › */
export function ListRow({
  icon,
  title,
  sub,
  end,
  chevron = false,
  onClick,
  className = "",
  label,
}: {
  icon?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  end?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  className?: string;
  /** 按鈕的名稱（預設是標題的字） */
  label?: string;
}) {
  const body = (
    <>
      {icon && <span className="list-row-icon">{icon}</span>}
      <span className="list-row-text">
        <span className="list-row-title">{title}</span>
        {sub && <span className="list-row-sub">{sub}</span>}
      </span>
      {(end || chevron) && (
        <span className="list-row-end">
          {end}
          {chevron && <Icon as={ChevronRight} size={ICON_INLINE} />}
        </span>
      )}
    </>
  );
  return onClick ? (
    <button type="button" className={`list-row ${className}`.trim()} aria-label={label} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={`list-row ${className}`.trim()}>{body}</div>
  );
}

/** 體感 1–10：十格點選（下面標很輕鬆、普通、全力） */
export function EffortPicker({ value, onChange, label = "體感" }: { value: number | null; onChange: (n: number) => void; label?: string }) {
  return (
    <div className="effort-picker" role="group" aria-label={`${label} 1–10`}>
      <div className="effort-cells">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            className={value !== null && n < value ? "effort-cell filled" : "effort-cell"}
            aria-pressed={value === n}
            aria-label={`${label} ${n}`}
            onClick={() => onChange(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="effort-ends" aria-hidden="true">
        <span>很輕鬆</span>
        <span>普通</span>
        <span>全力</span>
      </div>
    </div>
  );
}

/** 核心給的文字（和 Discord 共用）開頭的 emoji：網頁版顯示時去掉，用圖示表示 */
export function stripEmoji(text: string): string {
  return text.replace(/^(?:\p{Extended_Pictographic}️?\s*)+/u, "").replace(/\p{Extended_Pictographic}️?\s?/gu, "");
}
