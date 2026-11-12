import { defineConfig } from "vite";
const base = process.env.QUIETSTATS_PUBLIC_BASE || "/";
if (!["/", "/quietstats/"].includes(base)) throw Error("Invalid public base");
export default defineConfig({
  base,
  build: { sourcemap: false, target: "es2022" },
  server: { host: "127.0.0.1", strictPort: true },
});
