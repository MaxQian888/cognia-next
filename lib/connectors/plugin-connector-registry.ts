/**
 * Registry of connector kinds contributed by plugins.
 *
 * A plugin used to get a running bot the moment it was enabled: the bridge
 * called its factory, started the adapter, and handed it to the bus under a
 * synthetic `${pluginId}:${type}` id. Nothing was persisted, so that bot had no
 * settings, no credentials, no trigger policy, no enable switch, and there
 * could only ever be exactly one of it — while every built-in platform lets you
 * run as many bots as you like, each configured separately.
 *
 * This registry replaces that. Enabling a plugin now registers a DEFINITION and
 * nothing else. Instances are ordinary `AdapterInstanceRow`s, so a
 * plugin-contributed bot is started, stopped, hot-reconciled, health-checked
 * and audited by exactly the same supervisor path as a built-in one — see
 * `adapter-registry.ts:buildAdapterFromRow`, whose default branch resolves
 * through here.
 *
 * Kind ownership is exclusive and checked at registration. A plugin cannot
 * claim `telegram`, cannot claim a reserved-but-unimplemented kind like
 * `email`, and cannot claim a kind another plugin already owns — otherwise
 * `buildAdapterFromRow` would have two answers for one row, and which one you
 * got would depend on plugin load order.
 */

import { ALL_PLATFORM_KINDS } from "@/types/connectors/platform-kind"
import type { PlatformAdapter } from "@/types/connectors"
import type { PluginAdapterFactory } from "@/types/connectors/plugin-adapter"
import type { PluginConnectorDef } from "@/types/plugin/plugin"

/** Why a contribution was refused. Every value is actionable by the author. */
export type PluginConnectorRejection =
  /** The kind is a built-in platform. */
  | "kind_conflict_builtin"
  /** The kind is reserved by the host for a platform it has not shipped yet. */
  | "kind_conflict_reserved"
  /** Another enabled plugin already owns this kind. */
  | "kind_conflict_plugin"
  /** `type` is missing, empty, or not a usable identifier. */
  | "kind_invalid"
  /** The config schema is not a shape this host can render or validate. */
  | "schema_unsupported"
  /** The named factory export is missing or is not callable. */
  | "factory_missing"

export interface PluginConnectorRegistration {
  pluginId: string
  /** Stable id of this contribution within its plugin. Defaults to `type`. */
  contributionId: string
  /** Plugin version that registered it — recorded on every instance created. */
  pluginRelease: string
  /** The connector kind this contribution owns, exclusively. */
  type: string
  def: PluginConnectorDef
  factory: PluginAdapterFactory
}

export type RegisterPluginConnectorResult =
  | { ok: true; registration: PluginConnectorRegistration }
  | { ok: false; reason: PluginConnectorRejection; message: string }

/** Kinds the host reserves for platforms it has declared but not implemented. */
const BUILT_IN_KINDS: ReadonlySet<string> = new Set(ALL_PLATFORM_KINDS)

/** `type` must be a stable, path-safe identifier: it lands in webhook routes. */
const KIND_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/

/** type → registration. One owner per kind, enforced at registration. */
const byKind = new Map<string, PluginConnectorRegistration>()

export interface RegisterPluginConnectorInput {
  pluginId: string
  pluginRelease: string
  def: PluginConnectorDef
  /** Resolved factory. The bridge looks up `def.factory` in the plugin exports. */
  factory: unknown
  /**
   * Whether the kind is built in. Injected so the leaf module stays free of the
   * adapter registry (which pulls in every platform adapter).
   */
  isBuiltInKind?: (kind: string) => boolean
}

/**
 * Register one contribution, or explain precisely why not.
 *
 * Returns a result rather than throwing: one bad contribution must not stop a
 * plugin's other contributions from loading, and the caller needs the reason to
 * report it.
 */
export function registerPluginConnector(
  input: RegisterPluginConnectorInput
): RegisterPluginConnectorResult {
  const { pluginId, pluginRelease, def } = input
  const type = typeof def.type === "string" ? def.type.trim() : ""

  if (!KIND_PATTERN.test(type)) {
    return {
      ok: false,
      reason: "kind_invalid",
      message:
        `connector type ${JSON.stringify(def.type)} is not a valid kind — ` +
        `expected lowercase letters, digits and hyphens (2-64 chars). The kind ` +
        `becomes part of a webhook path, so it cannot contain separators.`,
    }
  }

  const isBuiltIn = input.isBuiltInKind ?? ((kind: string) => BUILT_IN_KINDS.has(kind))
  if (isBuiltIn(type)) {
    // Distinguish "we ship this" from "we have reserved this", because the
    // remedy differs: the first means pick another name, the second means the
    // author is racing a platform the host intends to implement itself.
    const reason: PluginConnectorRejection = SHIPPED_KINDS.has(type)
      ? "kind_conflict_builtin"
      : "kind_conflict_reserved"
    return {
      ok: false,
      reason,
      message:
        reason === "kind_conflict_builtin"
          ? `connector type "${type}" is a built-in platform and cannot be replaced by a plugin`
          : `connector type "${type}" is reserved by the host for a platform it has not shipped yet`,
    }
  }

  const existing = byKind.get(type)
  if (existing && existing.pluginId !== pluginId) {
    return {
      ok: false,
      reason: "kind_conflict_plugin",
      message:
        `connector type "${type}" is already provided by plugin "${existing.pluginId}" — ` +
        `two owners for one kind would make which adapter you get depend on load order`,
    }
  }

  if (typeof input.factory !== "function") {
    return {
      ok: false,
      reason: "factory_missing",
      message: `factory "${def.factory}" is not an exported function of plugin "${pluginId}"`,
    }
  }

  if (!isUsableConfigSchema(def.configSchema)) {
    return {
      ok: false,
      reason: "schema_unsupported",
      message:
        `connector "${type}" declares a config schema this host cannot render or ` +
        `validate — it must be a JSON-Schema object with a \`properties\` map`,
    }
  }

  const registration: PluginConnectorRegistration = {
    pluginId,
    contributionId: contributionIdOf(def),
    pluginRelease,
    type,
    def,
    factory: input.factory as PluginAdapterFactory,
  }
  byKind.set(type, registration)
  return { ok: true, registration }
}

/** Kinds the host actually implements (as opposed to merely reserving). */
const SHIPPED_KINDS: ReadonlySet<string> = new Set([
  "telegram",
  "discord",
  "slack",
  "lark",
  "onebot",
  "dingtalk",
  "wecom",
  "wechat-oa",
  "wechat-personal",
  "qq-official",
  "matrix",
])

/**
 * The contribution's stable id inside its plugin.
 *
 * Falls back to `type` for definitions written before the field existed, which
 * is correct: a plugin could only ever contribute one connector per kind.
 */
export function contributionIdOf(def: PluginConnectorDef): string {
  const explicit = (def as { contributionId?: unknown }).contributionId
  return typeof explicit === "string" && explicit.trim().length > 0
    ? explicit.trim()
    : String(def.type)
}

/**
 * A schema is usable when a settings form can be generated from it. Anything
 * else is refused up front rather than producing an instance nobody can
 * configure.
 */
export function isUsableConfigSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false
  const obj = schema as { type?: unknown; properties?: unknown }
  // `type` may be omitted; `properties` is what the form generator needs.
  if (obj.type !== undefined && obj.type !== "object") return false
  if (obj.properties === undefined) return true // an empty settings shape is fine
  return typeof obj.properties === "object" && !Array.isArray(obj.properties)
}

/**
 * Which fields of a contributed schema hold secrets.
 *
 * Derived from the schema rather than a new `PluginConnectorDef` field,
 * because JSON Schema already says it two ways and both are what an author
 * reaches for: `writeOnly` (draft-07, "may be sent but never returned") and
 * `format: "password"` (the annotation that means "mask this"). A plugin
 * author who writes either gets the same credential handling a built-in
 * platform has — stored in the OS keyring, prefilled masked, revealable —
 * without the host inventing a private vocabulary for it.
 *
 * Secrets are NEVER persisted into `AdapterInstanceRow.settings`; that is the
 * whole point of separating them, and it is why the form generator keeps two
 * value maps rather than one.
 */
export function pluginConnectorSecretFields(schema: unknown): string[] {
  if (!isUsableConfigSchema(schema)) return []
  const properties = (schema as { properties?: Record<string, unknown> }).properties
  if (!properties) return []
  return Object.entries(properties)
    .filter(([, prop]) => {
      if (!prop || typeof prop !== "object") return false
      const p = prop as { writeOnly?: unknown; format?: unknown }
      return p.writeOnly === true || p.format === "password"
    })
    .map(([name]) => name)
}

/** Resolve the owner of a connector kind, if any. */
export function getPluginConnector(type: string): PluginConnectorRegistration | undefined {
  return byKind.get(type)
}

/** Every registered contribution, for the settings picker. */
export function listPluginConnectors(): PluginConnectorRegistration[] {
  return [...byKind.values()].sort((a, b) => a.type.localeCompare(b.type))
}

/** Contributions owned by one plugin. */
export function listPluginConnectorsFor(pluginId: string): PluginConnectorRegistration[] {
  return listPluginConnectors().filter((r) => r.pluginId === pluginId)
}

/**
 * Drop every kind owned by `pluginId`. Returns the kinds removed so the caller
 * can report which instances just lost their implementation — those rows stay
 * in Dexie, disabled and explainable, rather than vanishing with the plugin.
 */
export function unregisterPluginConnectors(pluginId: string): string[] {
  const removed: string[] = []
  for (const [type, registration] of byKind) {
    if (registration.pluginId !== pluginId) continue
    byKind.delete(type)
    removed.push(type)
  }
  return removed
}

/** Build a plugin-contributed adapter for one persisted instance. */
export async function buildPluginAdapter(row: {
  id: string
  type: string
}): Promise<PlatformAdapter | null> {
  const registration = byKind.get(row.type)
  if (!registration) return null
  return registration.factory({
    pluginId: registration.pluginId,
    connectorDef: registration.def,
  })
}

/** Test-only: forget every registration. */
export function __resetPluginConnectorRegistryForTesting(): void {
  byKind.clear()
}
