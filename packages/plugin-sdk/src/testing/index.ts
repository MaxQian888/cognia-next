/**
 * `@cognia/plugin-sdk/testing` — a fully mounted `PluginContext` for plugin
 * unit tests.
 *
 * The host hands `activate()` a context on which every namespace is present.
 * Plugin suites used to build partial `{ agent: { registerTool } } as never`
 * objects instead, which is how optional chaining (`ctx.agent?.registerTool?.()`)
 * crept into production code: the fakes had holes, so the plugins learned to
 * step around holes the real host never has.
 *
 * `createTestPluginContext()` mounts every namespace the contract catalog
 * lists, with recording stubs:
 *
 * - `register*` / `on*` / `subscribe*` / `watch*` / `use` return a disposer;
 * - `logger.child` / `logger.withContext` return the logger;
 * - `i18n.t` returns the key with `{name}` params interpolated;
 * - `storage` and `secrets` are working in-memory stores;
 * - `lifecycle.onDispose` collects disposers that `dispose()` runs;
 * - everything else resolves to `undefined`.
 *
 * Pass `overrides` for anything a test wants to control (a `jest.fn()`, a
 * canned `ai.chat` reply). It is framework-agnostic: `calls` records every
 * stubbed call, so a suite does not need a mocking library to assert on them.
 */

import type { PluginContext } from "@/types/plugin/plugin"

import { PLUGIN_API_NAMESPACE_CONTRACTS } from "../contracts/catalog"

export interface TestPluginContextCall {
  /** Catalog method id, e.g. `agent.registerTool`. */
  method: string
  args: unknown[]
}

export interface TestPluginContextOptions {
  pluginId?: string
  pluginPath?: string
  config?: Record<string, unknown>
  /** Which shell `ctx.capabilities` reports. Default `"desktop"`. */
  platform?: "desktop" | "mobile" | "web"
  /** Locale `ctx.i18n.getCurrentLocale()` reports. Default `"en"`. */
  locale?: string
  /**
   * Members that replace the stubs, merged per namespace:
   * `{ agent: { registerTool: jest.fn() } }` replaces only `registerTool`.
   */
  overrides?: { [K in keyof PluginContext]?: unknown }
}

export interface TestPluginContext {
  ctx: PluginContext
  /** Every stubbed call, in order (overrides are not recorded). */
  calls: TestPluginContextCall[]
  /** The argument lists of every call to one catalog method id. */
  callsTo(method: string): unknown[][]
  /** Run the disposers collected through `ctx.lifecycle.onDispose`, newest first. */
  dispose(): Promise<void>
}

const DISPOSER_PREFIXES = ["register", "on", "subscribe", "watch"]

function returnsDisposer(name: string): boolean {
  const leaf = name.slice(name.lastIndexOf(".") + 1)
  if (leaf === "use") return true
  return DISPOSER_PREFIXES.some(
    (prefix) =>
      leaf.startsWith(prefix) && leaf.length > prefix.length && /[A-Z]/.test(leaf[prefix.length]!)
  )
}

function interpolate(key: string, params?: Record<string, unknown>): string {
  if (!params) return key
  return key.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match
  )
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".")
  let holder = root
  for (const segment of segments.slice(0, -1)) {
    const next = holder[segment]
    if (next === undefined || next === null || typeof next !== "object") holder[segment] = {}
    holder = holder[segment] as Record<string, unknown>
  }
  holder[segments[segments.length - 1]!] = value
}

function createMemoryStore() {
  const values = new Map<string, unknown>()
  const secure = new Map<string, unknown>()
  return {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
    remove: async (key: string) => {
      values.delete(key)
    },
    has: async (key: string) => values.has(key),
    keys: async () => [...values.keys()],
    clear: async () => {
      values.clear()
      secure.clear()
    },
    getOrDefault: async (key: string, fallback: unknown) =>
      values.has(key) ? values.get(key) : fallback,
    getSecure: async (key: string) => secure.get(key),
    setSecure: async (key: string, value: unknown) => {
      secure.set(key, value)
    },
    isEncrypted: async (key: string) => secure.has(key),
    getUsage: async () => ({ keys: values.size + secure.size }),
  }
}

function createMemorySecrets() {
  const values = new Map<string, string>()
  return {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
    has: async (key: string) => values.has(key),
    keys: async () => [...values.keys()],
    onDidChange: () => () => {},
  }
}

export function createTestPluginContext(options: TestPluginContextOptions = {}): TestPluginContext {
  const pluginId = options.pluginId ?? "test-plugin"
  const platform = options.platform ?? "desktop"
  const locale = options.locale ?? "en"
  const calls: TestPluginContextCall[] = []
  const disposers: Array<() => void | Promise<void>> = []
  const controller = new AbortController()

  const stub = (method: string) => {
    const disposer = returnsDisposer(method)
    return (...args: unknown[]) => {
      calls.push({ method, args })
      return disposer ? () => {} : undefined
    }
  }

  const ctx: Record<string, unknown> = {
    pluginId,
    pluginPath: options.pluginPath ?? `builtin://${pluginId}`,
    config: options.config ?? {},
  }

  for (const namespace of PLUGIN_API_NAMESPACE_CONTRACTS) {
    const surface: Record<string, unknown> = {}
    for (const method of namespace.methods) setPath(surface, method.name, stub(method.id))
    ctx[namespace.id] = surface
  }

  const logger = ctx.logger as Record<string, unknown>
  logger.child = (...args: unknown[]) => {
    calls.push({ method: "logger.child", args })
    return logger
  }
  logger.withContext = (...args: unknown[]) => {
    calls.push({ method: "logger.withContext", args })
    return logger
  }

  const i18n = ctx.i18n as Record<string, unknown>
  i18n.t = (key: string, params?: Record<string, unknown>) => {
    calls.push({ method: "i18n.t", args: [key, params] })
    return interpolate(key, params)
  }
  i18n.getCurrentLocale = () => locale
  i18n.getLocale = () => locale

  ctx.storage = createMemoryStore()
  ctx.secrets = createMemorySecrets()
  ctx.capabilities = {
    tauri: platform === "desktop",
    mobile: platform === "mobile",
    web: platform === "web",
    browser: true,
    platform: platform === "desktop" ? "tauri" : platform,
    secretsBackend: platform === "desktop" ? "os-keyring" : "encrypted-web",
  }
  ctx.lifecycle = {
    signal: controller.signal,
    onDispose: (dispose: () => void | Promise<void>) => {
      calls.push({ method: "lifecycle.onDispose", args: [dispose] })
      disposers.push(dispose)
    },
  }

  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    const current = ctx[key]
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object"
    ) {
      ctx[key] = { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) }
    } else {
      ctx[key] = value
    }
  }

  return {
    ctx: ctx as unknown as PluginContext,
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method).map((call) => call.args),
    dispose: async () => {
      controller.abort()
      for (const dispose of disposers.splice(0).reverse()) await dispose()
    },
  }
}
