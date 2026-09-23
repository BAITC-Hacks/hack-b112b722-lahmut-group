import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    watch: { ignored: ["**/test-results/**", "**/playwright-report/**"] },
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
});
