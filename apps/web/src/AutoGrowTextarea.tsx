import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent, type TextareaHTMLAttributes } from "react";

/**
 * 自動長高的輸入框（12.16）：平常 minRows 行高，打字時長高，最多 maxRows 行，超過在框內捲動。
 *
 * enter 決定按 Enter 的行為：
 * - "newline"（預設）：換行，像一般的多行輸入框（備註、感受）。
 * - "submit"：名稱這類單一值的欄位。不換行，按 Enter 照舊送出所在的表單；貼上的換行換成空格。
 * - "send"：對話。Enter 送出、Shift+Enter 換行。
 * 三種都不在輸入法選字時送出。
 */
export interface AutoGrowTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "rows" | "value"> {
  value: string;
  minRows?: number;
  maxRows?: number;
  enter?: "newline" | "submit" | "send";
}

export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, AutoGrowTextareaProps>(function AutoGrowTextarea(
  { value, minRows = 1, maxRows = 6, enter = "newline", className, onKeyDown, onChange, ...rest },
  forwarded,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(forwarded, () => ref.current!);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
    const extra = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const min = line * minRows + extra;
    const max = line * maxRows + extra;
    el.style.height = "auto";
    const needed = el.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = `${Math.min(Math.max(needed, min), max)}px`;
    el.style.overflowY = needed > max + 1 ? "auto" : "hidden";
  }, [minRows, maxRows]);

  useLayoutEffect(resize, [resize, value]);

  // 寬度改變（轉向、側欄）時折行跟著變，重新量
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [resize]);

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (enter === "submit" || (enter === "send" && !e.shiftKey)) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <textarea
      {...rest}
      ref={ref}
      rows={minRows}
      value={value}
      className={className ? `autogrow ${className}` : "autogrow"}
      onKeyDown={keyDown}
      onChange={(e) => {
        if (enter === "submit" && /[\r\n]/.test(e.target.value)) e.target.value = e.target.value.replace(/\s*[\r\n]+\s*/g, " ");
        onChange?.(e);
      }}
    />
  );
});
