import { sandboxClient } from "@/lib/automation/sandbox-client"
import type { SandboxConnectionRow, SandboxLifecycleOperation } from "@/types/sandbox"
import {
  runSandboxOperation,
  SandboxCapabilityError,
  type SandboxHealthReport,
  type SandboxProviderAdapter,
} from "./lifecycle-contract"

type SupportedConnectionOperation = Extract<
  SandboxLifecycleOperation,
  "start" | "stop" | "health" | "delete"
>

export interface SandboxLifecycleClient {
  start(connectionId: string, image: string): Promise<number>
  stop(connectionId: string): Promise<void>
  health(connectionId: string): Promise<boolean>
}

export interface SandboxConnectionOperationResult {
  port?: number
  health?: boolean
}

const operationTails = new Map<string, Promise<void>>()

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

function adapterFor(
  row: SandboxConnectionRow,
  client: SandboxLifecycleClient,
  result: SandboxConnectionOperationResult,
  operation: SupportedConnectionOperation
): SandboxProviderAdapter {
  if (row.provider !== "docker" || row.driver !== "computer-server") {
    throw new SandboxCapabilityError({
      code: "not-implemented",
      operation,
      provider: row.provider,
      driver: row.driver,
      message: `No lifecycle adapter is available for ${row.provider}/${row.driver}.`,
    })
  }
  // Narrows the config union AND catches a row whose `provider` and
  // `config.provider` disagree — starting such a row with an empty image
  // would ask Docker to run nothing at all.
  if (row.config.provider !== "docker") {
    throw new SandboxCapabilityError({
      code: "not-implemented",
      operation,
      provider: row.provider,
      driver: row.driver,
      message: `Connection "${row.id}" is a Docker row whose config describes ${row.config.provider}.`,
    })
  }
  const image = row.config.image
  return {
    provider: row.provider,
    driver: row.driver,
    start: async (ctx) => {
      result.port = await client.start(ctx.connectionId, image)
    },
    stop: async (ctx) => client.stop(ctx.connectionId),
    delete: async (ctx) => client.stop(ctx.connectionId),
    health: async (ctx) => {
      const reachable = await client.health(ctx.connectionId)
      result.health = reachable
      return { reachable, state: reachable ? "running" : ctx.state }
    },
  }
}

/**
 * Resolve the one production lifecycle adapter currently implemented, then
 * dispatch through the provider-neutral capability and state checks.
 */
export async function runSandboxConnectionOperation(
  row: SandboxConnectionRow,
  operation: SupportedConnectionOperation,
  client: SandboxLifecycleClient = sandboxClient
): Promise<SandboxConnectionOperationResult> {
  const result: SandboxConnectionOperationResult = {}
  const adapter = adapterFor(row, client, result, operation)
  const ctx = {
    connectionId: row.id,
    provider: row.provider,
    driver: row.driver,
    capabilities: row.capabilities,
    state: row.state,
  }
  await runSandboxOperation<void | SandboxHealthReport>(adapter, ctx, operation, (resolved) => {
    switch (operation) {
      case "start":
        return resolved.start?.(ctx)
      case "stop":
        return resolved.stop?.(ctx)
      case "delete":
        return resolved.delete?.(ctx)
      case "health":
        return resolved.health?.(ctx)
    }
  })
  return result
}
