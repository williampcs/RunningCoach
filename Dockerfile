FROM python:3.12-slim

# 強制 Python I/O 全程使用 UTF-8，避免中文輸入出現 surrogate 編碼錯誤
ENV PYTHONUTF8=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY scripts/ ./scripts/

RUN mkdir -p /app/data

CMD ["python", "src/main.py"]
