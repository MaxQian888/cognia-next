import fs from "node:fs"
import path from "node:path"

export interface DurableRpcSessionState {
  schemaVersion: 1
  tags: string[]
  commandResults: Record<string, unknown>
  pendingPermissions: Record<string, Record<string, unknown>>
  pendingElicitations: Record<string, Record<string, unknown>>
  pendingExternalTools: Record<string, Record<string, unknown>>
  sandboxPolicy: Record<string, unknown> | null
  sandboxSnapshots: Record<
    string,
    { snapshotId: string; createdAt: string; policy: Record<string, unknown> | null }
  >
  suspendedTurn: DurableRpcSuspendedTurn | null
  recoveryRequired: boolean
}

export interface DurableRpcSuspendedTurn {
  prompt: string
  params: Record<string, unknown>
  runId?: string
  turnId?: string
  attempt: number
  permissionResponses: Record<string, Record<string, unknown>>
  elicitationResponses: Record<string, Record<string, unknown>>
  externalToolResponses: Record<string, Record<string, unknown>>
}

export interface DurableRpcStateStore {
  read(sessionId: string): DurableRpcSessionState
  update(
    sessionId: string,
    mutate: (state: DurableRpcSessionState) => DurableRpcSessionState | void
  ): DurableRpcSessionState
}

export function createDurableRpcStateStore(
  sessionDir: (sessionId: string) => string
): DurableRpcStateStore {
  function filePath(sessionId: string): string {
    return path.join(sessionDir(sessionId), "rpc-state.json")
  }

  function read(sessionId: string): DurableRpcSessionState {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(filePath(sessionId), "utf8")
      ) as Partial<DurableRpcSessionState>
      return {
        schemaVersion: 1,
        tags: Array.isArray(parsed.tags)
          ? parsed.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
        commandResults: isRecord(parsed.commandResults) ? parsed.commandResults : {},
        pendingPermissions: isRecordOfRecords(parsed.pendingPermissions)
          ? parsed.pendingPermissions
          : {},
        pendingElicitations: isRecordOfRecords(parsed.pendingElicitations)
          ? parsed.pendingElicitations
          : {},
        pendingExternalTools: isRecordOfRecords(parsed.pendingExternalTools)
          ? parsed.pendingExternalTools
          : {},
        sandboxPolicy: isRecord(parsed.sandboxPolicy) ? parsed.sandboxPolicy : null,
        sandboxSnapshots: isRecordOfSandboxSnapshots(parsed.sandboxSnapshots)
          ? parsed.sandboxSnapshots
          : {},
        suspendedTurn: isSuspendedTurn(parsed.suspendedTurn) ? parsed.suspendedTurn : null,
        recoveryRequired: parsed.recoveryRequired === true,
      }
    } catch {
      return emptyState()
    }
  }

  function update(
    sessionId: string,
    mutate: (state: DurableRpcSessionState) => DurableRpcSessionState | void
  ): DurableRpcSessionState {
    const current = read(sessionId)
    const next = mutate(current) ?? current
    const target = filePath(sessionId)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, target)
    return next
  }

  return { read, update }
}

function emptyState(): DurableRpcSessionState {
  return {
    schemaVersion: 1,
    tags: [],
    commandResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingExternalTools: {},
    sandboxPolicy: null,
    sandboxSnapshots: {},
    suspendedTurn: null,
    recoveryRequired: false,
  }
}

function isSuspendedTurn(value: unknown): value is DurableRpcSuspendedTurn {
  return (
    isRecord(value) &&
    typeof value.prompt === "string" &&
    isRecord(value.params) &&
    (value.runId === undefined || typeof value.runId === "string") &&
    (value.turnId === undefined || typeof value.turnId === "string") &&
    typeof value.attempt === "number" &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt >= 0 &&
    isRecordOfRecords(value.permissionResponses) &&
    isRecordOfRecords(value.elicitationResponses) &&
    isRecordOfRecords(value.externalToolResponses)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isRecordOfRecords(value: unknown): value is Record<string, Record<string, unknown>> {
  return isRecord(value) && Object.values(value).every(isRecord)
}

function isRecordOfSandboxSnapshots(
  value: unknown
): value is DurableRpcSessionState["sandboxSnapshots"] {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (snapshot) =>
        isRecord(snapshot) &&
        typeof snapshot.snapshotId === "string" &&
        typeof snapshot.createdAt === "string" &&
        (snapshot.policy === null || isRecord(snapshot.policy))
    )
  )
}
