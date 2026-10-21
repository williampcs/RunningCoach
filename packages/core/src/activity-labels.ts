import type { OtherActivity } from "./types";

/** Intervals.icu 的活動類型 → 中文；跑步以外的運動顯示與同步訊息用 */
const ACTIVITY_LABELS: Record<string, string> = {
  Walk: "走路",
  Hike: "健行",
  Ride: "騎車",
  VirtualRide: "騎車",
  EBikeRide: "騎車",
  GravelRide: "騎車",
  MountainBikeRide: "騎車",
  Swim: "游泳",
  OpenWaterSwim: "游泳",
  WeightTraining: "肌力訓練",
  Workout: "肌力訓練",
  Yoga: "瑜伽",
  Elliptical: "橢圓機",
  Rowing: "划船",
};

export function activityLabel(type: string): string {
  return ACTIVITY_LABELS[type] ?? "其他運動";
}

/** 肌力訓練類的活動（配對課表的肌力課） */
export const STRENGTH_TYPES: ReadonlySet<string> = new Set(["WeightTraining", "Workout", "Yoga", "Pilates"]);

/** 跑步以外的運動，每筆一行；不算跑量，但會累積疲勞 */
export function otherActivitiesText(
  others: OtherActivity[],
  heading = "其他運動（不算跑量，但會累積疲勞；Intervals.icu 的體能與疲勞已包含）：",
): string {
  const lines = [heading];
  for (const a of others) {
    const parts = [a.duration_min != null ? `${Math.round(a.duration_min)} 分鐘` : null, a.distance_km ? `${a.distance_km} km` : null];
    if (a.training_load != null) parts.push(`負荷 ${a.training_load}`);
    if (a.avg_hr != null) parts.push(`心率 ${a.avg_hr}`);
    lines.push(`- ${a.date} ${activityLabel(a.type)}：${parts.filter(Boolean).join("｜")}`);
  }
  return lines.join("\n");
}
