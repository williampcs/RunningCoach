/**
 * 選手按了停止（規格 12.38）：存成教練的一則訊息. 不回溯、誠實告知：已經寫出的部分＋（已停止）；
 * 這次有做完的寫入（存課表、新增賽事…）不還原，寫出做了什麼、去哪裡改回.
 * 一定存一則教練的訊息：下一則對話的歷史才不會連著兩則選手的訊息，教練也知道上次停在哪
 */

/** 會寫入的工具：做了什麼、去哪裡改回 */
const WRITES: Record<string, { done: string; undo: string }> = {
  save_training_plan: { done: "存了課表", undo: "到「計畫」看，或請教練再改" },
  edit_planned_session: { done: "改了一堂課", undo: "到「計畫」看，或請教練改回" },
  update_planned_session: { done: "調整了課表（移動、跳過或改用替代）", undo: "到「計畫」按「恢復原本的課」" },
  add_race: { done: "新增了賽事", undo: "到「計畫」的賽事修改或刪除" },
  update_race: { done: "更新了賽事", undo: "到「計畫」的賽事修改" },
  mark_race_not_started: { done: "記下了沒有出賽", undo: "到「計畫」的賽事修改" },
  record_race_result: { done: "記錄了比賽成績", undo: "到「計畫」的賽事修改" },
  update_athlete_profile: { done: "更新了選手資料", undo: "到「選手」修改" },
  save_workout: { done: "存了跑後的回報與分析", undo: "到「紀錄」看那一趟" },
  save_pending_subjective: { done: "暫存了跑後的感受", undo: "同步後到「紀錄」看那一趟" },
  save_activity_feedback: { done: "存了運動的回報", undo: "到「紀錄」看那一趟" },
  save_daily_checkin: { done: "記了今天的身體狀況", undo: "到看板的「今天身體如何？」修改" },
  remember: { done: "記下了要記住的事", undo: "到「記住的事」刪除" },
  forget: { done: "刪掉了記住的事", undo: "到「記住的事」再新增" },
  record_injury: { done: "記下了傷病", undo: "到「選手」→「身體」修改" },
  update_injury: { done: "更新了傷病", undo: "到「選手」→「身體」修改" },
};

export const STOPPED_MARK = "（已停止）";

/** 教練那則的內容：部分文字＋（已停止）＋已經做的（有的話） */
export function stoppedReply(partial: string, toolNames: string[]): string {
  const done = [...new Set(toolNames)].flatMap((name) => (WRITES[name] ? [WRITES[name]!] : []));
  const lines = [partial.trim() ? `${partial.trim()}\n\n${STOPPED_MARK}` : STOPPED_MARK];
  if (done.length) {
    lines.push(`已經做的：${done.map((d) => d.done).join("、")}。停止不會改回已經做的事；要改回的話：${done.map((d) => d.undo).join("；")}。`);
  }
  return lines.join("\n\n");
}
