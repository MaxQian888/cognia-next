/**
 * Tauri-shell binding for {@link CloudflaredOptions.spawn}.
 *
 * The actual subprocess is driven by the `@tauri-apps/plugin-shell` plugin.
 * That plugin isn't yet in the project's deps (the Tauri side also needs
 * the corresponding Rust crate + scope config), so this module dynamic-
 * imports it and surfaces a helpful error when missing.
 *
 * Install steps for the maintainer when wiring this up for real:
 *   1. `pnpm add -w @tauri-apps/plugin-shell`
 *   2. Add `tauri-plugin-shell` to `src-tauri/Cargo.toml`
 *   3. `app.plugin(tauri_plugin_shell::init())` in `src-tauri/src/main.rs`
 *   4. Configure `plugins.shell.scope` in `src-tauri/tauri.conf.json` to allow
 *      the `cloudflared` binary (or whatever override the user sets).
 */

import { isTauri } from "@/lib/tauri"
import type { CloudflaredProcess } from "./cloudflared"

interface ShellChildLike {
  stdout: AsyncIterable<string> & { on?: (e: string, cb: (s: string) => void) => void }
  stderr: AsyncIterable<string> & { on?: (e: string, cb: (s: string) => void) => void }
  kill(): Promise<void>
}

interface ShellCommandLike {
  spawn(): Promise<
    ShellChildLike & { on: (e: string, cb: (p: { code: number }) => void) => void }
  >
}

interface ShellPluginLike {
  Command: { create(name: string, args: string[]): ShellCommandLike }
}

async function importShellPlugin(): Promise<ShellPluginLike | null> {
  try {
    // Use a runtime-resolved specifier so TypeScript doesn't require the
    // package to be installed at type-check time. The plugin is optional —
    // its absence is handled by the caller.
    const spec = "@tauri-apps/plugin-shell"
    const mod = (await (Function("s", "return import(s)")(spec) as Promise<unknown>)) as ShellPluginLike
    return mod
  } catch {
    return null
  }
}

/**
 * Construct a Tauri-flavored spawn fn. The factory shape lets tests inject
 * a different binary name without monkey-patching the module export.
 */
export function createTauriCloudflaredSpawn(opts: { binaryName?: string } = {}): (
  args: string[]
) => Promise<CloudflaredProcess> {
  const binary = opts.binaryName ?? "cloudflared"
  return async (args: string[]) => {
    if (!isTauri()) {
      throw new Error("cloudflared: desktop-only (Tauri shell binding required)")
    }
    const mod = await importShellPlugin()
    if (!mod) {
      throw new Error(
        "cloudflared: @tauri-apps/plugin-shell is not installed. " +
          "Add it to the workspace deps and configure the shell scope to allow `cloudflared`."
      )
    }
    const cmd = mod.Command.create(binary, args)
    const child = await cmd.spawn()

    function lineStream(stream: ShellChildLike["stdout"]): AsyncIterable<string> {
      const queue: string[] = []
      let buffer = ""
      let resolver: ((v: IteratorResult<string>) => void) | null = null

      stream.on?.("data", (chunk: string) => {
        buffer += chunk
        let idx
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (resolver) {
            resolver({ value: line, done: false })
            resolver = null
          } else {
            queue.push(line)
          }
        }
      })

      const iter: AsyncIterator<string> = {
        next: () => {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false })
          }
          return new Promise<IteratorResult<string>>((resolve) => {
            resolver = resolve
          })
        },
      }
      return { [Symbol.asyncIterator]: () => iter }
    }

    let exitResolver: ((code: number) => void) | null = null
    const exit = new Promise<number>((resolve) => {
      exitResolver = resolve
    })
    child.on("close", (payload: { code: number }) => exitResolver?.(payload.code ?? 0))

    return {
      stdoutLines: () => lineStream(child.stdout),
      stderrLines: () => lineStream(child.stderr),
      waitForExit: () => exit,
      kill: () => child.kill(),
    }
  }
}
