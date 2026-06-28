import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies the API (incl. the SSE stream) to the Python backend.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
  // The vendor chunk is the Tremor/Recharts charting library (a deliberate stack
  // choice); pages are code-split around it. Lift the advisory threshold past it.
  build: { chunkSizeWarningLimit: 900 },
});
