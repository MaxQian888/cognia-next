import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

export const RESULT_PREFIX = "COGNIA_PLUGIN_RESULT:"
const CALLBACK_CHAIN_PREFIX = "chain:"
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"])
const HOST_PRIVATE_IMPORT_PATTERN =
  /(?:from\s*|import\s*\(|require\s*\(|import\s+(?=["']))\s*["'](@\/(?:lib|types|components|stores)(?:\/[^"']*)?)["']/g

function writeResult(value) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(value)}\n`)
}

function redirectConsole() {
  for (const level of ["debug", "info", "log", "warn", "error"]) {
    console[level] = (...args) => process.stderr.write(`[plugin:${level}] ${args.join(" ")}\n`)
  }
}

export function createRecordingContext({ pluginId, manifest = {}, config = {} }) {
  const calls = []
  const callbacks = new Map()
  const seen = new WeakSet()

  const encode = (value, callbackPath, callbackHandleForPath) => {
    if (typeof value === "function") {
      callbacks.set(callbackPath, value)
      return { $callback: callbackHandleForPath?.(callbackPath) ?? callbackPath }
    }
    if (value === undefined) return { $undefined: true }
    if (value === null || typeof value !== "object") return value
    if (seen.has(value)) throw new Error(`Plugin context call contains a cycle at ${callbackPath}`)
    seen.add(value)
    const encoded = Array.isArray(value)
      ? value.map((item, index) => encode(item, `${callbackPath}.${index}`, callbackHandleForPath))
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            encode(item, `${callbackPath}.${key}`, callbackHandleForPath),
          ])
        )
    seen.delete(value)
    return encoded
  }

  const proxyFor = (segments) => {
    const callable = () => undefined
    return new Proxy(callable, {
      get(_target, property) {
        if (property === "then") return undefined
        if (segments.length === 0 && property === "pluginId") return pluginId
        if (segments.length === 0 && property === "manifest") return manifest
        if (segments.length === 0 && property === "config") return config
        if (typeof property !== "string") return undefined
        return proxyFor([...segments, property])
      },
      apply(_target, _thisArg, args) {
        const path = segments.join(".")
        const callIndex = calls.length
        calls.push({
          path,
          args: encode(args, `call.${callIndex}.args`),
        })
        return undefined
      },
    })
  }

  return { context: proxyFor([]), calls, callbacks, encode }
}

function encodeCallbackChain(plan) {
  return `${CALLBACK_CHAIN_PREFIX}${Buffer.from(JSON.stringify(plan)).toString("base64url")}`
}

export function parseCallbackChain(callbackId) {
  if (!callbackId.startsWith(CALLBACK_CHAIN_PREFIX)) return null
  const encoded = callbackId.slice(CALLBACK_CHAIN_PREFIX.length)
  if (!encoded || encoded.length > 96 * 1024) {
    throw new Error("Invalid Node plugin callback chain")
  }
  const plan = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  if (
    !plan ||
    typeof plan !== "object" ||
    typeof plan.root !== "string" ||
    !Array.isArray(plan.rootArgs) ||
    !Array.isArray(plan.steps) ||
    !Array.isArray(plan.path) ||
    plan.steps.length > 16
  ) {
    throw new Error("Invalid Node plugin callback chain")
  }
  for (const segment of [
    ...plan.path,
    ...plan.steps.flatMap((step) => (Array.isArray(step?.path) ? step.path : [null])),
  ]) {
    if (typeof segment !== "string" || UNSAFE_PATH_SEGMENTS.has(segment)) {
      throw new Error("Unsafe Node plugin callback chain path")
    }
  }
  if (plan.steps.some((step) => !step || !Array.isArray(step.args))) {
    throw new Error("Invalid Node plugin callback chain step")
  }
  return plan
}

function callbackAtPath(value, path) {
  let owner
  let current = value
  for (const segment of path) {
    owner = current
    current = current?.[segment]
  }
  if (typeof current !== "function") {
    throw new Error(`Node plugin callback result is not callable at ${path.join(".")}`)
  }
  return { callback: current, owner }
}

async function invokeCallbackChain(recorder, plan, args) {
  const root = recorder.callbacks.get(plan.root)
  if (!root) throw new Error(`Node plugin callback not found: ${plan.root}`)
  let value = await root(...plan.rootArgs)
  for (const step of plan.steps) {
    const { callback, owner } = callbackAtPath(value, step.path)
    value = await callback.apply(owner, step.args)
  }
  const { callback, owner } = callbackAtPath(value, plan.path)
  return {
    result: await callback.apply(owner, args),
    history: {
      root: plan.root,
      rootArgs: plan.rootArgs,
      steps: [...plan.steps, { path: plan.path, args }],
    },
  }
}

function encodeCallbackResult(recorder, result, history) {
  return recorder.encode(result, "result", (callbackPath) => {
    const path = callbackPath === "result" ? [] : callbackPath.slice("result.".length).split(".")
    return encodeCallbackChain({ ...history, path })
  })
}

export function resolvePluginDefinition(moduleExports) {
  const first = moduleExports?.default ?? moduleExports
  const definition = first?.default?.activate ? first.default : first
  if (!definition || typeof definition.activate !== "function") {
    throw new Error("Node plugin entry must export a PluginDefinition with activate(ctx)")
  }
  return definition
}

async function loadDefinition(entry) {
  const source = await readFile(entry, "utf8")
  const hostPrivateImports = [...source.matchAll(HOST_PRIVATE_IMPORT_PATTERN)].map(
    (match) => match[1]
  )
  if (hostPrivateImports.length > 0) {
    throw new Error(
      `Marketplace plugin ${entry} imports host-private modules: ${[
        ...new Set(hostPrivateImports),
      ].join(", ")}`
    )
  }
  const moduleExports = await import(`${pathToFileURL(entry).href}?host=${Date.now()}`)
  return { definition: resolvePluginDefinition(moduleExports), moduleExports }
}

async function activate(entry, pluginId) {
  const { definition, moduleExports } = await loadDefinition(entry)
  const recorder = createRecordingContext({
    pluginId,
    manifest: definition.manifest ?? {},
    config: {},
  })
  const hooks = (await definition.activate(recorder.context)) ?? {}
  const encodedHooks = recorder.encode(hooks, "hooks")
  const publicExports = Object.fromEntries(
    Object.entries(moduleExports).filter(([name]) => name !== "default")
  )
  const encodedExports = recorder.encode(publicExports, "exports")
  return { definition, recorder, encodedHooks, encodedExports }
}

async function main() {
  redirectConsole()
  const [action, entry, pluginId, callbackId = "", argsJson = "[]"] = process.argv.slice(1)
  if (!entry || !pluginId) throw new Error("Node plugin host requires entry and plugin id")

  if (action === "deactivate") {
    const { definition } = await loadDefinition(entry)
    if (typeof definition.deactivate === "function") {
      const { context } = createRecordingContext({
        pluginId,
        manifest: definition.manifest ?? {},
        config: {},
      })
      await definition.deactivate(context)
    }
    writeResult({ ok: true })
    return
  }

  const { recorder, encodedHooks, encodedExports } = await activate(entry, pluginId)
  if (action === "callback") {
    const args = JSON.parse(argsJson)
    if (!Array.isArray(args)) throw new Error("Node plugin callback arguments must be an array")
    const chain = parseCallbackChain(callbackId)
    if (chain) {
      const { result, history } = await invokeCallbackChain(recorder, chain, args)
      writeResult({ result: encodeCallbackResult(recorder, result, history) })
      return
    }
    const callback = recorder.callbacks.get(callbackId)
    if (!callback) throw new Error(`Node plugin callback not found: ${callbackId}`)
    const result = await callback(...args)
    writeResult({
      result: encodeCallbackResult(recorder, result, {
        root: callbackId,
        rootArgs: args,
        steps: [],
      }),
    })
    return
  }
  if (action !== "activate-wait") throw new Error(`Unknown Node plugin host action: ${action}`)
  writeResult({ calls: recorder.calls, hooks: encodedHooks, exports: encodedExports })
  setInterval(() => {}, 60_000)
}

if (["activate-wait", "callback", "deactivate"].includes(process.argv[1])) {
  main().catch((error) => {
    writeResult({ error: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
  })
}
