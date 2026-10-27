/** Node-only executable entry. Never re-export from ./index or ./manifest. */
import * as fs from "node:fs/promises"
import { type MakeDirectoryOptions } from "node:fs"
import * as path from "node:path"
import { once } from "node:events"
import { CodebuffBridgeRuntime } from "./bridge-runtime"
import {
  assertCodebuffNoNativeMcp,
  encodeBridgeFrame,
  CODEBUFF_BRIDGE_FRAME_LIMIT,
  type BridgeFrame,
} from "./bridge-protocol"
import {
  installCodebuffSubprocessGuard,
  runCodebuffProcess,
  spawnCodebuffReadHelper,
  validateCodebuffSearchFlags,
} from "./native-process"

/** CLI host entry is dependency-injected in tests; SDK loading remains after RPC fetch setup. */
export async function startCodebuffNodeBridge(): Promise<void> {
  let output = Promise.resolve()
  const send = (frame: BridgeFrame): Promise<void> => {
    const line = encodeBridgeFrame(frame) + "\n"
    output = output.then(async () => {
      if (!process.stdout.write(line)) await once(process.stdout, "drain")
    })
    return output
  }
  // SDK dependencies may log; stdout belongs exclusively to the bridge protocol.
  console.log =
    console.info =
    console.debug =
      () => {
        process.stderr.write("Codebuff SDK diagnostic\n")
      }
  const runtime = new CodebuffBridgeRuntime({
    send,
    createClient: async (host) => {
      const root = await fs.realpath(host.cwd)
      const inside = (absolute: string) => absolute === root || absolute.startsWith(root + path.sep)
      const confined = async (raw: unknown, writing = false): Promise<string> => {
        if (typeof raw !== "string" && !(raw instanceof URL))
          throw new Error("Unsupported Codebuff file identifier")
        const absolute = path.resolve(root, String(raw))
        if (!inside(absolute)) throw new Error("Codebuff file is outside the workspace")
        let existing = absolute
        for (;;) {
          try {
            const real = await fs.realpath(existing)
            if (!inside(real)) throw new Error("Codebuff symlink escapes its workspace")
            break
          } catch (error) {
            if (!writing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            const parent = path.dirname(existing)
            if (parent === existing) throw error
            existing = parent
          }
        }
        return absolute
      }
      const permit = async (name: string, input: Record<string, unknown>) => {
        if (!(await host.requestPermission(name, input)))
          throw new Error("Codebuff tool denied by host policy")
      }
      // The entire bridge child must have OS network=off. All SDK fetches go to
      // the host transport; native MCP and unbrokered sockets fail closed.
      globalThis.fetch = host.fetch
      installCodebuffSubprocessGuard()
      const sdk = await import("@codebuff/sdk")
      const fileSystem = {
        mkdir: async (raw: unknown, options?: unknown) => {
          const target = await confined(raw, true)
          await permit("write_file", { path: target, operation: "mkdir" })
          return fs.mkdir(await confined(target, true), options as MakeDirectoryOptions)
        },
        readdir: async (raw: unknown, options?: unknown) => {
          const target = await confined(raw)
          return fs.readdir(target, options as { withFileTypes: true })
        },
        readFile: async (raw: unknown, options?: unknown) => {
          const target = await confined(raw)
          await permit("read_files", { filePaths: [target] })
          if ((await fs.stat(await confined(target))).size > 8 * 1024 * 1024)
            throw new Error("Codebuff file exceeded the read limit")
          return fs.readFile(await confined(target), options as { encoding: null })
        },
        stat: async (raw: unknown) => fs.stat(await confined(raw)),
        unlink: async (raw: unknown) => {
          const target = await confined(raw)
          await permit("delete_file", { path: target })
          return fs.unlink(await confined(target))
        },
        writeFile: async (raw: unknown, data: unknown, options?: unknown) => {
          const target = await confined(raw, true)
          await permit("write_file", {
            path: target,
            content: typeof data === "string" ? data : "[binary]",
          })
          return fs.writeFile(
            await confined(target, true),
            data as string,
            options as { encoding: BufferEncoding }
          )
        },
      }
      const client = new sdk.CodebuffClient({
        apiKey: process.env.CODEBUFF_API_KEY,
        cwd: root,
        agentDefinitions: [],
        fsSource: fileSystem as unknown as NonNullable<
          NonNullable<ConstructorParameters<typeof sdk.CodebuffClient>[0]>["fsSource"]
        >,
        // Synchronous spawnSource is used for SDK metadata/search helpers. Shell
        // execution is brokered separately through its proven async override.
        spawnSource: (command, args, options) =>
          spawnCodebuffReadHelper(root, command, args ?? [], options),
        overrideTools: {
          run_terminal_command: async (input) => {
            if (input.process_type === "BACKGROUND")
              throw new Error("Codebuff background shell processes are not supported")
            const cwd = await confined(input.cwd || root)
            await permit("run_terminal_command", { ...input, cwd })
            const result = await runCodebuffProcess(
              "/bin/bash",
              ["--noprofile", "--norc", "-c", input.command],
              await confined(cwd),
              input.timeout_seconds ?? 60
            )
            return [{ type: "json", value: { command: input.command, ...result } }]
          },
          code_search: async (input) => {
            const cwd = await confined(input.cwd || root),
              flags = validateCodebuffSearchFlags(input.flags)
            await permit("read_files", {
              operation: "code_search",
              cwd,
              pattern: input.pattern,
              flags: input.flags,
            })
            const result = await runCodebuffProcess(
              sdk.getBundledRgPath(),
              ["--no-config", "-n", "--json", ...flags, "--", input.pattern, "."],
              await confined(cwd),
              10
            )
            const lines: string[] = []
            for (const line of result.stdout.split("\n")) {
              if (!line) continue
              const row = JSON.parse(line) as {
                type?: string
                data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } }
              }
              if (row.type === "match")
                lines.push(
                  `${row.data?.path?.text}:${row.data?.line_number}:${row.data?.lines?.text?.trimEnd()}`
                )
              if (lines.length >= Math.min(input.maxResults ?? 250, 250)) break
            }
            return [{ type: "json", value: { ...result, stdout: lines.join("\n") } }]
          },
        },
        handleEvent: host.onEvent,
        handleStreamChunk: host.onChunk,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      })
      return {
        run: async (options) => {
          assertCodebuffNoNativeMcp(options.previousRun)
          return client.run(options as Parameters<typeof client.run>[0])
        },
      }
    },
  })
  let buffer = ""
  const decoder = new TextDecoder()
  process.stdin.on("data", (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true })
    if (buffer.length > CODEBUFF_BRIDGE_FRAME_LIMIT && !buffer.includes("\n")) {
      runtime.close()
      process.stderr.write("Codebuff bridge input limit exceeded\n")
      process.exitCode = 1
      process.stdin.destroy()
      return
    }
    let index: number
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line) continue
      void runtime.receive(line).catch(() =>
        send({
          type: "error",
          error: "Codebuff bridge rejected a malformed or unsupported request",
        })
      )
    }
  })
  process.stdin.on("end", () => {
    runtime.close()
    process.exitCode = buffer.trim() ? 1 : 0
  })
  process.on("SIGTERM", () => {
    runtime.close()
    process.exit(143)
  })
  process.on("SIGINT", () => {
    runtime.close()
    process.exit(130)
  })
}

// This module is an executable subpath, not an import-time app initializer.
if (process.argv.includes("--cognia-codebuff-bridge")) {
  void startCodebuffNodeBridge().catch(() => {
    process.stderr.write("Codebuff bridge startup failed\n")
    process.exitCode = 1
  })
}
