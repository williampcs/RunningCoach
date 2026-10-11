# Running Coach

AI 跑步教練。`main` 是線上運作的 v1（Python 的 Discord bot，程式在 `src/`）；`v2` 分支正在改寫為 TypeScript（`packages/`、`apps/`）。

## 必須遵守

- **不要 push 或合併到 `main`。** 每次 push 都會觸發 VM 上的自動部署，上一次因此讓 VM 無回應（`doc/known-issues.md` 的 KI-023）。v2 的工作都在 `v2` 分支；其他分支的 push 不會觸發部署。
- **這個 repo 是公開的。** 金鑰、個人的訓練與生理資料、主機名稱與登入資訊都不要寫進會進版控的檔案。

## 文件入口

- `doc/running-coach-spec2_0.md`：v2 規格。第 9 節是進度、尚未驗證的部分、下一步與接手須知；第 11 節是待決定事項。
- `doc/known-issues.md`：決策與問題紀錄（KI 編號），新的決策接續編號寫在這裡。
- `doc/running-coach-spec1_4.md`：v1 規格。

## 指令（v2）

```bash
npm install
npm test
npm run typecheck
```

沒有金鑰時以模擬服務開發與測試，啟動方式見規格 9.3。
