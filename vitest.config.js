import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/*.spec.mjs"],
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
