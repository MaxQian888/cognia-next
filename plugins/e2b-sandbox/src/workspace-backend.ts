/**
 * E2B-backed workspace backend for the GitHub Delivery Issue → PR loop.
 *
 * The github-delivery plugin exposes `setE2BBackend(impl)` from
 * `lib/github/workspace`. When this plugin (`cognia-e2b-sandbox`) is enabled
 * we register a real implementation so any workflow that sets
 * `worktreeMode: "e2b"` runs the AI loop inside a fresh Firecracker microVM
 * instead of writing to the host filesystem.
 *
 * Why a separate file in this plugin:
 *   • Keeps `@e2b/sdk` as a peer / optional dep — not every user wants the
 *     cloud sandbox plumbing pulled into their bundle.
 *   • Lets us swap the SDK factory in tests without monkey-patching modules.
 *
 * Why dynamic import:
 *   • `@e2b/sdk` is not shipped as a direct dep of cognia-next. Users opt in
 *     by installing it alongside this plugin. We surface a single-line
 *     friendly install hint when the dynamic import fails.
 */

import type { E2BBackend, WorkspaceHandle } from "@/lib/github/workspace"

/** Narrow shape of `@e2b/sdk` we depend on. Real SDK exports `Sandbox`. */
export interface E2BSandboxFacade {
  id: string
  /** Run a shell command inside the sandbox, returning combined stdout/stderr. */
  exec(opts: {
    cmd: string
    cwd?: string
    timeoutMs?: number
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** Close + destroy the microVM. */
  close(): Promise<void>
}

/** Factory the backend uses to obtain a fresh sandbox. */
export type E2BSandboxFactory = (opts: { apiKey?: string }) => Promise<E2BSandboxFacade>

export interface E2BWorkspaceBackendOptions {
  /** API key forwarded to the SDK factory. Defaults to process.env.E2B_API_KEY. */
  apiKey?: string
  /** Override the sandbox factory — tests inject a mock here. */
  sandboxFactory?: E2BSandboxFactory
  /** Override `Date.now` for deterministic test output. */
  now?: () => number
}

/**
 * Concrete `E2BBackend` implementation. Each `clone()` provisions a fresh
 * sandbox; the returned `WorkspaceHandle.path` carries the sandbox id (NOT
 * a host filesystem path — the local backend remains the choice for that).
 */
export class E2BWorkspaceBackend implements E2BBackend {
  private opts: Required<Pick<E2BWorkspaceBackendOptions, "now">> & E2BWorkspaceBackendOptions
  private sandboxes = new Map<string, E2BSandboxFacade>()
  /** handle.path → sandbox.id so `commitAndPush` / `remove` find the right vm. */
  private pathToSandboxId = new Map<string, string>()

  constructor(opts: E2BWorkspaceBackendOptions = {}) {
    this.opts = { now: opts.now ?? Date.now, ...opts }
  }

  async clone(opts: {
    repoFullName: string
    branch: string
    token: string
  }): Promise<WorkspaceHandle> {
    const factory = this.opts.sandboxFactory ?? defaultSandboxFactory
    const sandbox = await factory({ apiKey: this.opts.apiKey ?? process.env.E2B_API_KEY })
    try {
      // The sandbox starts with a writable working directory; we clone into
      // /tmp/cognia/<repo>/<stamp> so multiple clones in one sandbox lifetime
      // don't collide.
      const stamp = this.opts.now().toString(36)
      const safeRepo = opts.repoFullName.replace(/[^a-zA-Z0-9._-]/g, "_")
      const cwd = `/tmp/cognia/${safeRepo}/${stamp}`
      await execChecked(sandbox, { cmd: `mkdir -p ${shellEscape(cwd)}` })
      const remote = `https://x-access-token:${opts.token}@github.com/${opts.repoFullName}.git`
      await execChecked(sandbox, {
        cmd: `git clone --branch ${shellEscape(opts.branch)} --depth 20 ${shellEscape(remote)} ${shellEscape(cwd)}`,
      })
      this.sandboxes.set(sandbox.id, sandbox)
      this.pathToSandboxId.set(cwd, sandbox.id)
      return {
        backend: "e2b",
        path: cwd,
        repoFullName: opts.repoFullName,
        branch: opts.branch,
        createdAt: this.opts.now(),
      }
    } catch (err) {
      // Best-effort cleanup so we don't leak a sandbox when clone fails.
      await sandbox.close().catch(() => undefined)
      throw err
    }
  }

  async commitAndPush(opts: {
    workspace: WorkspaceHandle
    message: string
    remoteBranch?: string
  }): Promise<string> {
    const sandbox = this.sandboxForHandle(opts.workspace)
    const branch = opts.remoteBranch ?? opts.workspace.branch
    await execChecked(sandbox, {
      cmd: `git add . && git commit -m ${shellEscape(opts.message)} && git push origin ${shellEscape(branch)} --set-upstream`,
      cwd: opts.workspace.path,
    })
    const log = await execChecked(sandbox, {
      cmd: `git log -1 --pretty=%H`,
      cwd: opts.workspace.path,
    })
    return log.stdout.trim()
  }

  async remove(handle: WorkspaceHandle): Promise<boolean> {
    const sandboxId = this.pathToSandboxId.get(handle.path)
    if (!sandboxId) return false
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) return false
    try {
      await sandbox.close()
    } catch {
      /* swallow — we still drop the handle */
    }
    this.sandboxes.delete(sandbox.id)
    this.pathToSandboxId.delete(handle.path)
    return true
  }

  /** Test utility — number of live sandboxes the backend is tracking. */
  liveSandboxCount(): number {
    return this.sandboxes.size
  }

  private sandboxForHandle(handle: WorkspaceHandle): E2BSandboxFacade {
    const sandboxId = this.pathToSandboxId.get(handle.path)
    const sandbox = sandboxId ? this.sandboxes.get(sandboxId) : undefined
    if (!sandbox) {
      throw new Error("E2B backend: no live sandbox for handle " + handle.path)
    }
    return sandbox
  }
}

async function execChecked(
  sandbox: E2BSandboxFacade,
  opts: { cmd: string; cwd?: string; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await sandbox.exec(opts)
  if (result.exitCode !== 0) {
    throw new Error(
      `E2B exec failed (${result.exitCode}): ${opts.cmd}\n${result.stderr || result.stdout}`
    )
  }
  return result
}

function shellEscape(s: string): string {
  // Single-quote the arg and escape inner single quotes — safe for bash sh -c.
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

async function defaultSandboxFactory(opts: { apiKey?: string }): Promise<E2BSandboxFacade> {
  // Dynamic import keeps `@e2b/sdk` an optional dep. When it's missing we
  // surface a single-line hint pointing users at the install path; the rest
  // of the platform stays usable. Mirrors `microvm-exec.ts`'s default factory:
  // the real SDK is async-construct (`Sandbox.create({ apiKey })`), not a
  // bare `new Sandbox(...)`.
  let mod: { Sandbox?: unknown } | undefined
  try {
    // `@e2b/sdk` is an optional peer dep — opt in via `pnpm add @e2b/sdk -w`.
    // The dynamic specifier keeps webpack from trying to resolve it at build
    // time, and the cast keeps TypeScript happy when the module isn't present.
    mod = (await (Function("s", "return import(s)") as (s: string) => Promise<unknown>)(
      "@e2b/sdk"
    )) as { Sandbox?: unknown }
  } catch {
    throw new Error(
      "@e2b/sdk is not installed. Run `pnpm add @e2b/sdk -w` and set E2B_API_KEY to enable the cloud workspace backend."
    )
  }
  const SandboxCtor = mod?.Sandbox as
    | { create?: (opts: unknown) => Promise<E2BSandboxFacade> }
    | undefined
  if (!SandboxCtor || typeof SandboxCtor.create !== "function") {
    throw new Error("@e2b/sdk does not export `Sandbox.create` — incompatible SDK version")
  }
  return SandboxCtor.create({ apiKey: opts.apiKey })
}
