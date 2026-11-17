// Config for `npm run verify`: the start-verdict verification
// (src/verify/*.verify.ts), kept out of the plain `npm test` run.
// See .claude/skills/verify-start-verdict/SKILL.md.
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ["src/verify/**/*.verify.ts"],
    testTimeout: 600_000,
  },
}));
