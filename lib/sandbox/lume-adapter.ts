import {
  lumeClient,
  type LumeBinding,
  type LumeClient,
  type LumeProvision,
  type LumeRef,
} from "@/lib/automation/lume-client"
import type { SandboxConnectionRow, SandboxLifecycleState } from "@/types/sandbox"
import {
  SandboxCapabilityError,
  type SandboxAdapterOutcome,
  type SandboxProviderAdapter,
} from "./lifecycle-contract"

export interface LumeAdapterOptions {
  lumeClient?: LumeClient
  lumeProvision?: LumeProvision
  /** Frozen by native session admission, never reconstructed from a live row. */
  lumeBinding?: LumeBinding
}

export function lumeReference(row: SandboxConnectionRow): LumeRef {
  const config = row.config
  if (
    config.provider !== "lume" ||
    config.contractVersion !== 1 ||
    !config.resourceId ||
    !config.bootEpoch ||
    !Number.isSafeInteger(config.generation) ||
    config.generation! < 1
  )
    throw new Error("lume_resource_reference_required")
  return {
    resourceId: config.resourceId,
    generation: config.generation!,
    bootEpoch: config.bootEpoch,
  }
}

export function buildLumeSandboxAdapter(
  row: SandboxConnectionRow,
  outcome: SandboxAdapterOutcome,
  options: LumeAdapterOptions = {}
): SandboxProviderAdapter {
  if (row.config.provider !== "lume" || row.config.contractVersion !== 1)
    throw new Error("lume_contract_unsupported")
  const api = options.lumeClient ?? lumeClient
  const lifecycle = async (
    kind: "start" | "connect" | "stop" | "delete" | "health",
    signal?: AbortSignal
  ) => {
    const status = await api.run({ kind, reference: lumeReference(row) }, signal)
    if (!status.resource) throw new Error("lume_resource_reply_missing")
    outcome.lume = status.resource
    return status.resource
  }
  const bound = () => {
    if (!options.lumeBinding)
      throw new SandboxCapabilityError({
        code: "not-connected",
        operation: "workspaceExec",
        provider: "lume",
        driver: "cua-driver",
        message: "lume_native_binding_required",
      })
    return options.lumeBinding
  }
  return {
    provider: "lume",
    driver: "cua-driver",
    create: async (ctx) => {
      if (!options.lumeProvision) throw new Error("lume_provision_request_required")
      const status = await api.run(
        { kind: "provision", connection_id: row.id, source: options.lumeProvision },
        ctx.signal
      )
      if (!status.resource) throw new Error("lume_resource_reply_missing")
      outcome.lume = status.resource
    },
    start: async (ctx) => {
      await lifecycle("start", ctx.signal)
    },
    connect: async (ctx) => {
      await lifecycle("connect", ctx.signal)
    },
    stop: async () => {
      await lifecycle("stop")
    },
    delete: async () => {
      await lifecycle("delete")
    },
    health: async () => {
      const resource = await lifecycle("health")
      return {
        reachable: resource.readiness.vm && !resource.quarantine,
        state: resource.state as SandboxLifecycleState,
        ...(resource.lastErrorCode ? { error: resource.lastErrorCode } : {}),
      }
    },
    workspaceRead: async (_ctx, path) => {
      const reply = await api.file(bound(), { kind: "read", path })
      const bytes = Uint8Array.from(atob(reply.dataBase64), (character) => character.charCodeAt(0))
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    },
    workspaceExec: (ctx, request) => api.execute(bound(), request, ctx.signal),
  }
}
