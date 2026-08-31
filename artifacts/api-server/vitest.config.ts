import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Tests share one dev database, and several files exercise global sweeps
     * (e.g. retryPendingTexts) that claim rows across ALL companies. Run in
     * parallel, one file's sweep can eat another file's fixture mid-test and
     * fail it at random. Serializing the files removes the race; the suite is
     * small enough that the cost is seconds.
     */
    fileParallelism: false,
  },
});
