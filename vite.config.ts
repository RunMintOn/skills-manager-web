import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // dev 模式同源化：前端 5173 的 /api 转发给本地 API 服务。
      "/api": {
        target: `http://127.0.0.1:${process.env.SKILLS_MANAGER_PORT ?? "8789"}`,
        changeOrigin: true,
      },
    },
  },
})
