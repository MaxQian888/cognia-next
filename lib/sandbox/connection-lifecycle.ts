import { sandboxClient, type SandboxClient } from "@/lib/automation/sandbox-client"
import type { SandboxConnectionRow, SandboxLifecycleOperation } from "@/types/sandbox"
import { sandboxAdapterFactoryFor } from "./adapter-registry"
import type { DockerAdapterOutcome } from "./docker-adapter"
import {
  runSandboxOperation,
  SandboxCapabilityError,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxHealthReport,
} from "./lifecycle-contract"

/**
 * The lifecycle operations this dispatcher can carry. `gui` is absent on
 * purpose: GUI actions ride the `desktop.*` client with a
 * `sandboxConnectionId` in their `CallContext` rather than this path.
 */
export type SupportedConnectionOperation = Exclude<SandboxLifecycleOperation, "connect" | "gui">

export interface SandboxConnectionOperationResult {
  containerId?: string
  port?: number
  health?: boolean
  /** Present when the operation resolved the machine's real state. */
  healthReport?: SandboxHealthReport
  /** Present for `workspaceExec`. */
  exec?: SandboxExecResult
  /** Present for `workspaceRead`. */
  contents?: string
}

export interface SandboxOperationOptions {
  client?: SandboxClient
  /** Required for `workspaceExec`. */
  exec?: SandboxExecRequest
  /** Required for `workspaceRead`. */
  path?: string
}

const operationTails = new Map<string, Promise<void>>()

/** Whether this row is backed by a production lifecycle adapter. */
export function hasSandboxConnectionLifecycleAdapter(row: SandboxConnectionRow): boolean {
  return sandboxAdapterFactoryFor(row) !== null
}

/** Serialize lifecycle mutations per connection without coupling unrelated rows. */
export function serializeSandboxConnectionOperation<T>(
  connectionId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = operationTails.get(connectionId) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  operationTails.set(connectionId, tail)
  void tail.finally(() => {
    if (operationTails.get(connectionId) === tail) operationTails.delete(connectionId)
  })
  return result
}

/**
 * Resolve the production adapter for this row, then dispatch through the
 * provider-neutral capability and state checks.
 */
export async function runSandboxConnectionOperation(
  row: SandboxConnectionRow,
  operation: SupportedConnectionOperation,
  options: SandboxOperationOptions = {}
): Promise<SandboxConnectionOperationResult> {
  const factory = sandboxAdapterFactoryFor(row)
  if (!factory) {
    throw new SandboxCapabilityError({
      code: "not-implemented",
      operation,
      provider: row.provider,
      driver: row.driver,
      message: `No lifecycle adapter is available for ${row.provider}/${row.driver}.`,
    })
  }

  const outcome: DockerAdapterOutcome = {}
  const result: SandboxConnectionOperationResult = {}
  const adapter = factory(row, options.client ?? sandboxClient, outcome, operation)
  const ctx = {
    connectionId: row.id,
    provider: row.provider,
    driver: row.driver,
    capabilities: row.capabilities,
    state: row.state,
  }

  await runSandboxOperation<void | SandboxHealthReport | SandboxExecResult | string>(
    adapter,
    ctx,
    operation,
    (resolved) => {
      switch (operation) {
        case "create":
          return resolved.create?.(ctx)
        case "start":
          return resolved.start?.(ctx)
        case "suspend":
          return resolved.suspend?.(ctx)
        case "resume":
          return resolved.resume?.(ctx)
        case "stop":
          return resolved.stop?.(ctx)
        case "delete":
          return resolved.delete?.(ctx)
        case "health":
          return resolved.health?.(ctx).then((report) => {
            result.healthReport = report
            return report
          })
        case "workspaceRead": {
          // A missing path is a caller bug, not a capability refusal. Passing
          // `undefined` through would read whatever `cat undefined` finds.
          if (options.path === undefined) {
            throw new SandboxCapabilityError({
              code: "not-implemented",
              operation,
              provider: row.provider,
              driver: row.driver,
              message: "workspaceRead was dispatched without a path.",
            })
          }
          return resolved.workspaceRead?.(ctx, options.path).then((contents) => {
            result.contents = contents
            return contents
          })
        }
        case "workspaceExec": {
          if (!options.exec) {
            throw new SandboxCapabilityError({
              code: "not-implemented",
              operation,
              provider: row.provider,
              driver: row.driver,
              message: "workspaceExec was dispatched without a command.",
            })
          }
          return resolved.workspaceExec?.(ctx, options.exec).then((exec) => {
            result.exec = exec
            return exec
          })
        }
      }
    }
  )

  if (outcome.containerId !== undefined) result.containerId = outcome.containerId
  if (outcome.port !== undefined) result.port = outcome.port
  if (outcome.health !== undefined) result.health = outcome.health
  return result
}
