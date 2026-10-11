import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  // sqlite-wasm 以相對路徑載入 .wasm，預先打包會讓路徑失效
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
});
