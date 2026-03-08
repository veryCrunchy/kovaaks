import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  build: {
    // recharts bundles D3 and legitimately weighs ~520KB minified — it's lazy-loaded
    // behind the Smoothness tab so it only downloads on demand.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        main: "index.html",
        logs: "logs.html",
        stats: "stats.html",
      },
      output: {
        manualChunks: {
          "vendor-react":    ["react", "react-dom"],
          "vendor-recharts": ["recharts"],
          "vendor-motion":   ["framer-motion"],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
