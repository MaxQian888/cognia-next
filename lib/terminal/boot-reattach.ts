"use client"

/**
 * Reattach to the terminal host once per page load, from whichever shell is
 * running.
 *
 * The durable terminal host outlives the *renderer* — whichever renderer that
 * is. A browser paired to a `cognia-server` (ADR-0059 C1) has exactly the same
 * surviving sessions the desktop does, and `rehydrate.ts` has always known how
 * to reach them over `ws` / `webrtc`. But nothing called it there:
 *
 *   * `TerminalBridgeInitializer` mounts inside `desktop-only-initializers.tsx`,
 *     behind an `isTauri()` gate, so its own non-Tauri branch was unreachable;
 *   * the dock's other call sits behind the host-state banner's Retry button,
 *     which never renders because `hostState` starts `"online"`;
 *   * `mobile-terminal-screen.tsx` did reattach at mount — which is why the
 *     bug only ever showed up in the browser.
 *
 * So every browser reload silently orphaned the server's live sessions, with
 * no affordance anywhere to get them back. This module is the missing call,
 * mounted from `TerminalDockRegion` (permanently in the shell for both desktop
 * and web, open or not).
 *
 * Idempotent by construction: the region mounts twice — once per dock slot —
 * and reattaching the same PTY twice would wire two logical streams to one
 * session. Concurrent callers share the first call's promise.
 *
 * It also pushes the user's terminal profiles, which the desktop initializer
 * does on its own path. That is not cosmetic over a remote transport: a remote
 * spawn frame names a profile and carries nothing else, so a profile the host
 * has never been told about comes back "unknown terminal profile" and the
 * shell the user picked is silently replaced by the host's bootstrap default.
 */

import { ensureTerminalHostProfilesSynced } from "./host-profiles"
import { selectTerminalTransportChain } from "./pick-transport"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

let inFlight: Promise<void> | null = null

/**
 * Reattach to whatever the active host still has, at most once per page load.
 *
 * Three shells, three outcomes:
 *   * **local PTY** (`tauri-channel`) — no-op. `TerminalBridgeInitializer`
 *     already owns that path and also configures the VS Code bridge and the
 *     profile sync alongside it; running both would double-attach.
 *   * **remote host** (`ws` / `webrtc`) — reattach. `rehydrateTerminals`
 *     restores the saved tab layout itself, after the surviving sessions have
 *     registered, so the layout is validated against real rows.
 *   * **web standalone** — nothing survived, so drop the persisted layout
 *     rather than leaving a snapshot that could mask later live updates.
 */
export function bootReattachTerminals(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = run()
  return inFlight
}

async function run(): Promise<void> {
  const chain = selectTerminalTransportChain()
  if (chain[0] === "tauri-channel") return
  if (chain.length === 0) {
    useTerminalStore.getState().restorePersistedLayout()
    return
  }
  // Started, not awaited. Reattaching only touches sessions that already
  // exist, so it does not need the profiles — and the sync waits for the
  // settings store, which must never be able to hold the reattach hostage.
  // The spawn path awaits the same shared promise, so a spawn still cannot
  // outrun it.
  void ensureTerminalHostProfilesSynced()
  try {
    const { rehydrateTerminals } = await import("./rehydrate")
    await rehydrateTerminals()
  } catch {
    // `rehydrateTerminals` already records the host state it failed with; a
    // throw past that is a module-load failure, and a dock with no tabs is a
    // better outcome than a boot that dies on it.
  }
}

/** Test-only: allow a second run against a re-stubbed shell. */
export function __resetBootReattachForTests(): void {
  inFlight = null
}
