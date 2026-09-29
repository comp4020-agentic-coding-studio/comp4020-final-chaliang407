import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// PORT comes from fly.toml's env (default 8080 locally too); host: true binds
// 0.0.0.0, which the Fly proxy needs to reach the container.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone", host: true }),
});
