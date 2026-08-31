/**
 * Spec-parity test for the mobile outbound queue command surface.
 *
 * MOBILE_OUTBOUND_COMMANDS is the single source of truth declared at
 * `lib/db/mobile-outbound-types.ts`. One durable queue now feeds TWO
 * transports, and each half answers to a different contract:
 *
 *   Host plane. `liveDispatcher` in
 *   `components/providers/companion-outbound-runner-provider.tsx` sends these
 *   through `transport.call`, i.e. `POST /internal/_rpc/<name>` on the paired
 *   desktop. They must therefore appear in `KNOWN_COMMANDS` so the drain does
 *   not 404, and have a `match` arm in one of the per-domain dispatch
 *   submodules under `src-tauri/src/companion_api/rpc/` (`rpc.rs::dispatch` is
 *   only a thin gate that forwards to `<domain>::dispatch` when the name is in
 *   that domain's `COMMANDS` slice). They must also be listed in
 *   `tests/e2e/mobile/outbound-queue.spec.ts` COMMAND_KINDS, minus the gaps
 *   enumerated with a reason in `E2E_GENERIC_DRAIN_EXCLUSIONS` below.
 *
 *   Collaboration plane (ADR-0149). `liveDispatcher` routes every `collab_`
 *   prefixed name to `dispatchCollabOutbound` instead, which talks to the
 *   collaboration server over its own HTTP client. These never reach the
 *   desktop Host, so `KNOWN_COMMANDS` and the Rust dispatch arms are the wrong
 *   contract for them: listing one there would advertise an RPC that does not
 *   exist, and `cargo test every_known_command_has_a_dispatch_arm` would fail
 *   on the name it cannot find behind it. What they owe instead is a route in
 *   `COLLAB_OUTBOUND_COMMANDS`, pinned below.
 *
 * Gap 3 in the 2026-05-17 audit was caused by these files diverging from
 * the enum without anyone noticing. This test pins them together so a
 * future addition / removal MUST update every file the command's own
 * transport depends on.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { MOBILE_OUTBOUND_COMMANDS, type MobileOutboundJobRow } from "./mobile-outbound-types"

const REPO_ROOT = path.join(__dirname, "..", "..")
const COMPANION_API_DIR = path.join(REPO_ROOT, "src-tauri", "src", "companion_api")
const RPC_RS = path.join(COMPANION_API_DIR, "rpc.rs")
const RPC_DISPATCH_DIR = path.join(COMPANION_API_DIR, "rpc")
const E2E_SPEC = path.join(REPO_ROOT, "tests", "e2e", "mobile", "outbound-queue.spec.ts")
const COLLAB_DISPATCHER = path.join(REPO_ROOT, "lib", "collab", "outbound-dispatcher.ts")

/**
 * The routing rule `liveDispatcher` applies, restated once.
 *
 * It branches on the name prefix rather than on a list, so the prefix is the
 * real boundary between the two transports and this test has to split on the
 * same thing. That the prefix set and the collab dispatcher's own
 * `COLLAB_OUTBOUND_COMMANDS` still agree is a separate claim, asserted below,
 * because a `collab_` command missing from that list reaches a `switch` with no
 * `default`: the drain would mark the row sent having written nothing.
 */
const COLLAB_COMMAND_PREFIX = "collab_"

/** Queue commands that travel to the paired desktop over Companion RPC. */
const HOST_PLANE_COMMANDS = (MOBILE_OUTBOUND_COMMANDS as readonly string[]).filter(
  (command) => !command.startsWith(COLLAB_COMMAND_PREFIX)
)

/** Queue commands the collaboration dispatcher takes off the Host plane. */
const COLLAB_PLANE_COMMANDS = (MOBILE_OUTBOUND_COMMANDS as readonly string[]).filter((command) =>
  command.startsWith(COLLAB_COMMAND_PREFIX)
)

/**
 * Commands that `outbound-queue.spec.ts` deliberately does NOT drive through
 * its generic seed → drain → "sent" loop. Every entry here MUST carry a
 * reason, MUST still exist in `MOBILE_OUTBOUND_COMMANDS` (a stale exclusion
 * fails below), and MUST stay absent from the spec's COMMAND_KINDS (an entry
 * that gains real e2e coverage must be removed from this set).
 *
 * The spec's contract is: seed a legacy row with `payload: { e2e: true }`,
 * mock returns `{}`, row flips to "sent". A command that cannot satisfy that
 * contract is listed here instead of being silently dropped from the spec.
 */
const E2E_GENERIC_DRAIN_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    "workflow_step_result",
    // The result path requires a receipt-shaped payload with requestId,
    // sequence metadata and a Host acknowledgement. The generic E2E row
    // deliberately sends only `{ e2e: true }` and mocks `{}`, so exercising
    // this command there would test malformed input rather than queue drain.
    // Chunking, replay and acknowledgement are covered by the remote-step,
    // mobile receipt and outbound queue unit suites.
    "requires chunk metadata + Host acknowledgement; covered by remote-step and queue tests",
  ],
  [
    "host_state_submit",
    // HostStateProtocol rows are `protocol: "host-state"`, not legacy
    // RPC. Their drain path (`lib/queue/outbound-queue.ts:dispatchOne`) is
    // gated by `canDispatch` on a negotiated `host_state_submit` host
    // operation (`components/providers/companion-outbound-runner-provider.tsx`)
    // and requires a receipt-shaped `HostStateSubmitResponse` whose single
    // result echoes the row's `actionId`, else it throws
    // `host_state_malformed_response`. The mobile e2e harness never
    // negotiates HostState (the mock V2 server serves no
    // `host_feature_manifest` / `host_state_status` / `host_state_snapshot`
    // and the `__cogniaEnqueueOutbound` bridge only seeds legacy rows), so
    // the generic `{ e2e: true }` → `{}` → "sent" loop cannot cover it. The
    // receipt / rejection / conflict / malformed paths are pinned by
    // `lib/queue/outbound-queue.test.ts` and `lib/db/mobile-outbound-queue.test.ts`.
    "host-state-v1 protocol row: needs negotiated HostState + actionId-echoing receipt; " +
      "covered by lib/queue/outbound-queue.test.ts, not the generic legacy-RPC drain loop",
  ],
])

/**
 * Concatenate `rpc.rs` with every production dispatch submodule under
 * `rpc/`. `tests.rs` (and any other test-only module) is excluded on purpose:
 * a `"<cmd>" =>` inside a test fixture must not mask a missing production
 * arm.
 */
async function readRpcDispatchSources(): Promise<string> {
  const entries = await fs.readdir(RPC_DISPATCH_DIR, { withFileTypes: true })
  const submodules = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rs"))
    .filter((entry) => entry.name !== "tests.rs" && !entry.name.endsWith("_test.rs"))
    .map((entry) => path.join(RPC_DISPATCH_DIR, entry.name))
    .sort()
  const sources = await Promise.all(
    [RPC_RS, ...submodules].map((file) => fs.readFile(file, "utf8"))
  )
  return sources.join("\n")
}

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
  it("every Host-plane command appears verbatim in rpc.rs KNOWN_COMMANDS", async () => {
    const src = await fs.readFile(RPC_RS, "utf8")
    for (const cmd of HOST_PLANE_COMMANDS) {
      // `"<cmd>"` (quoted form is how KNOWN_COMMANDS lists each entry).
      // Tolerate trailing comma + whitespace by matching the literal.
      expect(src).toContain(`"${cmd}"`)
    }
  })

  it("every Host-plane command has a dispatch arm in rpc.rs or a rpc/ dispatch submodule", async () => {
    const src = await readRpcDispatchSources()
    // A dispatch arm matches any of these patterns:
    //   1. `"<cmd>" =>`                   single-arm form
    //   2. `| "<cmd>"`                    middle/end of a multi-line pipe group
    //   3. `"<cmd>"\n        | "<other>"` first entry of a multi-line pipe group
    //                                      (followed by whitespace + `|` on next line)
    // Together these cover both how the existing `match name { ... }` bodies
    // are shaped and how new entries get added.
    for (const cmd of HOST_PLANE_COMMANDS) {
      const arrowForm = new RegExp(`"${cmd}"\\s*=>`, "u")
      const pipeBefore = new RegExp(`\\|\\s*"${cmd}"`, "u")
      const pipeAfter = new RegExp(`"${cmd}"\\s*\\n\\s*\\|`, "u")
      const hasArrow = arrowForm.test(src)
      const hasPipeBefore = pipeBefore.test(src)
      const hasPipeAfter = pipeAfter.test(src)
      if (!hasArrow && !hasPipeBefore && !hasPipeAfter) {
        throw new Error(
          `MOBILE_OUTBOUND_COMMANDS["${cmd}"] has no dispatch arm in ` +
            `src-tauri/src/companion_api/rpc.rs or any src-tauri/src/companion_api/rpc/*.rs ` +
            `submodule — add it to the owning domain's \`COMMANDS\` slice AND give it either an ` +
            `explicit \`"${cmd}" =>\` arm or a slot in a pipe-separated group inside that ` +
            `domain's \`dispatch\` (e.g. the mobile-write group in rpc/data_sync.rs), then list ` +
            `it in rpc.rs KNOWN_COMMANDS.`
        )
      }
    }
  })

  it("e2e COMMAND_KINDS lists exactly the same set (minus documented exclusions)", async () => {
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
    // Host plane only. The spec seeds legacy RPC rows and mocks a V2 desktop;
    // a collaboration row is never dispatched through that server at all, so
    // its absence is the design rather than drift, and listing all seven in
    // E2E_GENERIC_DRAIN_EXCLUSIONS would say "cannot satisfy the loop" about
    // commands that are not on the loop's transport in the first place.
    const aSet: Set<string> = new Set(HOST_PLANE_COMMANDS)
    const excluded = new Set(E2E_GENERIC_DRAIN_EXCLUSIONS.keys())
    const missingFromE2e = [...aSet].filter((n) => !eSet.has(n) && !excluded.has(n))
    const extraInE2e = [...eSet].filter((n) => !aSet.has(n))
    if (missingFromE2e.length || extraInE2e.length) {
      throw new Error(
        `e2e outbound-queue.spec.ts drift detected.\n` +
          `  Missing from e2e: ${JSON.stringify(missingFromE2e)}\n` +
          `  Extra in e2e:    ${JSON.stringify(extraInE2e)}\n` +
          `Reconcile with MOBILE_OUTBOUND_COMMANDS in mobile-outbound-types.ts, or — only if ` +
          `the command genuinely cannot run through the spec's generic legacy-RPC drain loop — ` +
          `add it to E2E_GENERIC_DRAIN_EXCLUSIONS in this test with a reason.`
      )
    }
  })

  it("every e2e exclusion is still a real command and still absent from the spec", async () => {
    const src = await fs.readFile(E2E_SPEC, "utf8")
    const match = /const COMMAND_KINDS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src)
    expect(match).not.toBeNull()
    const eSet: Set<string> = new Set(
      Array.from(match![1].matchAll(/"([a-z_]+)"/g)).map((m) => m[1])
    )
    const aSet: Set<string> = new Set(MOBILE_OUTBOUND_COMMANDS as readonly string[])
    for (const [cmd, reason] of E2E_GENERIC_DRAIN_EXCLUSIONS) {
      // A reason is mandatory — an exclusion without one is just silent drift.
      expect(reason.trim().length).toBeGreaterThan(0)
      if (!aSet.has(cmd)) {
        throw new Error(
          `E2E_GENERIC_DRAIN_EXCLUSIONS["${cmd}"] is stale — the command is no longer in ` +
            `MOBILE_OUTBOUND_COMMANDS. Remove the exclusion.`
        )
      }
      if (eSet.has(cmd)) {
        throw new Error(
          `E2E_GENERIC_DRAIN_EXCLUSIONS["${cmd}"] is stale — outbound-queue.spec.ts now lists ` +
            `it in COMMAND_KINDS. Remove the exclusion so the parity check covers it again.`
        )
      }
    }
  })

  it("splits the enum into two non-empty transports that cover it exactly", () => {
    // Both collaboration assertions below iterate COLLAB_PLANE_COMMANDS, and a
    // partition that silently went empty would let them pass having checked
    // nothing. Pin the counts so the sweep is known to have swept.
    expect(HOST_PLANE_COMMANDS.length).toBeGreaterThan(0)
    expect(COLLAB_PLANE_COMMANDS.length).toBeGreaterThan(0)
    expect(HOST_PLANE_COMMANDS.length + COLLAB_PLANE_COMMANDS.length).toBe(
      MOBILE_OUTBOUND_COMMANDS.length
    )
  })

  it("routes every collaboration-plane command through the collab dispatcher", async () => {
    // Read the list rather than importing it: this suite runs in the node
    // project, and `outbound-dispatcher.ts` is a "use client" module whose
    // graph reaches the platform fetch and the Logto session store.
    const src = await fs.readFile(COLLAB_DISPATCHER, "utf8")
    const declaration = /COLLAB_OUTBOUND_COMMANDS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src)
    expect(declaration).not.toBeNull()
    const routed = new Set(
      Array.from(declaration![1].matchAll(/"([a-z_]+)"/g)).map((entry) => entry[1])
    )

    // `liveDispatcher` sends anything `collab_` prefixed to
    // `dispatchCollabOutbound`, and that function's `switch` has no `default`.
    // A name the switch does not know therefore returns undefined instead of
    // throwing, and `dispatchOne` marks the row "sent" having written nothing
    // to the collaboration server: a silent lost edit, not a failed one.
    const unroutable = COLLAB_PLANE_COMMANDS.filter((command) => !routed.has(command))
    if (unroutable.length) {
      throw new Error(
        `MOBILE_OUTBOUND_COMMANDS ${JSON.stringify(unroutable)} are dispatched by prefix to ` +
          `lib/collab/outbound-dispatcher.ts but have no case there. Add each to ` +
          `COLLAB_OUTBOUND_COMMANDS and to the switch, or the queue will report them sent ` +
          `without writing anything.`
      )
    }

    // And the other way: a routed name nothing can queue is dead code.
    const unqueueable = [...routed].filter((command) => !COLLAB_PLANE_COMMANDS.includes(command))
    expect(unqueueable).toEqual([])
  })

  it("keeps collaboration commands out of the Host RPC surface", async () => {
    const src = await readRpcDispatchSources()
    // The inverse of the KNOWN_COMMANDS check. These never reach
    // `transport.call`, so an entry here would advertise an RPC the desktop
    // cannot answer, and `every_known_command_has_a_dispatch_arm` would go red
    // on the arm nobody can write.
    for (const cmd of COLLAB_PLANE_COMMANDS) {
      expect(src).not.toContain(`"${cmd}"`)
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
