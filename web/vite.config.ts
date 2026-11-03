import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5173,
    // API_PORT: Dashboard gegen einen zweiten Server entwickeln, ohne den laufenden anzufassen
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT ?? "3210"}` },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
