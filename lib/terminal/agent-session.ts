"use client"

/** Native agent interaction reuses dock sessions; it is not a chat protocol adapter. */
import { findTerminalAgent, terminalAgentProfileId } from "@/lib/agent-ecosystem/terminal-agents"
import type { TerminalSessionRow, TerminalStoreState } from "@/stores/terminal/terminal-store"
import {
  hasTransientTerminalProfile,
  registerTransientTerminalProfile,
  removeTransientTerminalProfile,
} from "./host-profiles"
import { getLiveSession } from "./session-registry"
import { rehydrateTerminalProfile, TerminalProfileRecoveryError } from "./rehydrate"
import { killFromDock, spawnFromDock, type TerminalStoreLike } from "./spawn-orchestrator"
import { isAbsolutePath } from "./terminal-links"

type AgentTerminalStore = TerminalStoreLike &
  Pick<TerminalStoreState, "sessions" | "setPanelOpen" | "setActiveSession">

export interface AgentTerminalHost {
  getStore(): AgentTerminalStore
  activateProject?(projectId: string | null): void
  spawn?: typeof spawnFromDock
  close?: typeof killFromDock
  lookup?: typeof getLiveSession
  registerProfile?: typeof registerTransientTerminalProfile
  releaseProfile?: typeof removeTransientTerminalProfile
  recoverProfile?: typeof rehydrateTerminalProfile
}

export type AgentTerminalErrorCode =
  | "unknown-agent"
  | "invalid-workspace"
  | "spawn-denied"
  | "spawn-failed"
  | "session-unavailable"
  | "stopping"
  | "stop-failed"
  | "cleanup-failed"
  | "profile-conflict"
  | "recovery-failed"

export type AgentTerminalOutcome =
  | { kind: "launched" | "opened" | "exited"; sessionId: string }
  | { kind: "stopped" }
  | { kind: "error"; code: AgentTerminalErrorCode; message?: string }

export type AgentTerminalStatus = "not-started" | "running" | "exited" | "disconnected"

const launching = new Map<string, Promise<AgentTerminalOutcome>>()
const stopping = new Map<string, Promise<AgentTerminalOutcome>>()

export function findAgentTerminalSession(
  agentId: string,
  sessions: Record<string, TerminalSessionRow>
): TerminalSessionRow | undefined {
  const agent = findTerminalAgent(agentId)
  if (!agent) return undefined
  const profileId = terminalAgentProfileId(agent.id)
  return Object.values(sessions)
    .filter((row) => row.profileId === profileId)
    .sort(
      (a, b) =>
        Number(a.status === "exited") - Number(b.status === "exited") || b.createdAt - a.createdAt
    )[0]
}

export function agentTerminalStatus(
  row: TerminalSessionRow | undefined,
  lookup: typeof getLiveSession = getLiveSession
): AgentTerminalStatus {
  if (!row) return "not-started"
  const session = lookup(row.id)
  if (row.status === "exited" || session?.isExited || session?.info.alive === false) return "exited"
  return session ? "running" : "disconnected"
}

function focusTerminal(row: TerminalSessionRow, host: AgentTerminalHost): void {
  host.activateProject?.(row.projectId)
  const store = host.getStore()
  if (
    row.status !== "running" &&
    agentTerminalStatus(row, host.lookup ?? getLiveSession) === "running"
  ) {
    store.setSessionStatus(row.id, "running")
  }
  store.setActiveSession(row.projectId, row.id)
  store.setPanelOpen(true)
}

export function openAgentTerminal(agentId: string, host: AgentTerminalHost): AgentTerminalOutcome {
  const row = findAgentTerminalSession(agentId, host.getStore().sessions)
  if (!row) return { kind: "error", code: "session-unavailable" }
  focusTerminal(row, host)
  return { kind: "opened", sessionId: row.id }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** User initiated only: fixed executable/argv, no shell command or submitted prompt. */
export function launchTerminalAgent(input: {
  agentId: string
  cwd: string
  projectId?: string
  host: AgentTerminalHost
}): Promise<AgentTerminalOutcome> {
  const agent = findTerminalAgent(input.agentId)
  if (!agent) return Promise.resolve({ kind: "error", code: "unknown-agent" })
  const profileId = terminalAgentProfileId(agent.id)
  if (stopping.has(profileId)) return Promise.resolve({ kind: "error", code: "stopping" })
  const pending = launching.get(profileId)
  if (pending) return pending

  const operation = (async (): Promise<AgentTerminalOutcome> => {
    const { host } = input
    const close = host.close ?? killFromDock
    const registerProfile = host.registerProfile ?? registerTransientTerminalProfile
    const release = host.releaseProfile ?? removeTransientTerminalProfile
    const lookup = host.lookup ?? getLiveSession
    let existing = findAgentTerminalSession(agent.id, host.getStore().sessions)
    if (existing && agentTerminalStatus(existing, lookup) !== "exited") {
      return openAgentTerminal(agent.id, host)
    }
    const cwd = input.cwd.trim()
    if (!cwd || cwd.includes("\0") || !isAbsolutePath(cwd)) {
      return { kind: "error", code: "invalid-workspace" }
    }
    try {
      const recovered = await (host.recoverProfile ?? rehydrateTerminalProfile)(profileId, {
        store: host.getStore(),
      })
      existing = findAgentTerminalSession(agent.id, host.getStore().sessions)
      if (recovered && !existing) return { kind: "error", code: "session-unavailable" }
      if (existing && agentTerminalStatus(existing, lookup) !== "exited") {
        return openAgentTerminal(agent.id, host)
      }
    } catch (error) {
      return {
        kind: "error",
        code:
          error instanceof TerminalProfileRecoveryError && error.code === "ambiguous"
            ? "profile-conflict"
            : "recovery-failed",
        message: errorMessage(error),
      }
    }

    let spawnedId: string | undefined
    try {
      if (existing) await close(existing.id, host.getStore(), undefined, { strict: true })
      // A failed prior profile cleanup is retried before reusing its identity.
      if (existing || hasTransientTerminalProfile(profileId)) await release(profileId)
      const req = {
        profileId,
        shell: agent.command,
        args: [...agent.args],
        cwd,
        projectId: input.projectId,
        rows: 24,
        cols: 80,
        enableShellIntegration: false,
        forceUtf8: false,
      }
      registerProfile(req)
      const outcome = await (host.spawn ?? spawnFromDock)({
        req,
        store: host.getStore(),
        title: agent.name,
      })
      if (outcome.kind !== "spawned") {
        await release(profileId)
        return outcome.kind === "denied"
          ? { kind: "error", code: "spawn-denied", message: outcome.reason }
          : { kind: "error", code: "spawn-failed", message: outcome.message }
      }
      spawnedId = outcome.sessionId
      const row = host.getStore().sessions[spawnedId]
      const session = lookup(spawnedId)
      if (row && row.profileId !== profileId) {
        throw new Error("terminal host did not preserve the agent profile identity")
      }
      if (!row || !session) {
        if (row?.status === "exited") {
          await release(profileId)
          focusTerminal(row, host)
          return { kind: "exited", sessionId: spawnedId }
        }
        throw new Error("spawned terminal session is unavailable")
      }
      if (session.isExited || session.info.alive === false) {
        host.getStore().setSessionExit(spawnedId, session.lastExitCode)
        focusTerminal(row, host)
        return { kind: "exited", sessionId: spawnedId }
      }
      host.getStore().setSessionStatus(spawnedId, "running")
      host.getStore().setSessionCwd(spawnedId, cwd)
      focusTerminal(row, host)
      return { kind: "launched", sessionId: spawnedId }
    } catch (error) {
      if (spawnedId) {
        const live = lookup(spawnedId)
        const row = host.getStore().sessions[spawnedId]
        if (!live && row?.status !== "exited") {
          return { kind: "error", code: "session-unavailable", message: errorMessage(error) }
        }
        try {
          await close(spawnedId, host.getStore(), undefined, { strict: true })
        } catch (stopError) {
          return { kind: "error", code: "stop-failed", message: errorMessage(stopError) }
        }
      }
      try {
        await release(profileId)
      } catch (cleanupError) {
        return { kind: "error", code: "cleanup-failed", message: errorMessage(cleanupError) }
      }
      return { kind: "error", code: "spawn-failed", message: errorMessage(error) }
    }
  })().finally(() => launching.delete(profileId))
  launching.set(profileId, operation)
  return operation
}

/** Waits for an in-flight launch, then terminates through the dock's owning handle. */
export function stopTerminalAgent(
  agentId: string,
  host: AgentTerminalHost
): Promise<AgentTerminalOutcome> {
  const agent = findTerminalAgent(agentId)
  if (!agent) return Promise.resolve({ kind: "error", code: "unknown-agent" })
  const profileId = terminalAgentProfileId(agent.id)
  const pending = stopping.get(profileId)
  if (pending) return pending
  const operation = (async (): Promise<AgentTerminalOutcome> => {
    await launching.get(profileId)
    const row = findAgentTerminalSession(agent.id, host.getStore().sessions)
    if (row) {
      if (!(host.lookup ?? getLiveSession)(row.id) && row.status !== "exited") {
        return { kind: "error", code: "session-unavailable" }
      }
      try {
        await (host.close ?? killFromDock)(row.id, host.getStore(), undefined, { strict: true })
      } catch (error) {
        return { kind: "error", code: "stop-failed", message: errorMessage(error) }
      }
    }
    try {
      await (host.releaseProfile ?? removeTransientTerminalProfile)(profileId)
    } catch (error) {
      return { kind: "error", code: "cleanup-failed", message: errorMessage(error) }
    }
    return { kind: "stopped" }
  })().finally(() => stopping.delete(profileId))
  stopping.set(profileId, operation)
  return operation
}
