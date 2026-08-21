/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { computeSequenceDigest } from "@cognia/agent-config-types/canonical-session"
import type { CanonicalSession } from "@cognia/agent-config-types/canonical-session"

import {
  deleteCanonicalSessionHeader,
  findByNativeSessionId,
  getCanonicalSessionHeader,
  headerRowFromCanonical,
  listCanonicalSessionHeaders,
  putCanonicalSessionHeader,
} from "./agent-canonical-sessions"

function session(
  id: string,
  overrides: Partial<CanonicalSession["header"]> = {}
): CanonicalSession {
  const turns = [{ turnId: "t1", role: "user" as const, text: "q" }]
  return {
    header: {
      canonicalVersion: 1,
      canonicalSessionId: id,
      sourceRuntime: "claude-code",
      runtimeBinding: { nativeSessionId: `native-${id}` },
      title: "T",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:01.000Z",
      turnCount: 1,
      importFidelity: "structured",
      sequenceDigest: computeSequenceDigest(turns),
      ...overrides,
    },
    turns,
  }
}

describe("agentCanonicalSessions projection", () => {
  it("projects a header row (no turn content) and round-trips through Dexie", async () => {
    const row = headerRowFromCanonical(session("cs-1"), {
      fidelity: "structured",
      losses: [{ path: "turns[0].reasoning", kind: "dropped" }],
      rebuilt: true,
    })
    expect(row).toMatchObject({
      canonicalSessionId: "cs-1",
      sourceRuntime: "claude-code",
      nativeSessionId: "native-cs-1",
      turnCount: 1,
      importFidelity: "structured",
      lossCount: 1,
      rebuilt: true,
    })
    expect(JSON.stringify(row)).not.toContain('"text"')

    await putCanonicalSessionHeader(row)
    expect(await getCanonicalSessionHeader("cs-1")).toEqual(row)
    expect(await findByNativeSessionId("native-cs-1")).toEqual(row)
    expect(await findByNativeSessionId("")).toBeUndefined()

    await deleteCanonicalSessionHeader("cs-1")
    expect(await getCanonicalSessionHeader("cs-1")).toBeUndefined()
  })

  it("lists by recency and filters by source runtime", async () => {
    const older = headerRowFromCanonical(
      session("cs-old", { updatedAt: "2026-07-20T00:00:00.000Z" }),
      { fidelity: "structured", losses: [] }
    )
    const newer = headerRowFromCanonical(
      session("cs-new", { updatedAt: "2026-07-24T00:00:00.000Z" }),
      { fidelity: "structured", losses: [] }
    )
    const codex = headerRowFromCanonical(session("cs-codex", { sourceRuntime: "codex" }), {
      fidelity: "structured",
      losses: [],
    })
    await putCanonicalSessionHeader(older)
    await putCanonicalSessionHeader(newer)
    await putCanonicalSessionHeader(codex)

    const all = await listCanonicalSessionHeaders()
    expect(all.map((r) => r.canonicalSessionId)).toContain("cs-new")
    expect(all[0].updatedAt).toBeGreaterThanOrEqual(all[all.length - 1].updatedAt)

    const codexOnly = await listCanonicalSessionHeaders({ sourceRuntime: "codex" })
    expect(codexOnly.map((r) => r.canonicalSessionId)).toEqual(["cs-codex"])
  })
})

describe("write-only dormancy (Working Rule 7)", () => {
  it("has exactly one production writer and no production reader", async () => {
    // The module doc claims this projection is written on import and read by
    // nothing yet, and is kept for ADR-0090 §8's recovery lookup. That claim is
    // only worth writing down if it is checked: when a reader lands, this test
    // fails and the "WRITE-ONLY TODAY" note must be revisited rather than
    // quietly becoming false.
    const { execFileSync } = await import("node:child_process")
    const callers = (pattern: string): string[] =>
      execFileSync(
        "rg",
        ["--no-heading", "-l", pattern, "-g", "*.ts", "-g", "*.tsx", "-g", "!node_modules", "."],
        { cwd: process.cwd(), encoding: "utf8" }
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => line.replace(/^\.\//, ""))
        .filter(
          (file) =>
            !file.endsWith(".test.ts") &&
            !file.endsWith(".test.tsx") &&
            file !== "lib/db/agent-canonical-sessions.ts"
        )

    expect(callers("putCanonicalSessionHeader")).toEqual(["lib/session-import/index.ts"])
    expect(callers("listCanonicalSessionHeaders")).toEqual([])
    expect(callers("getCanonicalSessionHeader")).toEqual([])
    expect(callers("findByNativeSessionId")).toEqual([])
    expect(callers("deleteCanonicalSessionHeader")).toEqual([])
  })
})
