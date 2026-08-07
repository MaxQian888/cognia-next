import type { PluginPermission } from "@/types/plugin"
import {
  evaluatePluginApiCall,
  recordPluginApiAudit,
  type PluginApiPlatform,
  type PluginApiRuntime,
} from "./interface-catalog"

export class PluginApiPolicyError extends Error {
  constructor(
    readonly pluginId: string,
    readonly methodId: string,
    readonly reason: "unmapped" | "runtime" | "platform" | "permission"
  ) {
    super(`Plugin "${pluginId}" cannot call "${methodId}": ${reason}`)
    this.name = "PluginApiPolicyError"
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export interface GovernedPluginContextOptions {
  pluginId: string
  runtime?: PluginApiRuntime
  platform?: PluginApiPlatform
  hasPermission(permission: PluginPermission): boolean
}

/** Applies catalog policy and metadata-only audit to every callable ctx.* path. */
export function withGovernedPluginContext<T extends object>(
  context: T,
  options: GovernedPluginContextOptions
): T {
  const nested = new WeakMap<object, object>()

  const wrap = <TValue extends object>(value: TValue, path: string): TValue =>
    new Proxy(value, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver)
        const memberPath = `${path}.${String(property)}`
        if (member && typeof member === "object" && isPlainObject(member)) {
          const cached = nested.get(member)
          if (cached) return cached
          const governed = wrap(member, memberPath)
          nested.set(member, governed)
          return governed
        }
        if (typeof member !== "function") return member

        return (...args: unknown[]) => {
          const startedAt = globalThis.performance?.now() ?? Date.now()
          const methodId = memberPath.slice("ctx.".length)
          const decision = evaluatePluginApiCall({
            methodId,
            runtime: options.runtime ?? "frontend",
            platform: options.platform ?? "desktop",
            hasPermission: options.hasPermission,
          })
          const finish = (outcome: "allowed" | "denied" | "error", errorCode?: string) => {
            const finishedAt = globalThis.performance?.now() ?? Date.now()
            recordPluginApiAudit({
              pluginId: options.pluginId,
              methodId,
              outcome,
              durationMs: Math.max(0, finishedAt - startedAt),
              dataClassification: decision.descriptor?.namespace.dataClassification ?? "unknown",
              errorCode,
            })
          }

          if (!decision.allowed && (decision.mode === "active" || decision.reason === "unmapped")) {
            finish("denied", decision.reason.toUpperCase())
            throw new PluginApiPolicyError(options.pluginId, methodId, decision.reason)
          }

          try {
            const result = member.apply(target, args)
            if (result instanceof Promise) {
              return result.then(
                (resolved) => {
                  finish("allowed")
                  return resolved
                },
                (error: unknown) => {
                  finish("error", error instanceof Error ? error.name : "UNKNOWN")
                  throw error
                }
              )
            }
            finish("allowed")
            return result
          } catch (error) {
            finish("error", error instanceof Error ? error.name : "UNKNOWN")
            throw error
          }
        }
      },
    })

  return wrap(context, "ctx")
}
