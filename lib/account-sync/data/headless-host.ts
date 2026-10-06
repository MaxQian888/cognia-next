/**
 * Account sync on a headless host's brain (ADR-0215 phase 3a).
 *
 * A headless host is enrolled from its own terminal (`cognia-agent
 * account-sync …`), signed in with its own `cognia-agent logto login`, and its
 * keys sit in a store the commands and the brain share. The brain looks every
 * 20 s: once the host is enrolled it runs the data engine on its own database
 * (it holds the lead: one process, no Web Locks), and stops it when the host
 * is removed or signed out.
 *
 * When the host and the account both hold data, the engine asks; there is no
 * window to ask in, so the brain takes the answer the person gave with
 * `cognia-agent account-sync data --merge|--replace`, backs up its database,
 * and joins. Until then it waits and says what to run.
 */

import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import { createAccountSyncContext } from "@/lib/account-sync/enrollment/context"
import { readEnrollmentStatus } from "@/lib/account-sync/enrollment/status"
import type { SyncSession } from "@/lib/account-sync/sync-session"
import { createAccountSyncVault, type AccountSyncVaultScope } from "@/lib/account-sync/vault-store"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import type { CogniaDB } from "@/lib/db/schema"

import {
  startAccountSyncEngine,
  type AccountSyncEngine,
  type AccountSyncEngineDeps,
  type EngineStatus,
} from "./engine"
import type { JoinChoice } from "./join"

export const HEADLESS_POLL_MS = 20_000

/** What the CLI hands the brain (`cli/src/serve/serve-command.ts`). */
export interface HeadlessAccountSyncHost {
  /** The host's own sync session, or null when it is not signed in. */
  session: () => Promise<SyncSession | null>
  /** The store the `cognia-agent account-sync` commands keep the keys in. */
  keyring: KeyringStore
  /** Backs up the brain's database before a join changes it. */
  backup: () => Promise<void>
}

const DATA_CHOICE = "data-choice"

function dataChoiceKey(scope: AccountSyncVaultScope): string {
  return `${scope.localAccountId}:${scope.spaceId}:${DATA_CHOICE}`
}

/** The merge-or-replace answer given ahead of time from the terminal. */
export async function readDataChoice(
  store: KeyringStore,
  scope: AccountSyncVaultScope
): Promise<JoinChoice | null> {
  const raw = await store.load(dataChoiceKey(scope))
  return raw === "merge" || raw === "replace" ? raw : null
}

export async function saveDataChoice(
  store: KeyringStore,
  scope: AccountSyncVaultScope,
  choice: JoinChoice | null
): Promise<void> {
  if (choice) await store.save(dataChoiceKey(scope), choice)
  else await store.delete(dataChoiceKey(scope))
}

/** The context the commands and the brain build for one session: the shared store, never the default. */
export function headlessSyncContext(
  session: SyncSession,
  keyring: KeyringStore,
  fetchImpl?: typeof fetch
): AccountSyncContext {
  return createAccountSyncContext(session, {
    vault: createAccountSyncVault(
      { localAccountId: session.localAccountId, spaceId: session.spaceId },
      keyring
    ),
    ...(fetchImpl ? { fetchImpl } : {}),
  })
}

export interface HeadlessAccountSyncDeps {
  host: HeadlessAccountSyncHost
  /** The brain's own database, or null when it is not open. */
  db: () => CogniaDB | null
  log: (level: "info" | "error", message: string) => void
  pollMs?: number
  fetchImpl?: typeof fetch
  /** Test seams. */
  start?: typeof startAccountSyncEngine
  engineDeps?: Partial<AccountSyncEngineDeps>
}

export interface HeadlessAccountSync {
  /** Looks now (tests, and after the commands changed something). */
  check(): Promise<void>
  stop(): void
}

export function startHeadlessAccountSync(deps: HeadlessAccountSyncDeps): HeadlessAccountSync {
  const pollMs = deps.pollMs ?? HEADLESS_POLL_MS
  const start = deps.start ?? startAccountSyncEngine
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: { key: string; engine: AccountSyncEngine; context: AccountSyncContext } | null = null
  let joining = false
  let said = ""
  let checking: Promise<void> | null = null

  const say = (level: "info" | "error", message: string) => {
    if (message === said) return
    said = message
    deps.log(level, `account sync: ${message}`)
  }

  function stopEngine(): void {
    running?.engine.stop()
    running = null
  }

  /** Answers the engine's join question with the person's choice, if they gave one. */
  async function answer(status: EngineStatus): Promise<void> {
    if (status.kind !== "join-choice" || !running || joining) return
    const { engine, context } = running
    const scope = context.vault.scope
    const choice = await readDataChoice(deps.host.keyring, scope)
    if (!choice) {
      say(
        "info",
        "this host and your account both hold data; run `cognia-agent account-sync data --merge` " +
          "(or `--replace`) to choose how to combine them"
      )
      return
    }
    joining = true
    try {
      say("info", `backing up, then joining your account's data (${choice})`)
      await engine.join(choice, deps.host.backup)
      await saveDataChoice(deps.host.keyring, scope, null)
    } catch (error) {
      say("error", `could not join: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      joining = false
    }
  }

  function onStatus(status: EngineStatus): void {
    if (status.kind === "join-choice") void answer(status)
    else if (status.kind === "seeding") say("info", "preparing this host's data for sync")
    else if (status.kind === "running" && status.error) say("error", status.error)
    else if (status.kind === "running") say("info", `syncing (${status.live})`)
    else if (status.kind === "removed") {
      say("info", "this host was removed from sync")
      stopEngine()
    }
  }

  async function look(): Promise<void> {
    const session = await deps.host.session()
    if (!session) {
      stopEngine()
      say("info", "not signed in; run `cognia-agent logto login`")
      return
    }
    const db = deps.db()
    if (!db) {
      stopEngine()
      return
    }
    const context =
      running?.context.session.spaceId === session.spaceId
        ? running.context
        : headlessSyncContext(session, deps.host.keyring, deps.fetchImpl)
    const status = await readEnrollmentStatus(context)
    if (status.kind !== "enrolled") {
      stopEngine()
      if (status.kind === "not-enrolled")
        say("info", "not enrolled; run `cognia-agent account-sync status` to set it up")
      else if (status.kind === "removed") say("info", "this host was removed from sync")
      else if (status.kind === "integrity")
        say("error", `the device list could not be verified (${status.reason})`)
      return
    }
    const key = `${session.spaceId}\u0000${status.device.deviceId}\u0000${db.name}`
    if (running?.key === key) {
      // The person may have answered the join question since.
      await answer(running.engine.status())
      return
    }
    stopEngine()
    const engine = start({
      context,
      device: status.device,
      db,
      locks: null,
      ...deps.engineDeps,
      onStatus,
    })
    running = { key, engine, context }
  }

  async function check(): Promise<void> {
    if (stopped) return
    if (checking) return checking
    checking = look()
      .catch((error) => say("error", error instanceof Error ? error.message : String(error)))
      .finally(() => {
        checking = null
      })
    return checking
  }

  function schedule(): void {
    if (stopped) return
    timer = setTimeout(() => {
      void check().then(schedule)
    }, pollMs)
  }

  void check().then(schedule)

  return {
    check,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      stopEngine()
    },
  }
}
