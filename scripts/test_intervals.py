"""測試 Intervals.icu API 連線與活動拉取.

用法：
    python scripts/test_intervals.py [API_KEY] [ATHLETE_ID]

若未提供參數，會自動從 .env 或環境變數讀取 INTERVALS_API_KEY 與 INTERVALS_ATHLETE_ID。
"""
import os
import sys
from pathlib import Path

# 載入 .env 輔助函式（不依賴 python-dotenv）
def load_env_file(env_path: Path):
    if not env_path.exists():
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if k not in os.environ:
                os.environ[k] = v

# 讀取專案根目錄 .env
env_file = Path(__file__).resolve().parent.parent / ".env"
load_env_file(env_file)

# 支援命令列參數直接傳入
if len(sys.argv) >= 2 and sys.argv[1]:
    os.environ["INTERVALS_API_KEY"] = sys.argv[1]
if len(sys.argv) >= 3 and sys.argv[2]:
    os.environ["INTERVALS_ATHLETE_ID"] = sys.argv[2]

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import config
from tools.intervals_tool import intervals


def main():
    print("=" * 60)
    print("🏃 Intervals.icu API 連線測試")
    print("=" * 60)

    api_key = config.INTERVALS_API_KEY
    athlete_id = config.INTERVALS_ATHLETE_ID or "0"

    masked_key = f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) > 8 else (api_key or "(未設定)")
    print(f"• Athlete ID : {athlete_id}")
    print(f"• API Key    : {masked_key}")
    print("-" * 60)

    if not api_key:
        print("❌ 錯誤：找不到 INTERVALS_API_KEY。")
        print("請在 .env 中填入：")
        print("INTERVALS_API_KEY=你的API_KEY")
        print("INTERVALS_ATHLETE_ID=你的ATHLETE_ID（通常以 i 開頭，或填 0）")
        print("\n或透過命令列傳入：python scripts/test_intervals.py <API_KEY> <ATHLETE_ID>")
        sys.exit(1)

    print("正在測試拉取最近 14 天的跑步活動...")
    try:
        activities = intervals.fetch_activities(days=14)
        print(f"✅ 連線成功！共取得 {len(activities)} 筆最近 14 天的跑步紀錄。\n")

        if activities:
            print("【最新一筆跑步活動詳情】")
            latest = activities[0]
            print(f"• ID       : {latest['intervals_id']}")
            print(f"• 日期     : {latest['date']}")
            print(f"• 距離     : {latest['distance_km']} km")
            print(f"• 時間     : {latest['duration_min']} 分鐘")
            print(f"• 平均配速 : {latest.get('avg_pace') or '未知'}")
            print(f"• 平均心率 : {latest.get('avg_hr') or '未記錄'} bpm (最高: {latest.get('max_hr') or '未記錄'} bpm)")
            print(f"• 爬升     : {latest.get('elevation_m') or 0} m")
            print(f"• 卡路里   : {latest.get('calories') or '未記錄'} kcal")
            if latest.get("training_load") is not None:
                print(f"• 訓練負荷 : {latest.get('training_load')} (icu_training_load)")
        else:
            print("ℹ️ 最近 14 天內無跑步活動紀錄。")

        print("\n🎉 Intervals.icu 串接正常運作！")

    except Exception as e:
        print(f"❌ 連線失敗：{e}")
        print("\n請檢查：")
        print("1. API Key 是否複製完整？")
        print("2. Athlete ID 是否正確（可嘗試改用 '0' 代表本帳號）？")
        print("3. 是否已在 Intervals.icu 連結 Garmin / 跑錶帳號並有運動資料？")
        sys.exit(1)


if __name__ == "__main__":
    main()
