FROM python:3.12-slim

# 強制 Python I/O 全程使用 UTF-8，避免中文輸入出現 surrogate 編碼錯誤
ENV PYTHONUTF8=1
# 系統時區（影響 log 時間戳記等系統層級輸出）
# Python 層級的時區由 requirements.txt 的 tzdata 套件提供給 zoneinfo 使用
ENV TZ="Asia/Taipei"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY scripts/ ./scripts/

RUN mkdir -p /app/data

CMD ["python", "src/main.py"]
