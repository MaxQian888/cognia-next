/**
 * Golden regression fixture for the CI eval gate (`pnpm test:evals`).
 *
 * Each entry pairs an {@link EvalCase} (with a reference) and a RECORDED
 * {@link EvalSample} — a known-good trajectory. The CI gate re-scores these
 * with the deterministic tier and asserts thresholds hold, so a regression in
 * scorer logic (or an accidentally-edited reference) fails the build without
 * needing a live model. Append real recorded samples here as the dataset grows
 * — this is the checked-in seed of the eval flywheel.
 */

import type { EvalCase, EvalSample } from "@/types/eval/eval"

export interface GoldenEntry {
  case: EvalCase
  sample: EvalSample
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

export const GOLDEN_ENTRIES: GoldenEntry[] = [
  {
    case: {
      id: "golden-read-file",
      datasetId: "golden",
      input: "Read the contents of config.json and summarize it.",
      capability: "chat.tool-use",
      source: "handwritten",
      reference: {
        expectedTools: ["Read"],
        expectedToolArgs: { Read: { path: "config.json" } },
        expectedContains: ["config"],
      },
      createdAt: 0,
      updatedAt: 0,
    },
    sample: {
      output: "The config.json file defines the app config: name, version, and ports.",
      toolCalls: [{ name: "Read", index: 0, args: { path: "config.json" } }],
      retrievedChunks: [],
      usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0.004,
      latencyMs: 900,
      stepCount: 2,
      degraded: false,
    },
  },
  {
    case: {
      id: "golden-grep-edit",
      datasetId: "golden",
      input: "Find the TODO in utils.ts and remove it.",
      capability: "chat.tool-use",
      source: "handwritten",
      reference: {
        expectedTools: ["Grep", "Edit"],
        expectedContains: ["removed"],
      },
      createdAt: 0,
      updatedAt: 0,
    },
    sample: {
      output: "I found the TODO comment in utils.ts and removed it.",
      toolCalls: [
        { name: "Grep", index: 0, args: { pattern: "TODO", path: "utils.ts" } },
        { name: "Edit", index: 1, args: { path: "utils.ts" } },
      ],
      retrievedChunks: [],
      usage: { inputTokens: 200, outputTokens: 60, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0.007,
      latencyMs: 1500,
      stepCount: 3,
      degraded: false,
    },
  },
  {
    case: {
      id: "golden-rag-recall",
      datasetId: "golden",
      input: "What is our refund policy?",
      capability: "chat.rag",
      source: "handwritten",
      reference: {
        expectedContext: ["Refunds are available within 30 days"],
        expectedContains: ["30 days"],
      },
      createdAt: 0,
      updatedAt: 0,
    },
    sample: {
      output: "Refunds are available within 30 days of purchase.",
      toolCalls: [],
      retrievedChunks: [
        { text: "Refunds are available within 30 days of purchase, no questions asked." },
      ],
      usage: emptyUsage(),
      costUsd: 0.002,
      latencyMs: 600,
      stepCount: 1,
      degraded: false,
    },
  },
]
