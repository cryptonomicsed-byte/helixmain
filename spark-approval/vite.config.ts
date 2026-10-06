import { defineConfig } from "vite";

export default defineConfig({
  base: "/spark/",
  server: {
    port: 9101,
    proxy: {
      "/held": "http://localhost:9100",
      "/setup": "http://localhost:9100",
    },
  },
  build: {
    outDir: "dist",
  },
});
