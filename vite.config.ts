import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    base: "./",
    plugins: [react()],
    define: {
      "import.meta.env.WARGAME_MODEL": JSON.stringify(env.WARGAME_MODEL || "deepseek-flash"),
    },
    server: {
      proxy: {
        "/api/deepseek": {
          target: "https://api.deepseek.com",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/deepseek/, ""),
          headers: {
            Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
          },
        },
      },
    },
  };
});
