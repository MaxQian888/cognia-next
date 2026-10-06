/**
 * `cognia-agent account-sync …` — enroll and manage a headless host in the
 * person's account sync (ADR-0215 phase 3a), from the host's own terminal.
 *
 * The host signs in with `cognia-agent logto login` (the official account),
 * keeps its keys in `~/.cognia/account-sync/` (0600), and the brain
 * (`cognia-agent serve`) syncs with them once enrolled. Every subcommand
 * wraps the same enrollment flows the app runs (`lib/account-sync/enrollment`).
 *
 *   status                       where this host stands, and what to run next
 *   setup [--name n] [--kit f]   first device of the account: prints the sync recovery key
 *   join [--name n]              ask another device to approve this host (6-digit code)
 *   recover [--name n]           join with the sync recovery key (read from stdin)
 *   approve [requestId]          approve a new device after comparing codes
 *   deny <requestId>             turn a request down
 *   devices                      the verified device list
 *   revoke <deviceId>            remove a device (rotates the key)
 *   rotate                       rotate the key
 *   recovery-key [--kit f]       replace the sync recovery key
 *   data --merge | --replace     how the brain combines its data with the account's
 *
 * Off unless `COGNIA_ACCOUNT_SYNC=1` (account sync is a preview).
 */

import fs from "node:fs"
import os from "node:os"
import readline from "node:readline/promises"

import {
  headlessSyncContext,
  readDataChoice,
  saveDataChoice,
} from "@/lib/account-sync/data/headless-host"
import { deviceNames } from "@/lib/account-sync/device-names"
import {
  beginApproval,
  commitFirstDevice,
  commitRecoveryKey,
  completeJoin,
  confirmApproval,
  confirmsRecoveryKey,
  denyRequest,
  listIncoming,
  pickConfirmationPositions,
  pollApproval,
  pollJoin,
  prepareFirstDevice,
  prepareRecoveryKey,
  readEnrollmentStatus,
  recoverWithKey,
  recoveryKitContents,
  revokeDevice,
  rotateKeys,
  startJoin,
  cancelJoin,
  type AccountSyncContext,
  type EnrollmentStatus,
} from "@/lib/account-sync/enrollment"
import { currentKeyChain } from "@/lib/account-sync/registry-sync"
import type { SyncSession } from "@/lib/account-sync/sync-session"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { loadMessageResolver } from "@/lib/headless/i18n"

import {
  headlessAccountSyncEnabled,
  headlessKeyring,
  headlessSyncSession,
} from "../account-sync/headless-sync"
import { resolveHome } from "../config/load"
import { HEADLESS_LOCAL_ACCOUNT_ID } from "../serve/account"
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

const POLL_MS = 2_000

export interface AccountSyncCommandDeps {
  home?: string
  env?: Record<string, string | undefined>
  out?: OutputSink
  /** Reads one line from the terminal (or piped stdin). */
  readLine?: (prompt: string) => Promise<string>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  fetchImpl?: typeof fetch
  hostName?: () => string
  writeFile?: (file: string, content: string) => void
  /** Calls `handler` on Ctrl-C until the returned function is called. */
  onInterrupt?: (handler: () => void) => () => void
  /** Test seams. */
  session?: () => Promise<SyncSession | null>
  keyring?: KeyringStore
}

async function defaultReadLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(prompt)).trim()
  } finally {
    rl.close()
  }
}

function defaultInterrupt(handler: () => void): () => void {
  process.once("SIGINT", handler)
  return () => process.off("SIGINT", handler)
}

interface Run {
  args: ParsedArgs
  out: OutputSink
  context: AccountSyncContext
  keyring: KeyringStore
  readLine: (prompt: string) => Promise<string>
  sleep: (ms: number) => Promise<void>
  now: () => number
  hostName: () => string
  writeFile: (file: string, content: string) => void
  onInterrupt: (handler: () => void) => () => void
}

const SUBCOMMANDS =
  "status | setup | join | recover | approve | deny | devices | revoke | rotate | recovery-key | data"

export async function accountSyncCommand(
  args: ParsedArgs,
  deps: AccountSyncCommandDeps = {}
): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  if (!headlessAccountSyncEnabled(env)) {
    out.error(
      "account-sync: account sync is a preview and off on this host; set COGNIA_ACCOUNT_SYNC=1 " +
        "here and for `cognia-agent serve`"
    )
    return 2
  }
  if (!args.subcommand) {
    out.error(`account-sync: expected a subcommand — ${SUBCOMMANDS}`)
    return 2
  }
  const home = deps.home ?? resolveHome(env, os.homedir())
  const localAccountId =
    stringFlag(args, "account") ?? env.COGNIA_LOCAL_ACCOUNT_ID ?? HEADLESS_LOCAL_ACCOUNT_ID
  const session = await (
    deps.session ?? (() => headlessSyncSession({ cliHome: home, localAccountId, env }))
  )()
  if (!session) {
    out.error(
      "account-sync: this host is not signed in to the Cognia account; run `cognia-agent logto login`"
    )
    return 1
  }
  const keyring = deps.keyring ?? headlessKeyring(home)
  const run: Run = {
    args,
    out,
    context: headlessSyncContext(session, keyring, deps.fetchImpl),
    keyring,
    readLine: deps.readLine ?? defaultReadLine,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? Date.now,
    hostName: deps.hostName ?? (() => os.hostname()),
    writeFile:
      deps.writeFile ?? ((file, content) => fs.writeFileSync(file, content, { mode: 0o600 })),
    onInterrupt: deps.onInterrupt ?? defaultInterrupt,
  }
  try {
    switch (args.subcommand) {
      case "status":
        return await statusSub(run)
      case "setup":
        return await setupSub(run)
      case "join":
        return await joinSub(run)
      case "recover":
        return await recoverSub(run)
      case "approve":
        return await approveSub(run)
      case "deny":
        return await denySub(run)
      case "devices":
        return await devicesSub(run)
      case "revoke":
        return await revokeSub(run)
      case "rotate":
        return await rotateSub(run)
      case "recovery-key":
        return await recoveryKeySub(run)
      case "data":
        return await dataSub(run)
      default:
        out.error(`account-sync: unknown subcommand "${args.subcommand}" — ${SUBCOMMANDS}`)
        return 2
    }
  } catch (error) {
    out.error(
      `account-sync ${args.subcommand}: ${error instanceof Error ? error.message : String(error)}`
    )
    return 1
  }
}

function identity(run: Run) {
  return { name: stringFlag(run.args, "name") ?? run.hostName(), platform: "desktop" as const }
}

/** The host's place in the space; prints why not when it is not enrolled. */
async function enrolled(run: Run): Promise<Extract<EnrollmentStatus, { kind: "enrolled" }> | null> {
  const status = await readEnrollmentStatus(run.context)
  if (status.kind === "enrolled") return status
  run.out.error(`account-sync: ${describe(status)}`)
  return null
}

function describe(status: EnrollmentStatus): string {
  switch (status.kind) {
    case "locked":
      return "the key store is locked"
    case "not-enrolled":
      return status.space === "empty"
        ? "not enrolled, and the account has no sync devices yet; run `cognia-agent account-sync setup`"
        : "not enrolled; run `cognia-agent account-sync join` (approve from another device) " +
            "or `cognia-agent account-sync recover` (with the sync recovery key)"
    case "removed":
      return (
        `this host was removed from sync on ${new Date(status.removal.at).toISOString()} ` +
        "by another device; run `join` or `recover` to come back"
      )
    case "integrity":
      return `the device list could not be verified (${status.reason}); nothing was deleted, try again later`
    case "enrolled":
      return "enrolled"
  }
}

async function statusSub(run: Run): Promise<number> {
  const status = await readEnrollmentStatus(run.context)
  const { out } = run
  out.write(`account: ${run.context.session.userId}\n`)
  if (status.kind !== "enrolled") {
    out.write(`status: ${describe(status)}\n`)
    return 0
  }
  const { state } = status.registry
  out.write(`status: enrolled as ${status.device.deviceId} (epoch ${state.epoch})\n`)
  const active = Object.values(state.devices).filter((device) => device.status === "active")
  out.write(`devices: ${active.length} active\n`)
  const incoming = (await listIncoming(run.context, status.device)).filter(
    (request) => request.open
  )
  if (incoming.length > 0)
    out.write(
      `waiting: ${incoming.length} new device(s); run \`cognia-agent account-sync approve\`\n`
    )
  const choice = await readDataChoice(run.keyring, run.context.vault.scope)
  out.write(
    choice
      ? `data: the brain will ${choice} this host's data with the account's when it joins\n`
      : "data: no choice saved (needed only if this host and the account both hold data; " +
          "see `cognia-agent account-sync data`)\n"
  )
  return 0
}

/** Asks for characters of a new recovery key (or a written kit), as the app does. */
async function confirmKept(
  run: Run,
  recoveryKeyText: string,
  kitWritten: boolean
): Promise<boolean> {
  if (kitWritten) return true
  const positions = pickConfirmationPositions()
  const answer = await run.readLine(
    `Type characters ${positions.map((position) => position + 1).join(", ")} of the key, ` +
      "separated by spaces: "
  )
  return confirmsRecoveryKey(recoveryKeyText, positions, answer.split(/\s+/).filter(Boolean))
}

async function writeKit(run: Run, recoveryKeyText: string): Promise<boolean> {
  const file = stringFlag(run.args, "kit")
  if (!file) return false
  const t = await loadMessageResolver("en")
  const kit = (key: string) => t(`accountSync.recoveryKey.kit.${key}`)
  run.writeFile(
    file,
    recoveryKitContents({
      recoveryKeyText,
      account: run.context.session.userId,
      createdAt: new Date(run.now()),
      text: {
        title: kit("title"),
        intro: kit("intro"),
        keyLabel: kit("keyLabel"),
        accountLabel: kit("accountLabel"),
        createdLabel: kit("createdLabel"),
        instructions: [kit("step1"), kit("step2"), kit("step3")],
      },
    })
  )
  run.out.write(`Recovery kit written to ${file} (only you can read it).\n`)
  return true
}

function printRecoveryKey(run: Run, recoveryKeyText: string): void {
  run.out.write(
    "\nYour sync recovery key — it adds a device when no other device is at hand.\n" +
      "Cognia cannot recover it for you. It is not your profile recovery key.\n\n" +
      `    ${recoveryKeyText}\n\n`
  )
}

async function setupSub(run: Run): Promise<number> {
  const status = await readEnrollmentStatus(run.context)
  if (status.kind !== "not-enrolled" || status.space !== "empty") {
    run.out.error(`account-sync setup: ${describe(status)}`)
    return 1
  }
  const prepared = await prepareFirstDevice(run.context, identity(run))
  printRecoveryKey(run, prepared.recoveryKeyText)
  const kitWritten = await writeKit(run, prepared.recoveryKeyText)
  if (!(await confirmKept(run, prepared.recoveryKeyText, kitWritten))) {
    run.out.error("account-sync setup: those characters do not match the key; nothing was set up")
    return 1
  }
  const result = await commitFirstDevice(run.context, prepared)
  if (result.kind === "space-exists") {
    run.out.error(
      "account-sync setup: another device set sync up meanwhile; run `join` or `recover` instead"
    )
    return 1
  }
  run.out.write(
    "This host is the first sync device. `cognia-agent serve` starts syncing within 20 s.\n"
  )
  return 0
}

async function joinSub(run: Run): Promise<number> {
  const status = await readEnrollmentStatus(run.context)
  if (status.kind === "enrolled") {
    run.out.write("This host is already enrolled.\n")
    return 0
  }
  const join = await startJoin(run.context, identity(run))
  let cancelled = false
  const stopListening = run.onInterrupt(() => {
    cancelled = true
  })
  run.out.write(
    "Open Settings → Account → Sync devices on one of your devices and approve this host.\n"
  )
  let shownCode: string | null = null
  try {
    while (run.now() < join.expiresAt) {
      if (cancelled) {
        await cancelJoin(run.context, join)
        run.out.error("account-sync join: cancelled")
        return 1
      }
      const progress = await pollJoin(run.context, join)
      if (progress.phase === "code" && progress.code !== shownCode) {
        shownCode = progress.code
        run.out.write(
          `Approval code: ${progress.code} — confirm the other device shows the same.\n`
        )
      } else if (progress.phase === "approved") {
        await completeJoin(run.context, join)
        run.out.write("Approved. `cognia-agent serve` starts syncing within 20 s.\n")
        return 0
      } else if (progress.phase === "ended") {
        run.out.error(`account-sync join: the request ended (${progress.reason})`)
        return 1
      }
      await run.sleep(POLL_MS)
    }
    run.out.error("account-sync join: the request expired; run it again")
    return 1
  } finally {
    stopListening()
  }
}

async function recoverSub(run: Run): Promise<number> {
  const status = await readEnrollmentStatus(run.context)
  if (status.kind === "enrolled") {
    run.out.write("This host is already enrolled.\n")
    return 0
  }
  const key = await run.readLine("Sync recovery key: ")
  if (!key) {
    run.out.error("account-sync recover: no recovery key given")
    return 2
  }
  await recoverWithKey(run.context, key, identity(run))
  run.out.write("Recovered. `cognia-agent serve` starts syncing within 20 s.\n")
  return 0
}

async function approveSub(run: Run): Promise<number> {
  const status = await enrolled(run)
  if (!status) return 1
  const incoming = (await listIncoming(run.context, status.device)).filter(
    (request) => request.open
  )
  const wanted = run.args.positionals[0]
  const request = wanted ? incoming.find((item) => item.requestId === wanted) : incoming[0]
  if (!request) {
    run.out.error(
      wanted
        ? `account-sync approve: no open request ${wanted}`
        : "account-sync approve: no device is waiting"
    )
    return 1
  }
  if (!wanted && incoming.length > 1) {
    run.out.error(
      `account-sync approve: ${incoming.length} devices are waiting; name one: ` +
        incoming.map((item) => item.requestId).join(", ")
    )
    return 2
  }
  run.out.write(
    `Approving ${request.displayName ?? "an unnamed device"} (${request.platform}). ` +
      "Waiting for it to show its code…\n"
  )
  const approval = await beginApproval(run.context, status.device, request)
  for (;;) {
    const progress = await pollApproval(run.context, status.device, approval)
    if (progress.phase === "ended") {
      run.out.error(`account-sync approve: the request ended (${progress.reason})`)
      return 1
    }
    if (progress.phase === "code") {
      const answer = await run.readLine(
        `Does the new device show ${progress.code}? Type "yes" to approve: `
      )
      if (answer.toLowerCase() !== "yes") {
        await denyRequest(run.context, status.device, request.requestId, "mismatch", approval)
        run.out.error("account-sync approve: the codes did not match; the request was turned down")
        return 1
      }
      await confirmApproval(run.context, status.device, approval)
      run.out.write("Approved.\n")
      return 0
    }
    await run.sleep(POLL_MS)
  }
}

async function denySub(run: Run): Promise<number> {
  const status = await enrolled(run)
  if (!status) return 1
  const requestId = run.args.positionals[0]
  if (!requestId) {
    run.out.error("account-sync deny: name the request to turn down")
    return 2
  }
  await denyRequest(run.context, status.device, requestId, "denied")
  run.out.write("Turned down.\n")
  return 0
}

async function devicesSub(run: Run): Promise<number> {
  const status = await enrolled(run)
  if (!status) return 1
  const { state } = status.registry
  const chain = await currentKeyChain(run.context.api, run.context.vault, state, status.device)
  const names = await deviceNames(state, chain)
  for (const device of Object.values(state.devices)) {
    const self = device.deviceId === status.device.deviceId ? " (this host)" : ""
    run.out.write(
      `${device.deviceId}  ${device.status.padEnd(7)}  ${device.platform.padEnd(7)}  ` +
        `${names.get(device.deviceId) ?? "(unnamed)"}${self}\n`
    )
  }
  return 0
}

async function revokeSub(run: Run): Promise<number> {
  const status = await enrolled(run)
  if (!status) return 1
  const deviceId = run.args.positionals[0]
  if (!deviceId) {
    run.out.error("account-sync revoke: name the device to remove")
    return 2
  }
  if (deviceId === status.device.deviceId) {
    run.out.error("account-sync revoke: remove this host from another device")
    return 2
  }
  if (status.registry.state.devices[deviceId]?.status !== "active") {
    run.out.error(`account-sync revoke: ${deviceId} is not an active device`)
    return 1
  }
  const state = await revokeDevice(run.context, status.device, deviceId)
  run.out.write(`Removed ${deviceId}; the key moved to epoch ${state.epoch}.\n`)
  return 0
}

async function rotateSub(run: Run): Promise<number> {
  const status = await enrolled(run)
  if (!status) return 1
  const state = await rotateKeys(run.context, status.device)
  run.out.write(`The key moved to epoch ${state.epoch}.\n`)
  return 0
}

async function recoveryKeySub(run: Run): Promise<number> {
  const status = await enrolled(run)
  if (!status) return 1
  const prepared = await prepareRecoveryKey(run.context)
  printRecoveryKey(run, prepared.recoveryKeyText)
  const kitWritten = await writeKit(run, prepared.recoveryKeyText)
  if (!(await confirmKept(run, prepared.recoveryKeyText, kitWritten))) {
    prepared.recoveryKey.fill(0)
    run.out.error("account-sync recovery-key: those characters do not match; the old key stays")
    return 1
  }
  await commitRecoveryKey(run.context, status.device, prepared)
  run.out.write("The new sync recovery key is in place; the old one no longer works.\n")
  return 0
}

async function dataSub(run: Run): Promise<number> {
  const merge = boolFlag(run.args, "merge")
  const replace = boolFlag(run.args, "replace")
  if (merge === replace) {
    run.out.error(
      "account-sync data: pass --merge (keep both, newer changes win) or --replace " +
        "(take the account's data; this host's chats, characters, skills and memories are removed)"
    )
    return 2
  }
  await saveDataChoice(run.keyring, run.context.vault.scope, merge ? "merge" : "replace")
  run.out.write(
    `Saved. The brain backs up its data, then ${merge ? "merges it with" : "replaces it with"} ` +
      "the account's within 20 s.\n"
  )
  return 0
}
