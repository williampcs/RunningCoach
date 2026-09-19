# 訓練計畫的邏輯分佈如下，不需要獨立模組：
#
#   DB 讀寫：
#     memory/db.py → save_training_plan(), get_active_training_plan()
#
#   Claude Tool 定義與執行：
#     agent/loop.py → _TOOLS 中的 "save_training_plan" 條目與 _execute_tool()
#
#   Discord 斜線指令：
#     bot/discord_bot.py → /plan 指令（直接呼叫 db.save_training_plan）
#
# 與 intervals_tool.py 不同，訓練計畫無外部 API 呼叫，
# 邏輯簡單，集中在上述位置維護即可。
