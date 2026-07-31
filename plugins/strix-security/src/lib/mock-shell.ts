// Test-only scriptable mock of the plugin terminal API. Understands the
// sentinel-framing protocol (pty-read.ts): when the runner/preflight writes a
// framed command, the mock extracts the inner command + token, asks the
// supplied resolver for an { output, exitCode }, and emits the corresponding
// completion markers back through onData. Imported only by *.test.ts files.

import type { PluginTerminalAPI, PluginTerminalCommandRecord } from "@/lib/plugin/api/terminal-api"

export interface ScriptedResponse {
  output?: string
  exitCode?: number
}

export type CommandResolver = (innerCommand: string) => ScriptedResponse

interface Framed {
  kind: "run" | "capture"
  token: string
  inner: string
}

/** Parse a framed command written by pty-read's builders. */
export function parseFramed(raw: string): Framed | null {
  const cmd = raw.replace(/\n$/, "")
  if (cmd.startsWith("printf '@@SXC:")) {
    const token = cmd.slice("printf '@@SXC:".length, cmd.indexOf("@@'"))
    const start = cmd.indexOf("'; { ") + "'; { ".length
    const end = cmd.indexOf("; } 2>&1")
    if (start < 0 || end < 0) return null
    return { kind: "capture", token, inner: cmd.slice(start, end) }
  }
  const marker = "; printf '\\n@@SXD:"
  const idx = cmd.indexOf(marker)
  if (idx >= 0) {
    const inner = cmd.slice(0, idx)
    const rest = cmd.slice(idx + marker.length)
    const token = rest.slice(0, rest.indexOf(":%s@@"))
    return { kind: "run", token, inner }
  }
  return null
}

export interface MockTerminal {
  terminal: PluginTerminalAPI
  writes: string[]
  killed: string[]
  spawnCount: number
}

export function createMockTerminal(resolve: CommandResolver): MockTerminal {
  let handler: ((b: Uint8Array) => void) | null = null
  const writes: string[] = []
  const killed: string[] = []
  const enc = new TextEncoder()
  const state = { spawnCount: 0 }
  const emit = (s: string) => handler?.(enc.encode(s))

  const terminal = {
    spawn: async () => {
      state.spawnCount += 1
      return { id: "sess-1", shell: "bash" }
    },
    runScript: async () => ({ id: "sess-1", shell: "bash" }),
    detectScriptType: () => null,
    onData: (_id: string, h: (b: Uint8Array) => void) => {
      handler = h
      return () => {
        handler = null
      }
    },
    write: async (_id: string, data: string | Uint8Array) => {
      const cmd = typeof data === "string" ? data : new TextDecoder().decode(data)
      writes.push(cmd)
      const framed = parseFramed(cmd)
      if (!framed) return
      const { output = "", exitCode = 0 } = resolve(framed.inner)
      if (framed.kind === "run") {
        // Stream any program output, then the completion marker.
        emit(`${output}\n@@SXD:${framed.token}:${exitCode}@@\n`)
      } else {
        emit(`@@SXC:${framed.token}@@${output}@@SXE:${framed.token}:${exitCode}@@\n`)
      }
    },
    kill: async (id: string) => {
      killed.push(id)
    },
    readRecent: (): PluginTerminalCommandRecord[] => [],
    list: () => [],
    registerCompletionProvider: () => () => {},
    registerCommandSafetyRule: () => () => {},
    classifyCommand: () => ({}) as never,
  } as unknown as PluginTerminalAPI

  return {
    terminal,
    writes,
    killed,
    get spawnCount() {
      return state.spawnCount
    },
  }
}

/** Immediate scheduler for deps.sleep in tests. */
export const immediateSleep = (): Promise<void> => Promise.resolve()

/** Deterministic incrementing id generator (unique per-command tokens). */
export function counterId(prefix = "id"): () => string {
  let n = 0
  return () => `${prefix}${n++}`
}
