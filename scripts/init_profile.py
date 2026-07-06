"""初始化選手資料腳本.

用法（在 VM 或本機執行，需設定 DB_PATH 或使用預設值）：

    python scripts/init_profile.py

會以互動模式詢問各欄位值，留空則跳過。
或直接編輯腳本底部的 DEFAULTS 後執行。
"""
import os
import sys

# 讓腳本能直接 import src/ 下的模組
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import config  # noqa: E402  （需在 sys.path 設定後 import）
import memory.db as db  # noqa: E402


# 若不想互動輸入，可直接在這裡填入預設值（留空字串代表跳過）
DEFAULTS: dict[str, str] = {
    "goal_long_term": "",   # e.g. "2026年底前半馬破二"
    "pb_5k": "",            # e.g. "30:00"
    "pb_10k": "",           # e.g. "70:00"
    "pb_half": "",          # e.g. "2:08:00"
    "pb_full": "",          # e.g. "4:00:00"
    "injuries": "",         # e.g. "右膝髕骨外側輕微不適"
    "weekly_km_target": "", # e.g. "50"
}

PROMPTS: dict[str, str] = {
    "goal_long_term": "長期目標（例：2026年底前半馬破二）",
    "pb_5k": "5km PB（例：30:00）",
    "pb_10k": "10km PB（例：70:00）",
    "pb_half": "半馬 PB（例：2:08:00）",
    "pb_full": "全馬 PB（例：4:00:00）",
    "injuries": "傷病注意事項（例：右膝髕骨外側輕微不適）",
    "weekly_km_target": "每週目標里程（例：50）",
}


def main():
    db.init_db()
    print(f"DB 位置：{config.DB_PATH}")
    print("初始化選手資料（留空跳過）\n")

    existing = db.get_profile()
    saved = []

    for key, prompt in PROMPTS.items():
        default = DEFAULTS.get(key, "")
        current = existing.get(key, "")
        hint = f"（目前：{current}）" if current else ""
        value = input(f"{prompt}{hint}：").strip() or default
        if value:
            db.set_profile_key(key, value)
            saved.append(f"  {key} = {value}")

    if saved:
        print("\n已儲存：")
        print("\n".join(saved))
    else:
        print("\n未儲存任何資料。")


if __name__ == "__main__":
    main()
