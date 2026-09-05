import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // The board asks its own origin for /api, because that is what the container does -
    // nginx proxies it across to the sync service. In dev vite and the api are two
    // processes on two ports, so vite proxies it the same way and the board cannot tell
    // the difference. Same origin, no cors, and nothing to point anywhere by hand.
    //
    // The api strips the /api itself, so there is no rewrite here.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4320",
        changeOrigin: true,
      },
    },
  },
});
