import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { collectOffenders, diffAgainstBaseline } from "./check-workspace-attribution.mjs"

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "wa-gate-"))
  for (const [rel, source] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, source)
  }
  return root
}

test("flags a new top-level projection read", () => {
  const root = fixture({
    "components/x.tsx": "const s = useChatStore((s) => s.status)\n",
  })
  try {
    assert.deepEqual(collectOffenders(root), { "components/x.tsx": { projection: 1, cwd: 0 } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("accepts a session-keyed read", () => {
  // The whole point: keying by session is the fix, so it must not be flagged.
  const root = fixture({
    "components/x.tsx": "const s = useSessionStatus(sessionId)\n",
  })
  try {
    assert.deepEqual(collectOffenders(root), {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("does not flag a field read off somebody else's object", () => {
  // `slice.status` and `row.status` are not the projection.
  const root = fixture({
    "components/x.tsx": "const a = slice.status\nconst b = row.messages\n",
  })
  try {
    assert.deepEqual(collectOffenders(root), {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("flags a legacy rootDir cwd derivation", () => {
  const root = fixture({
    "lib/x.ts": "const cwd = project?.rootDir ?? undefined\n",
  })
  try {
    assert.deepEqual(collectOffenders(root), { "lib/x.ts": { projection: 0, cwd: 1 } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("exempts tests, stories and the store that owns the projection", () => {
  const root = fixture({
    "components/x.test.tsx": "useChatStore((s) => s.status)\n",
    "components/x.stories.tsx": "useChatStore((s) => s.status)\n",
    "stores/chat/chat-store.ts": "useChatStore((s) => s.status)\n",
    "lib/chat/aggregate-run-state.ts": "useChatStore((s) => s.status)\n",
  })
  try {
    assert.deepEqual(collectOffenders(root), {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("passes when every offender is baselined", () => {
  const offenders = { "components/x.tsx": { projection: 1, cwd: 0 } }
  const diff = diffAgainstBaseline(offenders, { "components/x.tsx": { projection: 1, cwd: 0 } })
  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.grew, [])
})

test("fails on a file that is not in the baseline at all", () => {
  const diff = diffAgainstBaseline({ "components/new.tsx": { projection: 1, cwd: 0 } }, {})
  assert.equal(diff.added.length, 1)
})

test("fails when a baselined file gains an occurrence", () => {
  // A file already carrying one legitimate read must not become a place to
  // quietly add more.
  const diff = diffAgainstBaseline(
    { "components/x.tsx": { projection: 2, cwd: 0 } },
    { "components/x.tsx": { projection: 1, cwd: 0 } }
  )
  assert.equal(diff.grew.length, 1)
})

test("allows a baselined file to shrink", () => {
  const diff = diffAgainstBaseline(
    { "components/x.tsx": { projection: 1, cwd: 0 } },
    { "components/x.tsx": { projection: 3, cwd: 2 } }
  )
  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.grew, [])
})

test("reports a baselined file that became clean", () => {
  const diff = diffAgainstBaseline({}, { "components/x.tsx": { projection: 1, cwd: 0 } })
  assert.deepEqual(diff.fixed, ["components/x.tsx"])
})
