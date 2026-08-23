// The sandbox child realm for the Code tool presentation (ADR-0117, Phase 4).
//
// This process runs exactly one program, in a `node:vm` context that contains
// nothing but ECMAScript intrinsics plus a `cognia` object of read-only tool
// proxies. What is deliberately NOT in that context:
//
//   process, require, module, globalThis-of-the-host, Buffer, fetch,
//   setTimeout/setInterval, WebAssembly, eval, new Function
//
// The last two are blocked by `codeGeneration: { strings: false, wasm: false }`
// on the context rather than by scrubbing names, because a name scrub is a
// blocklist and this needs to be an allowlist. The program is compiled by
// `vm.Script` in THIS realm and then run in the restricted one, which is why
// disabling in-context code generation does not stop it from running.
//
// IMPORTANT — this is the JavaScript layer of the sandbox, not the whole thing.
// It cannot stop a V8 escape, and it is not what keeps the filesystem and the
// network away: that is the OS-level confinement the supervisor requires before
// it will spawn this process at all. If that confinement is unavailable the
// supervisor fails closed and this file never runs.

import vm from "node:vm"
import process from "node:process"

/** Wire protocol between supervisor and child. Kept tiny and explicit. */
export const CHILD_MESSAGE_KINDS = Object.freeze({
  READY: "ready",
  START: "start",
  TOOL_CALL: "tool-call",
  TOOL_RESULT: "tool-result",
  DONE: "done",
  FAILED: "failed",
  LOG: "log",
})

/**
 * Bootstrap that builds `cognia` and `console` **inside** the sandbox realm.
 *
 * It must run in-context rather than being assembled out here, because every
 * object reachable from the program leaks the realm it was created in. A host
 * function injected directly gives the program `fn.constructor` — the host
 * realm's `Function` — and `codeGeneration: { strings: false }` does not apply
 * to that realm, so `cognia.read.constructor("return process")()` would compile
 * and hand back the child's real `process`. (That is not hypothetical; it is
 * what the first version of this file did, and the escape test caught it.)
 *
 * So: the host bridges are passed as arguments to an in-context factory, which
 * closes over them and exposes only in-context wrappers. Nothing the program
 * can touch has a host-realm prototype.
 */
const BOOTSTRAP_SOURCE = `(function (bridge, logBridge, toolNames) {
  const sdk = Object.create(null)
  for (const name of toolNames) {
    Object.defineProperty(sdk, name, {
      // Not writable, not configurable: the program must not be able to swap a
      // tool proxy for its own function and hand the object to something that
      // trusts it.
      value: function (input) {
        return new Promise(function (resolve, reject) {
          // Results and errors cross as JSON text and are revived HERE, so the
          // objects the program inspects belong to this realm. Handing over a
          // host object would leak its prototype chain the same way a host
          // function does.
          bridge(name, input, function (json) {
            try { resolve(JSON.parse(json)) } catch (e) { reject(new Error("bad result")) }
          }, function (message) {
            reject(new Error(String(message)))
          })
        })
      },
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }

  const format = function (value) {
    if (typeof value === "string") return value
    try { return JSON.stringify(value) } catch (e) { return String(value) }
  }
  const emit = function (level) {
    return function () {
      const parts = []
      for (let i = 0; i < arguments.length; i++) parts.push(format(arguments[i]))
      logBridge(level, parts.join(" "))
    }
  }

  return {
    cognia: Object.freeze(sdk),
    console: Object.freeze({ log: emit("info"), warn: emit("warn"), error: emit("error") }),
  }
})`

/**
 * Run one program to completion inside a restricted context.
 *
 * @param {object} options
 * @param {string} options.source
 * @param {ReadonlyArray<string>} options.toolNames
 * @param {(name: string, input: unknown) => Promise<unknown>} options.invoke
 * @param {(level: string, text: string) => void} [options.onLog]
 * @returns {Promise<unknown>} whatever the program returns
 */
export async function runProgram({ source, toolNames, invoke, onLog }) {
  const context = vm.createContext(Object.create(null), {
    name: "cognia-code-sandbox",
    codeGeneration: { strings: false, wasm: false },
  })

  const buildGlobals = new vm.Script(BOOTSTRAP_SOURCE, {
    filename: "cognia-sdk-bootstrap.js",
  }).runInContext(context)

  // `bridge` and `logBridge` are host functions, but they are only ever
  // arguments to the in-context factory — they are captured in its closure and
  // never become reachable from the program.
  const bridge = (name, input, resolve, reject) => {
    Promise.resolve()
      .then(() => invoke(name, input))
      .then((result) => resolve(JSON.stringify(result ?? null)))
      .catch((error) => reject(String(error?.message ?? error)))
  }
  const logBridge = (level, text) => onLog?.(String(level), String(text))

  // Read back the in-context objects and install them as globals. The values
  // crossing this line were created inside the sandbox, so nothing host-realm
  // becomes reachable from the program.
  const globals = buildGlobals(bridge, logBridge, [...toolNames])
  context.cognia = globals.cognia
  context.console = globals.console

  // The program is authored as a module body, so it is wrapped in an async IIFE
  // and its completion value is the run's result. `return` at top level of the
  // model's source therefore works, which is the shape the SDK docs promise.
  const script = new vm.Script(`(async () => {\n${source}\n})()`, {
    filename: "program.js",
  })

  return await script.runInContext(context)
}

/**
 * IPC entry point. Only runs when this module is the process entry, so the
 * exports above stay unit-testable without spawning anything.
 */
export function runSandboxChild() {
  /** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
  const pending = new Map()
  let nextCallId = 0

  const send = (message) => {
    process.send?.(message)
  }

  const invoke = (name, input) =>
    new Promise((resolve, reject) => {
      const id = ++nextCallId
      pending.set(id, { resolve, reject })
      send({ kind: CHILD_MESSAGE_KINDS.TOOL_CALL, id, name, input })
    })

  process.on("message", (message) => {
    if (!message || typeof message !== "object") return

    if (message.kind === CHILD_MESSAGE_KINDS.TOOL_RESULT) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(String(message.error)))
      else entry.resolve(message.result)
      return
    }

    if (message.kind === CHILD_MESSAGE_KINDS.START) {
      runProgram({
        source: String(message.source ?? ""),
        toolNames: Array.isArray(message.toolNames) ? message.toolNames : [],
        invoke,
        onLog: (level, text) => send({ kind: CHILD_MESSAGE_KINDS.LOG, level, text }),
      })
        .then((result) => {
          send({ kind: CHILD_MESSAGE_KINDS.DONE, result: safeResult(result) })
        })
        .catch((error) => {
          send({
            kind: CHILD_MESSAGE_KINDS.FAILED,
            // Only the message and name cross the boundary. A stack would carry
            // host filesystem paths back into something the model can read.
            error: { name: error?.name ?? "Error", message: String(error?.message ?? error) },
          })
        })
    }
  })

  send({ kind: CHILD_MESSAGE_KINDS.READY })
}

/**
 * Make a value safe to hand to `process.send`.
 *
 * Anything not JSON-representable becomes a string. A program returning a
 * function or a cyclic object would otherwise kill the IPC channel and look
 * like a sandbox crash.
 */
export function safeResult(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return String(value)
  }
}

if (process.env.COGNIA_CODE_SANDBOX_CHILD === "1" && process.env.COGNIA_ROLE !== "run-code") {
  runSandboxChild()
}
