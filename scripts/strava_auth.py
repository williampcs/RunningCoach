"""Strava OAuth 一次性授權腳本.

使用方式 A（推薦）：在本機執行，token 再複製到 VM
─────────────────────────────────────────────────────
  python scripts/strava_auth.py

  → 開啟瀏覽器完成 Strava 授權
  → 終端顯示 access_token / refresh_token / expires_at
  → 在 VM 上執行以下指令將 token 存入 DB：
      docker compose run --rm coach-bot python scripts/strava_auth.py --import-token

使用方式 B：在 VM 上執行，用 SSH port forwarding 接 callback
─────────────────────────────────────────────────────
  # 先在本機開 SSH tunnel
  ssh -L 8080:localhost:8080 your-vm
  # 在 VM 上（容器內）執行
  docker compose run --rm -p 8080:8080 coach-bot python scripts/strava_auth.py
  # 複製輸出 URL 到本機瀏覽器開啟

Strava App redirect_uri 設定：http://localhost:8080/callback
"""
import os
import sys
import json
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

# 載入 .env
_env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip())

import config
import memory.db as db

REDIRECT_URI = "http://localhost:8080/callback"
AUTH_URL = (
    f"https://www.strava.com/oauth/authorize"
    f"?client_id={config.STRAVA_CLIENT_ID}"
    f"&redirect_uri={REDIRECT_URI}"
    f"&response_type=code"
    f"&scope=activity:read_all"
)

_auth_code: str | None = None


class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global _auth_code
        parsed = urlparse(self.path)
        if parsed.path == "/callback":
            params = parse_qs(parsed.query)
            if "code" in params:
                _auth_code = params["code"][0]
                self.send_response(200)
                self.end_headers()
                self.wfile.write(
                    b"<h2>Strava \u6388\u6b0a\u6210\u529f\uff01\u8acb\u56de\u5230\u7d42\u7aef\u67e5\u770b token\u3002</h2>"
                )
            else:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"<h2>Error: no code received.</h2>")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # 抑制 HTTP log


def _exchange_code(code: str) -> dict:
    import requests
    resp = requests.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id":     config.STRAVA_CLIENT_ID,
            "client_secret": config.STRAVA_CLIENT_SECRET,
            "code":          code,
            "grant_type":    "authorization_code",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def do_auth():
    """執行 OAuth 授權流程，取得 token 後印出。"""
    if not config.STRAVA_CLIENT_ID or not config.STRAVA_CLIENT_SECRET:
        print("錯誤：請先在 .env 設定 STRAVA_CLIENT_ID 與 STRAVA_CLIENT_SECRET")
        sys.exit(1)

    print(f"\n請在瀏覽器完成 Strava 授權：\n{AUTH_URL}\n")
    try:
        webbrowser.open(AUTH_URL)
        print("（若瀏覽器未自動開啟，請手動複製上方 URL 貼入瀏覽器）\n")
    except Exception:
        pass

    print("等待 Strava callback（localhost:8080）...")
    server = HTTPServer(("0.0.0.0", 8080), _CallbackHandler)
    server.handle_request()  # 只處理一次請求就結束

    if not _auth_code:
        print("錯誤：未收到授權碼")
        sys.exit(1)

    print("收到授權碼，正在換取 token...")
    data = _exchange_code(_auth_code)

    access_token  = data["access_token"]
    refresh_token = data["refresh_token"]
    expires_at    = data["expires_at"]

    print("\n✅ 授權成功！以下是你的 Strava Token：")
    print(f"  access_token  = {access_token}")
    print(f"  refresh_token = {refresh_token}")
    print(f"  expires_at    = {expires_at}")
    print(
        "\n在 VM 上執行以下指令將 token 存入 DB：\n"
        "  docker compose run --rm coach-bot python scripts/strava_auth.py --import-token\n"
    )


def do_import_token():
    """互動式輸入 token 並存入 DB（在 VM 容器內執行）。"""
    db.init_db()
    print("將 Strava token 存入 DB\n")
    access_token  = input("access_token  : ").strip()
    refresh_token = input("refresh_token : ").strip()
    expires_at    = input("expires_at    : ").strip()

    if not access_token or not refresh_token or not expires_at:
        print("錯誤：所有欄位都必須填入")
        sys.exit(1)

    db.save_strava_token(access_token, refresh_token, int(expires_at))
    print("✅ Token 已儲存至 DB，Bot 重啟後自動生效。")


if __name__ == "__main__":
    if "--import-token" in sys.argv:
        do_import_token()
    else:
        do_auth()
