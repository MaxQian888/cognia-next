import { defineConfig } from "vitest/config"

// Opt-in evidence run against the real public signaling host. It performs
// genuine synthetic protocol runs (fresh throwaway rooms, no accounts) and
// prints the CheckObservations; it never submits them for ingestion.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.live.test.ts"],
    testTimeout: 120_000,
    // The printed observations are the evidence; show them for passing tests.
    reporters: ["verbose"],
  },
})
