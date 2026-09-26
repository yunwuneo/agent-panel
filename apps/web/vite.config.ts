import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.RELAY_URL || "http://localhost:8787", changeOrigin: false },
      "/ws": {
        target: process.env.RELAY_URL || "http://localhost:8787",
        ws: true,
        changeOrigin: false,
      },
    },
  },
});
