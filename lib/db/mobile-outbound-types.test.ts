/**
 * Spec-parity test for the mobile outbound queue command surface.
 *
 * MOBILE_OUTBOUND_COMMANDS is the single source of truth declared at
 * `lib/db/mobile-outbound-types.ts`. Two adjacent files reference the
 * same names and must not drift:
 *
 *   1. `src-tauri/src/companion_api/rpc.rs` — every queue command must
 *      appear in `KNOWN_COMMANDS` so the runner's drain doesn't 404.
 *
 *   2. `tests/e2e/mobile/outbound-queue.spec.ts` — the COMMAND_KINDS
 *      list MUST match the typed enum so the e2e doesn't fall behind.
 *
 * Gap 3 in the 2026-05-17 audit was caused by both files diverging from
 * the enum without anyone noticing. This test pins them together so a
 * future addition / removal MUST update all three files at once.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { MOBILE_OUTBOUND_COMMANDS, type MobileOutboundJobRow } from "./mobile-outbound-types"

const REPO_ROOT = path.join(__dirname, "..", "..")
const RPC_RS = path.join(REPO_ROOT, "src-tauri", "src", "companion_api", "rpc.rs")
const E2E_SPEC = path.join(REPO_ROOT, "tests", "e2e", "mobile", "outbound-queue.spec.ts")

describe("MOBILE_OUTBOUND_COMMANDS spec parity", () => {
  it("requires the account and runtime target on every queued row", () => {
    const row = {
      id: "job-1",
      accountId: "account-1",
      targetId: "target-1",
      command: MOBILE_OUTBOUND_COMMANDS[0],
      payload: {},
      status: "pending",
      attempts: 0,
      createdAt: 1,
      nextAttemptAt: 1,
      idempotencyKey: "job-1",
    } satisfies MobileOutboundJobRow

    expect(row).toMatchObject({ accountId: "account-1", targetId: "target-1" })
  })
  it("every command appears verbatim in rpc.rs KNOWN_COMMANDS", async () => {
    const src = await fs.readFile(RPC_RS, "utf8")
    for (const cmd of MOBILE_OUTBOUND_COMMANDS) {
      // `"<cmd>"` (quoted form is how KNOWN_COMMANDS lists each entry).
      // Tolerate trailing comma + whitespace by matching the literal.
      expect(src).toContain(`"${cmd}"`)
    }
  })

  it("every command has a dispatch arm in rpc.rs", async () => {
    const src = await fs.readFile(RPC_RS, "utf8")
    // A dispatch arm matches any of these patterns:
    //   1. `"<cmd>" =>`                   single-arm form
    //   2. `| "<cmd>"`                    middle/end of a multi-line pipe group
    //   3. `"<cmd>"\n        | "<other>"` first entry of a multi-line pipe group
    //                                      (followed by whitespace + `|` on next line)
    // Together these cover both how the existing `match name { ... }` body
    // is shaped and how new entries get added.
    for (const cmd of MOBILE_OUTBOUND_COMMANDS) {
      const arrowForm = new RegExp(`"${cmd}"\\s*=>`, "u")
      const pipeBefore = new RegExp(`\\|\\s*"${cmd}"`, "u")
      const pipeAfter = new RegExp(`"${cmd}"\\s*\\n\\s*\\|`, "u")
      const hasArrow = arrowForm.test(src)
      const hasPipeBefore = pipeBefore.test(src)
      const hasPipeAfter = pipeAfter.test(src)
      if (!hasArrow && !hasPipeBefore && !hasPipeAfter) {
        throw new Error(
          `MOBILE_OUTBOUND_COMMANDS["${cmd}"] has no dispatch arm in rpc.rs — ` +
            `add either an explicit \`"${cmd}" =>\` arm or include it in the ` +
            `pipe-separated bridge group near "character_upsert".`
        )
      }
    }
  })

  it("e2e COMMAND_KINDS lists exactly the same set", async () => {
    const src = await fs.readFile(E2E_SPEC, "utf8")
    // The spec declares `const COMMAND_KINDS = [ "..." ] as const`.
    const match = /const COMMAND_KINDS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src)
    expect(match).not.toBeNull()
    const arr = match![1]
    const names = Array.from(arr.matchAll(/"([a-z_]+)"/g)).map((m) => m[1])
    // Set equality both ways — order doesn't matter, but presence does.
    // Both sides widened to `Set<string>` so the `has()` checks across the
    // typed enum vs. parsed-source strings compile without union friction.
    const eSet: Set<string> = new Set(names)
    const aSet: Set<string> = new Set(MOBILE_OUTBOUND_COMMANDS as readonly string[])
    const missingFromE2e = [...aSet].filter((n) => !eSet.has(n))
    const extraInE2e = [...eSet].filter((n) => !aSet.has(n))
    if (missingFromE2e.length || extraInE2e.length) {
      throw new Error(
        `e2e outbound-queue.spec.ts drift detected.\n` +
          `  Missing from e2e: ${JSON.stringify(missingFromE2e)}\n` +
          `  Extra in e2e:    ${JSON.stringify(extraInE2e)}\n` +
          `Reconcile with MOBILE_OUTBOUND_COMMANDS in mobile-outbound-types.ts.`
      )
    }
  })

  it("the enum itself doesn't contain duplicates", () => {
    const set = new Set(MOBILE_OUTBOUND_COMMANDS)
    expect(set.size).toBe(MOBILE_OUTBOUND_COMMANDS.length)
  })

  it("every command name is snake_case", () => {
    const snake = /^[a-z][a-z0-9_]*$/
    for (const cmd of MOBILE_OUTBOUND_COMMANDS) {
      expect(cmd).toMatch(snake)
    }
  })
})
