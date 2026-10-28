import { redFlagAdvice, type FeedItem } from "@running-coach/core";

import { dismissRedFlags, useRedFlagAlert, type RedFlagAlert } from "../red-flag-alert";
import { TermsLink } from "./TermsLink";

/** 就醫提示（規格 12.33 第 4 點）：畫面上方的一條，按「我知道了」才收起（看板上的那則一起收起） */
export function RedFlagBanner() {
  const alert = useRedFlagAlert();
  if (!alert) return null;
  const advice = redFlagAdvice(alert.labels);
  return (
    <div className="notice warn red-flag" role="alert">
      <strong>{advice.title}</strong>
      <span className="small">{advice.detail}</span>
      <div className="actions">
        <button className="primary" onClick={dismissRedFlags}>
          我知道了
        </button>
        <TermsLink />
      </div>
    </div>
  );
}

/** 看板上的那則：和上方的提示同一份，收起任一個兩個都收起 */
export function redFlagFeedItem(alert: RedFlagAlert): FeedItem {
  const advice = redFlagAdvice(alert.labels);
  return { id: `medical-${alert.at}`, kind: "medical", tone: "warn", title: advice.title, detail: advice.detail, actions: [{ type: "ack" }] };
}
