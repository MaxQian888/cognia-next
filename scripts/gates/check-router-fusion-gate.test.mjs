import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  classifySpecifier,
  collectViolations,
  runtimeSpecifiers,
} from "./check-router-fusion-gate.mjs"

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "rf-gate-"))
  for (const [rel, source] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, source)
  }
  return root
}

function withFixture(files, check) {
  const root = fixture(files)
  try {
    check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("classifies the gate, the switch leaf, the engine and host modules", () => {
  assert.equal(classifySpecifier("@/lib/router-fusion/gate/chat-send", "hooks/x.ts"), "gate")
  assert.equal(classifySpecifier("@cognia/router-fusion/settings/switches", "lib/x.ts"), "switches")
  assert.equal(classifySpecifier("@cognia/router-fusion", "lib/x.ts"), "engine")
  assert.equal(classifySpecifier("@cognia/router-fusion/settings/settings", "lib/x.ts"), "engine")
  assert.equal(classifySpecifier("@/lib/router-fusion/host", "lib/x.ts"), "host")
  assert.equal(classifySpecifier("../chat/chat-runs", "lib/router-fusion/gate/x.ts"), "host")
  assert.equal(classifySpecifier("./breaker", "lib/router-fusion/gate/x.ts"), "gate")
  assert.equal(classifySpecifier("@/lib/claude/ipc", "lib/x.ts"), "other")
})

test("reads runtime imports and skips type-only ones", () => {
  const source = [
    'import type { A } from "@/lib/router-fusion/host"',
    'import { type B, type C } from "@cognia/router-fusion"',
    'import { d, type E } from "@/lib/router-fusion/chat/chat-runs"',
    'export { f } from "@cognia/router-fusion/money/microusd"',
    'export type { G } from "@/lib/router-fusion/db/types"',
    'import "@/lib/router-fusion/db/fusion-db"',
    'const h = require("@cognia/router-fusion")',
    'const i = await import("@/lib/router-fusion/host")',
    "import {",
    "  multi,",
    "  line,",
    '} from "@/lib/router-fusion/gate/chat-events"',
  ].join("\n")
  assert.deepEqual(runtimeSpecifiers(source), [
    "@/lib/router-fusion/chat/chat-runs",
    "@cognia/router-fusion/money/microusd",
    "@/lib/router-fusion/db/fusion-db",
    "@/lib/router-fusion/gate/chat-events",
    "@cognia/router-fusion",
  ])
})

test("passes a shared module that uses only the gate, the switch leaf and dynamic imports", () => {
  withFixture(
    {
      "lib/claude/build-options.ts": [
        'import { routerFusionGate } from "@/lib/router-fusion/gate/feature-gate"',
        'import { effectiveSurface } from "@cognia/router-fusion/settings/switches"',
        'import type { ChatSeal } from "@/lib/router-fusion/host"',
        'const host = await import("@/lib/router-fusion/host")',
      ].join("\n"),
    },
    (root) => assert.deepEqual(collectViolations(root), [])
  )
})

test("[ACC:OFF-03] fails a shared module that statically imports the engine or a host module", () => {
  withFixture(
    {
      "hooks/chat/claude-chat-events.ts":
        'import { finalizeChatRun } from "@/lib/router-fusion/chat/chat-runs"\n',
      "lib/claude/ipc.ts": 'import { usdToMicrousd } from "@cognia/router-fusion"\n',
    },
    (root) =>
      assert.deepEqual(collectViolations(root), [
        { file: "lib/claude/ipc.ts", specifier: "@cognia/router-fusion", kind: "engine" },
        {
          file: "hooks/chat/claude-chat-events.ts",
          specifier: "@/lib/router-fusion/chat/chat-runs",
          kind: "host",
        },
      ])
  )
})

test("holds the gate itself to the same rule, and leaves the host and tests alone", () => {
  withFixture(
    {
      "lib/router-fusion/gate/leaky.ts":
        'import { currentFusionStore } from "../chat/store-provider"\n',
      "lib/router-fusion/gate/fine.ts": 'import { recordFusionFault } from "./breaker"\n',
      "lib/router-fusion/chat/chat-runs.ts":
        'import { compileFusionConfig } from "@cognia/router-fusion"\n',
      "hooks/chat/x.test.ts":
        'import { finalizeChatRun } from "@/lib/router-fusion/chat/chat-runs"\n',
    },
    (root) =>
      assert.deepEqual(collectViolations(root), [
        {
          file: "lib/router-fusion/gate/leaky.ts",
          specifier: "../chat/store-provider",
          kind: "host",
        },
      ])
  )
})

test("honours the allowlist for the settings section", () => {
  withFixture(
    {
      "components/settings/provider/routing/router-fusion-section.tsx":
        'import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"\n',
    },
    (root) => assert.deepEqual(collectViolations(root), [])
  )
})
