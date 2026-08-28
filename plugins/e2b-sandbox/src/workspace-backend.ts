/**
 * E2B-backed workspace backend for Marketplace integrations.
 *
 * The plugin registers this implementation through
 * `ctx.workspace.registerBackend(...)` (the former `setE2BBackend` shim has
 * been removed). Integrations that select `worktreeMode: "e2b"`
 * run their AI loop inside a fresh Firecracker microVM instead of writing to
 * the host filesystem.
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

import type { E2BBackend, WorkspaceHandle } from "@cognia/plugin-sdk/api/sandbox"
import { E2BSandboxPool } from "./sandbox-pool"

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

/** Connection options forwarded to the E2B-compatible SDK factory. */
export interface E2BSandboxConnection {
  apiKey?: string
  /** SDK option name. AgentENV's `E2B_API_URL` is normalized into this. */
  domain?: string
  /** E2B instance-creation network gate. */
  allowInternetAccess?: boolean
}

/** Factory the backend uses to obtain a fresh sandbox. */
export type E2BSandboxFactory = (opts: E2BSandboxConnection) => Promise<E2BSandboxFacade>

export interface E2BWorkspaceBackendOptions {
  /** API key forwarded to the SDK factory. */
  apiKey?: string
  /** E2B-compatible API URL. AgentENV documents this as E2B_API_URL. */
  apiUrl?: string
  /** Native @e2b/sdk domain override. Takes precedence over apiUrl. */
  domain?: string
  /** Dynamic config resolver used by the plugin settings lifecycle. */
  connection?: () => E2BSandboxConnection
  /** Override the sandbox factory — tests inject a mock here. */
  sandboxFactory?: E2BSandboxFactory
  /** Shared identity pool used by the owner-scoped exec adapter. */
  pool?: E2BSandboxPool
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
  private readonly pool: E2BSandboxPool

  constructor(opts: E2BWorkspaceBackendOptions = {}) {
    this.opts = { now: opts.now ?? Date.now, ...opts }
    this.pool = opts.pool ?? new E2BSandboxPool()
  }

  async clone(opts: {
    repoFullName: string
    branch: string
    token: string
  }): Promise<WorkspaceHandle> {
    const factory = this.opts.sandboxFactory ?? defaultSandboxFactory
    const sandbox = await factory({
      ...resolveSandboxConnection(this.opts),
      // Git clone needs network access. The pool records this immutable
      // creation fact so an execution request for network=off is refused.
      allowInternetAccess: true,
    })
    try {
      // The sandbox starts with a writable working directory; we clone into
      // /tmp/cognia/<repo>/<stamp> so multiple clones in one sandbox lifetime
      // don't collide.
      // The stamp alone is not unique: Agent Team fans teammates out in
      // parallel, so two clones of the same repo can land in the same
      // millisecond and collide in the pool. The sandbox id is unique per
      // instance, which is exactly the identity the pool is keyed on.
      const stamp = `${this.opts.now().toString(36)}-${sandbox.id}`
      const safeRepo = opts.repoFullName.replace(/[^a-zA-Z0-9._-]/g, "_")
      const cwd = `/tmp/cognia/${safeRepo}/${stamp.replace(/[^a-zA-Z0-9._-]/g, "_")}`
      await execChecked(sandbox, { cmd: `mkdir -p ${shellEscape(cwd)}` })
      const remote = `https://x-access-token:${opts.token}@github.com/${opts.repoFullName}.git`
      // Partial, not shallow: a `--depth`-truncated history cannot be rebased
      // past its boundary, which is what a branch sitting on top of another
      // branch has to do whenever the one below it moves. `--filter=blob:none`
      // keeps the full commit graph and fetches file contents on demand.
      await execChecked(sandbox, {
        cmd: `git clone --branch ${shellEscape(opts.branch)} --single-branch --filter=blob:none ${shellEscape(remote)} ${shellEscape(cwd)}`,
      })
      this.pool.addWorkspace(cwd, sandbox, "on")
      return {
        backend: "e2b",
        path: cwd,
        repoFullName: opts.repoFullName,
        branch: opts.branch,
        createdAt: this.opts.now(),
      }
    } catch (err) {
      try {
        await sandbox.close()
      } catch (cleanupError) {
        throw new AggregateError(
          [err, cleanupError],
          "E2B workspace provisioning failed and the sandbox could not be closed."
        )
      }
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
    try {
      return await this.pool.removeWorkspace(handle.path)
    } catch {
      // The handle is being reaped: a sandbox that is already gone, or an API
      // call that times out, must not reject and abort the caller's sweep.
      // Drop the tracking entry so the pool cannot retain it forever.
      this.pool.forget(handle.path)
      return true
    }
  }

  /** Test utility — number of live sandboxes the backend is tracking. */
  liveSandboxCount(): number {
    return this.pool.liveSandboxCount()
  }

  private sandboxForHandle(handle: WorkspaceHandle): E2BSandboxFacade {
    return this.pool.forWorkspace(handle.path).sandbox
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

/**
 * Resolve the E2B SDK connection from live plugin configuration and explicit
 * construction options. The frontend plugin cannot read host process
 * environment variables; MCP subprocess environment is configured separately
 * by the preset in `index.ts`.
 */
export function resolveSandboxConnection(
  opts: Pick<E2BWorkspaceBackendOptions, "apiKey" | "apiUrl" | "domain" | "connection">
): E2BSandboxConnection {
  const dynamic = opts.connection?.() ?? {}
  const apiKey = firstNonEmpty(dynamic.apiKey, opts.apiKey)
  const domain = firstNonEmpty(dynamic.domain, opts.domain, opts.apiUrl)
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(domain ? { domain } : {}),
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

async function defaultSandboxFactory(opts: E2BSandboxConnection): Promise<E2BSandboxFacade> {
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
      "@e2b/sdk is not installed. Run `pnpm add @e2b/sdk -w`, then configure E2B Sandbox in Settings → Plugins."
    )
  }
  const SandboxCtor = mod?.Sandbox as
    { create?: (opts: unknown) => Promise<E2BSandboxFacade> } | undefined
  if (!SandboxCtor || typeof SandboxCtor.create !== "function") {
    throw new Error("@e2b/sdk does not export `Sandbox.create` — incompatible SDK version")
  }
  return SandboxCtor.create(opts)
}
