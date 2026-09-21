import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  REASONS,
  compare,
  detectEntries,
  hasLedgerSeam,
  isScannedFile,
  lexSource,
  loadBaseline,
  parseArgs,
  runAudit,
} from "./check-llm-ledger-boundary.mjs"

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-llm-ledger-boundary.mjs")

function fixture(files, baseline) {
  const root = mkdtempSync(join(tmpdir(), "llm-ledger-gate-"))
  for (const [rel, source] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, source)
  }
  const baselinePath = join(root, "baseline.json")
  writeFileSync(baselinePath, JSON.stringify({ files: baseline }, null, 2))
  return { root, baselinePath }
}

function withFixture(files, baseline, check) {
  const { root, baselinePath } = fixture(files, baseline)
  try {
    check(root, baselinePath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function runCli(root, baselinePath) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, "--baseline", baselinePath], {
    encoding: "utf8",
  })
}

const GENERATES =
  'import { generateText } from "ai"\nexport const go = (m) => generateText({ model: m })\n'
const LEDGERED =
  'import { createLlmClient } from "@/lib/twin/distill/llm"\n' +
  'import { ledgerUtilityCalls } from "@/lib/router-fusion/gate/utility-ledger"\n' +
  "export const client = (c, s) => ledgerUtilityCalls(createLlmClient(c), s)\n"

// ── Lexing ──────────────────────────────────────────────────────────────────

test("lexSource blanks comments in code, and strings and regexes in bare", () => {
  const source = [
    "// generateText in a comment",
    'const a = "streamText" /* generateObject */',
    "const re = /[\"']/g; const b = generateText",
    "const t = `${base}/chat/completions`",
  ].join("\n")
  const { code, bare, strings } = lexSource(source)
  assert.equal(code.length, source.length)
  assert.equal(bare.length, source.length)
  assert.doesNotMatch(code, /generateObject|in a comment/)
  assert.match(code, /"streamText"/)
  assert.doesNotMatch(bare, /streamText/)
  // The quote inside the regex literal did not open a string that ate the line.
  assert.match(bare, /const b = generateText/)
  assert.ok(strings.includes("/chat/completions"))
})

// ── Detection ───────────────────────────────────────────────────────────────

test("finds AI SDK generation imports in every runtime form", () => {
  assert.deepEqual(detectEntries("lib/a.ts", GENERATES), ["ai:generateText"])
  assert.deepEqual(
    detectEntries(
      "lib/b.ts",
      'import {\n  embed,\n  generateText as gen,\n  streamObject,\n} from "ai"\n'
    ),
    ["ai:generateText", "ai:streamObject"]
  )
  assert.deepEqual(
    detectEntries("lib/c.ts", 'const run = async () => (await import("ai")).streamText({})\n'),
    ["ai:streamText"]
  )
  assert.deepEqual(
    detectEntries(
      "lib/d.ts",
      'async function f() {\n  const { generateText } = await import("ai")\n}\n'
    ),
    ["ai:generateText"]
  )
  assert.deepEqual(
    detectEntries(
      "lib/e.ts",
      'import * as sdk from "ai"\nexport const f = () => sdk.generateObject({})\n'
    ),
    ["ai:generateObject"]
  )
  assert.deepEqual(detectEntries("sidecar/f.mjs", 'const { streamText } = require("ai")\n'), [
    "ai:streamText",
  ])
})

test("ignores type-only use, out-of-scope APIs, comments and strings", () => {
  const cases = [
    'import type { LanguageModel } from "ai"\n',
    'import { type LanguageModel, type UIMessage } from "ai"\n',
    'type Gen = typeof import("ai").generateText\nlet m: import("ai").LanguageModel\n',
    // D27: embeddings, speech, media and rerank are not generation for this gate.
    'import { embed, embedMany, generateSpeech, generateImage, rerank } from "ai"\n',
    // An embedding-only dynamic import next to a comment and a string naming generateText.
    'const { embed } = await import("ai") // not generateText\nconst s = "streamText"\n',
    '/**\n * import { generateText } from "ai"\n */\nexport {}\n',
  ]
  for (const source of cases) assert.deepEqual(detectEntries("lib/x.ts", source), [], source)
})

test("finds provider SDKs, Agent SDK model loops and direct model calls", () => {
  assert.deepEqual(detectEntries("lib/a.ts", 'import Anthropic from "@anthropic-ai/sdk"\n'), [
    "provider-sdk:@anthropic-ai/sdk",
  ])
  assert.deepEqual(detectEntries("lib/b.ts", 'const OpenAI = (await import("openai")).default\n'), [
    "provider-sdk:openai",
  ])
  assert.deepEqual(
    detectEntries("lib/c.ts", 'import type { Message } from "@anthropic-ai/sdk/resources"\n'),
    []
  )
  assert.deepEqual(
    detectEntries(
      "sidecar/d.mjs",
      'import { query as sdkQuery, tool } from "@anthropic-ai/claude-agent-sdk"\n'
    ),
    ["agent-sdk:query"]
  )
  assert.deepEqual(
    detectEntries(
      "sidecar/e.mjs",
      'import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"\n'
    ),
    []
  )
  assert.deepEqual(detectEntries("sidecar/f.mjs", "const r = await model.doStream(options)\n"), [
    "language-model:doStream",
  ])
})

test("tracks the raw LlmClient factory under both names and both modules", () => {
  assert.deepEqual(detectEntries("lib/a.ts", LEDGERED), ["llm-client:createLlmClient"])
  assert.deepEqual(
    detectEntries("lib/twin/distill/b.ts", 'import { createLlmClient } from "./llm"\n'),
    ["llm-client:createLlmClient"]
  )
  assert.deepEqual(
    detectEntries(
      "lib/twin/c.ts",
      'import { createAnthropicLlmClient } from "@/lib/twin/distill"\n'
    ),
    ["llm-client:createAnthropicLlmClient"]
  )
  assert.deepEqual(
    detectEntries(
      "lib/workflow/d.ts",
      'const { createLlmClient } = await import("@/lib/twin/distill/llm")\n'
    ),
    ["llm-client:createLlmClient"]
  )
  assert.deepEqual(
    detectEntries("lib/e.ts", 'import type { LlmClient } from "@/lib/twin/distill/llm"\n'),
    []
  )
  // A different module that happens to export the same name is not the factory.
  assert.deepEqual(detectEntries("lib/f.ts", 'import { createLlmClient } from "./my-llm"\n'), [])
})

test("finds generation endpoints in literals, not look-alikes", () => {
  assert.deepEqual(
    detectEntries("lib/a.ts", 'const URL = "https://api.anthropic.com/v1/messages"\n'),
    ["endpoint:anthropic-messages"]
  )
  assert.deepEqual(
    detectEntries(
      "packages/p/src/b.ts",
      'const u = `${base.replace(/\\/+$/, "")}/chat/completions`\n' +
        "const g = `${GEMINI}/${model}:generateContent?key=${key}`\n"
    ),
    ["endpoint:chat-completions", "endpoint:gemini-generate-content"]
  )
  const lookAlikes = [
    // Lark's IM API, not a model.
    "const u = `${LARK}/im/v1/messages?receive_id_type=${t}`\n",
    'const c = "https://api.anthropic.com/v1/messages/count_tokens"\n',
    "// POST https://api.anthropic.com/v1/messages\nexport {}\n",
  ]
  for (const source of lookAlikes) assert.deepEqual(detectEntries("lib/x.ts", source), [], source)
})

test("scans production sources only", () => {
  assert.equal(isScannedFile("lib/ai/x.ts"), true)
  assert.equal(isScannedFile("sidecar/dispatch/x.mjs"), true)
  assert.equal(isScannedFile("packages/rag/src/x.ts"), true)
  assert.equal(isScannedFile("packages/rag/scripts/x.ts"), false)
  assert.equal(isScannedFile("lib/ai/x.test.ts"), false)
  assert.equal(isScannedFile("components/x.stories.tsx"), false)
  assert.equal(isScannedFile("lib/types/x.d.ts"), false)
  assert.equal(isScannedFile("lib/x/fixtures/probe.ts"), false)
  assert.equal(isScannedFile("sidecar/vscode-ext-host/tests/x.js"), false)
  assert.equal(isScannedFile("cli/src/api/generated/index.ts"), false)
  assert.equal(isScannedFile("lib/x/data.json"), false)
})

test("a ledgered-entry file must show its ledger seam", () => {
  assert.equal(hasLedgerSeam("lib/a.ts", LEDGERED), true)
  assert.equal(hasLedgerSeam("lib/router-fusion/calls/x.ts", GENERATES), true)
  assert.equal(
    hasLedgerSeam(
      "sidecar/d.mjs",
      'import { createCallLedgerGate } from "./call-ledger-gate.mjs"\n'
    ),
    true
  )
  assert.equal(hasLedgerSeam("lib/b.ts", "// ledgerUtilityCalls, one day\n" + GENERATES), false)
})

// ── Baseline ────────────────────────────────────────────────────────────────

test("the baseline vocabulary is fixed and every row is complete", () => {
  const row = { reason: "unwrapped", entries: ["ai:generateText"], note: "why" }
  const bad = [
    { ...row, reason: "because" },
    { ...row, note: " " },
    { ...row, entries: [] },
    { ...row, entries: ["ai:generateText", "ai:generateText"] },
    { ...row, seam: "lib/other.ts" }, // a seam only belongs on a ledgered-entry row
    { ...row, reason: "ledgered-entry", seam: "lib/a.ts" }, // …and names another file
  ]
  for (const value of bad) {
    withFixture({}, { "lib/a.ts": value }, (_root, baselinePath) =>
      assert.throws(() => loadBaseline(baselinePath), /Invalid LLM ledger boundary baseline/)
    )
  }
  assert.deepEqual(Object.keys(REASONS).sort(), [
    "client-factory",
    "d27-out-of-scope",
    "ledgered-entry",
    "not-a-provider-call",
    "unwrapped",
  ])
})

test("the repository baseline is well formed", () => {
  const rows = loadBaseline()
  assert.ok(Object.keys(rows).length > 0)
  for (const [file, row] of Object.entries(rows)) {
    assert.ok(isScannedFile(file), `${file} is not a scanned production file`)
    assert.deepEqual([...row.entries].sort(), row.entries, `${file}: keep entries sorted`)
  }
})

test("compare reports unlisted files and entries, stale rows and unproven claims", () => {
  const found = {
    "lib/new.ts": ["ai:generateText"],
    "lib/grew.ts": ["ai:generateText", "ai:streamText"],
    "lib/claims.ts": ["ai:generateText"],
  }
  const baseline = {
    "lib/grew.ts": { reason: "unwrapped", entries: ["ai:generateText"], note: "n" },
    "lib/claims.ts": { reason: "ledgered-entry", entries: ["ai:generateText"], note: "n" },
    "lib/gone.ts": { reason: "unwrapped", entries: ["ai:streamText"], note: "n" },
  }
  const result = compare(found, baseline, () => GENERATES)
  assert.deepEqual(result.unlisted, [
    { file: "lib/grew.ts", entries: ["ai:streamText"] },
    { file: "lib/new.ts", entries: ["ai:generateText"] },
  ])
  assert.deepEqual(result.stale, [{ file: "lib/gone.ts", entries: ["ai:streamText"] }])
  assert.deepEqual(result.unproven, [{ file: "lib/claims.ts", seam: "lib/claims.ts" }])
})

// ── Fixture trees, through runAudit and the CLI entry point ─────────────────

const CLEAN_TREE = {
  "lib/ai/renderer-client.ts": LEDGERED,
  "lib/ai/unwrapped.ts": GENERATES,
  "lib/ai/unwrapped.test.ts": GENERATES, // tests are never scanned
  "sidecar/dispatch/adapter.mjs": 'const s = (await import("ai")).streamText\n',
  "sidecar/dispatch/dispatcher.mjs":
    'import { createCallLedgerGate } from "./call-ledger-gate.mjs"\nexport const g = createCallLedgerGate\n',
  "packages/ocr/src/vision.ts": 'const E = "https://api.openai.com/v1/chat/completions"\n',
  "lib/plain.ts": "export const x = 1\n",
}
const CLEAN_BASELINE = {
  "lib/ai/renderer-client.ts": {
    reason: "ledgered-entry",
    entries: ["llm-client:createLlmClient"],
    note: "wrapped",
  },
  "lib/ai/unwrapped.ts": { reason: "unwrapped", entries: ["ai:generateText"], note: "follow-up" },
  "sidecar/dispatch/adapter.mjs": {
    reason: "ledgered-entry",
    entries: ["ai:streamText"],
    seam: "sidecar/dispatch/dispatcher.mjs",
    note: "reserved by its caller",
  },
  "packages/ocr/src/vision.ts": {
    reason: "d27-out-of-scope",
    entries: ["endpoint:chat-completions"],
    note: "OCR",
  },
}

test("a fully reviewed tree passes, through runAudit and the CLI", () => {
  withFixture(CLEAN_TREE, CLEAN_BASELINE, (root, baselinePath) => {
    const result = runAudit(root, baselinePath)
    assert.deepEqual(result.unlisted, [])
    assert.deepEqual(result.stale, [])
    assert.deepEqual(result.unproven, [])
    const cli = runCli(root, baselinePath)
    assert.equal(cli.status, 0, cli.stderr)
    assert.match(
      cli.stdout,
      /^\[llm-ledger-boundary\] OK: 6 production files scanned; 4 reviewed file\(s\): 2 ledgered-entry, 1 unwrapped, 1 exempt\.$/m
    )
  })
})

test("a new file with a direct generation call fails", () => {
  const tree = { ...CLEAN_TREE, "hooks/use-new-feature.ts": GENERATES }
  withFixture(tree, CLEAN_BASELINE, (root, baselinePath) => {
    assert.deepEqual(runAudit(root, baselinePath).unlisted, [
      { file: "hooks/use-new-feature.ts", entries: ["ai:generateText"] },
    ])
    const cli = runCli(root, baselinePath)
    assert.equal(cli.status, 1)
    assert.match(cli.stderr, /1 file\(s\) with unreviewed direct LLM generation calls/)
    assert.match(cli.stderr, /hooks\/use-new-feature\.ts -> ai:generateText/)
  })
})

test("a stale baseline row fails: the list may only shrink", () => {
  // The unwrapped file was fixed (it now goes through the ledgered client).
  const tree = {
    ...CLEAN_TREE,
    "lib/ai/unwrapped.ts": 'export { client } from "./renderer-client"\n',
  }
  withFixture(tree, CLEAN_BASELINE, (root, baselinePath) => {
    assert.deepEqual(runAudit(root, baselinePath).stale, [
      { file: "lib/ai/unwrapped.ts", entries: ["ai:generateText"] },
    ])
    const cli = runCli(root, baselinePath)
    assert.equal(cli.status, 1)
    assert.match(cli.stderr, /1 stale baseline row\(s\) \(the list may only shrink\)/)
    assert.match(cli.stderr, /lib\/ai\/unwrapped\.ts -> ai:generateText/)
  })
})

test("a ledgered-entry that loses its seam fails", () => {
  const tree = {
    ...CLEAN_TREE,
    "lib/ai/renderer-client.ts":
      'import { createLlmClient } from "@/lib/twin/distill/llm"\nexport const client = createLlmClient\n',
    "sidecar/dispatch/dispatcher.mjs": "export const g = null\n",
  }
  withFixture(tree, CLEAN_BASELINE, (root, baselinePath) => {
    assert.deepEqual(runAudit(root, baselinePath).unproven, [
      { file: "lib/ai/renderer-client.ts", seam: "lib/ai/renderer-client.ts" },
      { file: "sidecar/dispatch/adapter.mjs", seam: "sidecar/dispatch/dispatcher.mjs" },
    ])
    const cli = runCli(root, baselinePath)
    assert.equal(cli.status, 1)
    assert.match(cli.stderr, /2 ledgered-entry row\(s\) with no ledger seam/)
    assert.match(
      cli.stderr,
      /sidecar\/dispatch\/adapter\.mjs \(seam: sidecar\/dispatch\/dispatcher\.mjs\)/
    )
  })
})

test("the CLI rejects unknown arguments", () => {
  assert.throws(() => parseArgs(["--write-baseline"]), /Unknown argument/)
  assert.throws(() => parseArgs(["--root"]), /needs a value/)
})
