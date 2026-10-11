/**
 * The one door every memory-editing surface goes through: `/memory` (desktop
 * console and compact body), the chat memory chips, recall feedback, the
 * context workbench and the settings danger zone.
 *
 * Which store a command lands in depends on who owns the data, never on the
 * viewport. A host (the Tauri desktop, a standalone browser or phone) owns its
 * store and runs `manageMemory` in-process. A paired client — a paired phone, a
 * browser paired to a headless host, a desktop driving a remote host — only
 * holds a synced mirror, so its commands go to the host as `memory_mutate` and
 * the mirror moves optimistically (`applyMirroredMemoryCommand`). Before this,
 * the choice was made by screen width: a desktop-width paired browser edited
 * its mirror and the next pull put the old row back, while a narrow Tauri
 * window queued RPCs at itself.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { getRuntimeSnapshot, subscribeRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { ManageMemoryCommand, ManageMemoryResult } from "./manage"

/** `local`: this process owns the store. `host`: a paired host does. */
export type MemoryWriteAuthority = "local" | "host"

/**
 * Who owns the store this process is showing.
 *
 * A desktop driving a remote host, or any shell whose runtime target is a
 * companion of a host (a paired phone, a browser paired to a headless host),
 * edits the host's memory. Everything else owns its own: the Tauri desktop, a
 * standalone browser, and a phone in standalone mode — which is a Capacitor
 * shell with no host behind it, so "is this Capacitor" is not the question
 * (`isCompanionShell` answers that one, for chat rooms, and would queue a
 * standalone phone's memory edits for a host that does not exist).
 */
export function memoryWriteAuthority(): MemoryWriteAuthority {
  if (isRemoteHostActive()) return "host"
  return getRuntimeSnapshot().target?.kind === "companion" ? "host" : "local"
}

/**
 * Re-evaluate {@link memoryWriteAuthority} when the routing can change: taking
 * over (or releasing) a remote host, or a runtime target being published.
 */
export function subscribeMemoryWriteAuthority(listener: () => void): () => void {
  const stopRemote = subscribeActiveRemoteTransport(() => listener())
  const stopSnapshot = subscribeRuntimeSnapshot(() => listener())
  return () => {
    stopRemote()
    stopSnapshot()
  }
}

/** A command a paired client handed to its host; the outcome arrives later. */
export interface QueuedMemoryResult {
  ok: true
  queued: true
  /** The text that will be stored is not the text that was typed. */
  piiRedacted?: boolean
}

export type RoutedMemoryResult = ManageMemoryResult | QueuedMemoryResult

export interface RunMemoryCommandOptions {
  /** User-facing label for the pending-queue UI (already translated). */
  label?: string
  /** Override the routing decision (tests, and callers that already hold it). */
  authority?: MemoryWriteAuthority
}

/** Text a command would write, which the PII gate must see before it travels. */
function redactCommandText(
  command: ManageMemoryCommand
): { command: ManageMemoryCommand; redacted: boolean } | "pii_blocked" {
  let redacted = false
  const gate = (raw: string): string | null => {
    const trimmed = raw.trim()
    const clean = redactText(trimmed).redacted
    if (!hasNoLeakingPii(clean)) return null
    if (clean !== trimmed) redacted = true
    return clean
  }
  const gated = gateCommand(command, gate)
  return gated === "pii_blocked" ? gated : { command: gated, redacted }
}

function gateCommand(
  command: ManageMemoryCommand,
  gate: (raw: string) => string | null
): ManageMemoryCommand | "pii_blocked" {
  if (command.kind === "create") {
    const text = gate(command.text)
    return text ? { ...command, text } : "pii_blocked"
  }
  if (command.kind === "update" && command.patch.text !== undefined) {
    const text = gate(command.patch.text)
    return text ? { ...command, patch: { ...command.patch, text } } : "pii_blocked"
  }
  if (command.kind === "resolve-conflict" && command.mergedText !== undefined) {
    const mergedText = gate(command.mergedText)
    return mergedText ? { ...command, mergedText } : "pii_blocked"
  }
  return command
}

export async function runMemoryCommand(
  command: ManageMemoryCommand,
  options: RunMemoryCommandOptions = {}
): Promise<RoutedMemoryResult> {
  const authority = options.authority ?? memoryWriteAuthority()
  if (authority === "local") {
    const { manageMemory } = await import("./manage")
    return manageMemory(command)
  }

  // The host redacts and gates again; doing it here first means a refused text
  // never enters the queue, and the mirror shows what the host will store.
  const gate = redactCommandText(command)
  if (gate === "pii_blocked") return { ok: false, reason: "pii_blocked" }
  const gated = gate.command

  const operationId = crypto.randomUUID()
  const { enqueue } = await import("@/lib/db/mobile-outbound-queue")
  await enqueue({
    command: "memory_mutate",
    payload: { command: gated, operationId },
    idempotencyKey: operationId,
    ...(options.label ? { label: options.label } : {}),
  })
  const { applyMirroredMemoryCommand } = await import("@/lib/memory/api/mirror-memory")
  await applyMirroredMemoryCommand(gated)
  return { ok: true, queued: true, ...(gate.redacted ? { piiRedacted: true } : {}) }
}

export function isQueuedMemoryResult(result: RoutedMemoryResult): result is QueuedMemoryResult {
  return result.ok && "queued" in result
}
