import { defineConfig } from "vite";
import { walletApi } from "./server/walletApi.ts";

// Relative base so the static build works from any path (e.g. GitHub Pages at /GraphXRP/).
// The wallet API only exists on the local dev/preview server, never in the static build.
export default defineConfig({
  base: "./",
  plugins: [walletApi()],
  // The wallets chunk is mostly xrpl.js (~650 kB) and only loads when running locally.
  build: { chunkSizeWarningLimit: 800 },
});
