import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Allow importing rulebook.ts and protocol.ts from the parent directory
    fs: {
      allow: [".."],
    },
    port: 5173,
    host: true, // expose on LAN so a phone on the same wifi can load it
  },
});
