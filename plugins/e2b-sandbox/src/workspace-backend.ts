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
 *   • Keeps `e2b` (the E2B JS SDK) out of the plugin's static graph — its dist
 *     statically imports node builtins (`node:fs`, `undici`, `tar`,
 *     `dockerfile-ast`), so a bundler-analyzable import would break the
 *     webview build outright.
 *   • Lets us swap the SDK factory in tests without monkey-patching modules.
 *
 * Why dynamic import — and why this path is DORMANT today:
 *   • `Function("s","return import(s)")` keeps the specifier opaque to
 *     webpack/Turbopack so the app bundle builds without the package. The same
 *     indirection means a bare specifier can never resolve inside the shipped
 *     webview either, so `defaultSandboxFactory` can only succeed where a
 *     Node-style module resolution exists (unit tests with the dep installed,
 *     or a future host-side bridge that loads the SDK in Node). Until that
 *     bridge ships, the factory throws a single honest error naming the
 *     dormant state — see `sdkUnavailableError()`.
 */

import type { E2BBackend, WorkspaceHandle } from "@cognia/plugin-sdk/api/sandbox"
import { E2BSandboxPool } from "./sandbox-pool"

/** Narrow shape of the `e2b` package we depend on. Real SDK exports `Sandbox`. */
export interface E2BSandboxFacade {
  id: string
  /** Run a shell command inside the sandbox, returning combined stdout/stderr. */
  exec(opts: {
    cmd: string
    cwd?: string
    timeoutMs?: number
    /**
     * Environment for this one command (ADR-0176).
     *
     * The GitHub credential travels here and nowhere else. A token on the
     * command line is readable by any process that can list processes inside
     * the microVM, which includes everything the agent runs, and it is echoed
     * back verbatim in git's own error messages. A facade that silently drops
     * this field would put the token back on argv, so the backend probes for
     * support and refuses rather than falling back.
     */
    envs?: Record<string, string>
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
  /** Native `e2b` SDK domain override. Takes precedence over apiUrl. */
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
      // Before anything is cloned: a facade that drops `envs` cannot be given
      // the credential safely, and the answer is to refuse, never to fall back
      // to a token on the command line.
      await assertSandboxCarriesEnv(sandbox)
      await execChecked(sandbox, { cmd: `mkdir -p ${shellEscape(cwd)}` })
      // Credential-FREE remote (ADR-0176). `git clone` writes whatever URL it
      // is given verbatim into `<workspace>/.git/config` and leaves it there,
      // and this workspace is then handed to an agent with shell tools. A
      // token in the URL would be readable with a plain `cat .git/config` by
      // anything that agent runs, including instructions injected through an
      // issue body. The credential is supplied per-invocation instead.
      const remote = `https://github.com/${opts.repoFullName}.git`
      // Partial, not shallow: a `--depth`-truncated history cannot be rebased
      // past its boundary, which is what a branch sitting on top of another
      // branch has to do whenever the one below it moves. `--filter=blob:none`
      // keeps the full commit graph and fetches file contents on demand.
      await execChecked(sandbox, {
        cmd: `git clone --branch ${shellEscape(opts.branch)} --single-branch --filter=blob:none ${shellEscape(remote)} ${shellEscape(cwd)}`,
        envs: gitCredentialEnv(remote, opts.token),
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
    token?: string
  }): Promise<string> {
    const sandbox = this.sandboxForHandle(opts.workspace)
    const branch = opts.remoteBranch ?? opts.workspace.branch
    // `origin` is credential-free since the clone, so the push has no way to
    // authenticate without a token. Refusing here names the cause. Letting git
    // run would fail with `could not read Username`, which reads like a broken
    // sandbox rather than a missing credential.
    if (!opts.token) {
      throw new Error(
        "E2B workspace push requires a GitHub token: the clone stores a credential-free remote, " +
          "so the credential is supplied per push. Pass `token` to commitAndPush."
      )
    }
    await assertSandboxCarriesEnv(sandbox)
    const remote = `https://github.com/${opts.workspace.repoFullName}.git`
    await execChecked(sandbox, {
      cmd: `git add . && git commit -m ${shellEscape(opts.message)} && git push origin ${shellEscape(branch)} --set-upstream`,
      cwd: opts.workspace.path,
      envs: gitCredentialEnv(remote, opts.token),
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
      // Keep the released entry in the pool's cleanup ledger so a later
      // owner release, handle removal, or shutdown disposal can retry it.
      return false
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

/**
 * The credential, as environment (ADR-0176).
 *
 * `GIT_CONFIG_COUNT` / `_KEY_n` / `_VALUE_n` is git's env-based config
 * override. It is the same policy the desktop host uses
 * (`cognia_git_mirror::credential::auth_env`), and it is additive: it does not
 * disable the sandbox's own git configuration, so the commit identity the
 * image ships with still applies.
 *
 * The header is keyed on the remote's origin rather than on `http.extraheader`
 * globally, so a redirect to another host is not handed the token.
 */
export function gitCredentialEnv(remote: string, token: string): Record<string, string> {
  const origin = originOf(remote)
  if (!origin) {
    throw new Error(`Refusing to send a credential to a remote with no https origin: ${remote}`)
  }
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basicAuth(token)}`,
    // Fail fast instead of blocking forever on a prompt no one can answer.
    GIT_TERMINAL_PROMPT: "0",
  }
}

/** `https://github.com/o/r.git` -> `https://github.com/`. `undefined` if not https. */
function originOf(remote: string): string | undefined {
  try {
    const url = new URL(remote)
    if (url.protocol !== "https:") return undefined
    return `${url.origin}/`
  } catch {
    return undefined
  }
}

function basicAuth(token: string): string {
  const raw = `x-access-token:${token}`
  // Tokens are ASCII, so `btoa` is exact here. It is also the only base64 that
  // exists in both of this plugin's runtimes (renderer and the jsdom tests).
  return btoa(raw)
}

const ENV_PROBE_VAR = "COGNIA_GIT_ENV_PROBE"

/** Facades already proven to carry `envs`, so the probe runs once per sandbox. */
const sandboxesWithVerifiedEnv = new WeakSet<E2BSandboxFacade>()

/**
 * Prove the facade actually passes `envs` through to the command.
 *
 * `exec` is a plain function, so a facade that ignores the field fails
 * silently: the clone would run with no credential and, worse, an
 * implementation that "helpfully" fell back would put the token on argv. There
 * is no type that can tell us, so we ask the sandbox.
 *
 * One extra command per sandbox, which is nothing next to a clone.
 */
export async function assertSandboxCarriesEnv(sandbox: E2BSandboxFacade): Promise<void> {
  if (sandboxesWithVerifiedEnv.has(sandbox)) return
  const nonce = `probe-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
  const result = await sandbox.exec({
    cmd: `printf %s "$${ENV_PROBE_VAR}"`,
    envs: { [ENV_PROBE_VAR]: nonce },
  })
  if (result.exitCode !== 0 || result.stdout.trim() !== nonce) {
    throw new Error(
      "This E2B sandbox facade does not forward per-command environment variables, " +
        "so a GitHub credential cannot be delivered to it safely. Refusing to clone: " +
        "the alternative is a token on the command line, readable by everything the agent runs. " +
        "Upgrade e2b, or supply a sandboxFactory whose exec() honours `envs`."
    )
  }
  sandboxesWithVerifiedEnv.add(sandbox)
}

async function execChecked(
  sandbox: E2BSandboxFacade,
  opts: { cmd: string; cwd?: string; timeoutMs?: number; envs?: Record<string, string> }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await sandbox.exec(opts)
  if (result.exitCode !== 0) {
    // `opts.cmd` is safe to echo: the credential lives in `opts.envs`, which is
    // deliberately not interpolated here. git still repeats the remote URL in
    // its own stderr, which is why that URL is credential-free to begin with.
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
  // Dynamic import keeps `e2b` an optional dep. When it's missing — which in
  // the shipped webview is always, since no bundler ever resolved it — we
  // surface a single honest dormant-state error; the rest of the platform
  // stays usable. The real SDK is async-construct (`Sandbox.create({
  // apiKey, domain, allowInternetAccess })`), not a bare `new Sandbox(...)`.
  let mod: { Sandbox?: unknown } | undefined
  try {
    // `e2b` is the SDK's real npm name (`@e2b/sdk` does not exist). The
    // Function-wrapped specifier keeps webpack/Turbopack from resolving it at
    // build time — the package's `node:fs`/`undici` imports would break the
    // static export if they were ever pulled in.
    mod = (await (Function("s", "return import(s)") as (s: string) => Promise<unknown>)("e2b")) as {
      Sandbox?: unknown
    }
  } catch {
    throw sdkUnavailableError()
  }
  const SandboxCtor = mod?.Sandbox as
    { create?: (opts: unknown) => Promise<E2BSdkSandbox> } | undefined
  if (!SandboxCtor || typeof SandboxCtor.create !== "function") {
    throw new Error("e2b does not export `Sandbox.create` — incompatible SDK version")
  }
  return adaptSdkSandbox(await SandboxCtor.create(opts))
}

/**
 * Why this is honest instead of an install hint: `pnpm add e2b` cannot make a
 * bare-specifier `import()` resolvable inside the bundled webview, and the
 * SDK's own Node imports make it unbundlable there anyway. Wiring `e2b`
 * through a Node-side host (e.g. a Tauri sidecar bridge) is the tracked
 * follow-up; the MCP preset (`@e2b/mcp-server` via npx) is unaffected because
 * it runs in a spawned process, not in this bundle.
 */
function sdkUnavailableError(): Error {
  return new Error(
    "E2B sandbox provisioning is unavailable in this build: the `e2b` SDK is not " +
      "bundled (webview bundles cannot resolve unbundled npm packages). The MCP " +
      "preset still works — it spawns @e2b/mcp-server via npx in its own process."
  )
}

/** The part of the real `e2b` Sandbox this adapter drives. */
interface E2BSdkSandbox {
  sandboxId?: string
  id?: string
  commands: {
    run(
      cmd: string,
      opts?: { cwd?: string; timeoutMs?: number; envs?: Record<string, string> }
    ): Promise<{ stdout?: string; stderr?: string; exitCode?: number }>
  }
  kill?(): Promise<unknown>
  close?(): Promise<unknown>
}

/**
 * Adapt the SDK's `commands.run(cmd, { envs })` to our facade (ADR-0176).
 *
 * The default factory used to hand the raw SDK object back cast as an
 * `E2BSandboxFacade`, which has no `exec` at all. Writing the adapter is what
 * makes `envs` reach a real sandbox rather than a mock, and the probe in
 * `assertSandboxCarriesEnv` is what proves it did.
 *
 * `commands.run` rejects on a non-zero exit in some SDK versions and resolves
 * with the code in others, so both shapes are normalised to a resolved result:
 * `execChecked` is the one place that decides a non-zero exit is an error.
 */
export function adaptSdkSandbox(sandbox: E2BSdkSandbox): E2BSandboxFacade {
  if (!sandbox?.commands || typeof sandbox.commands.run !== "function") {
    throw new Error("e2b Sandbox has no `commands.run` — incompatible SDK version")
  }
  return {
    id: sandbox.sandboxId ?? sandbox.id ?? "e2b-sandbox",
    async exec({ cmd, cwd, timeoutMs, envs }) {
      try {
        const result = await sandbox.commands.run(cmd, {
          ...(cwd ? { cwd } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
          ...(envs ? { envs } : {}),
        })
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ?? 0,
        }
      } catch (error) {
        const failure = error as {
          exitCode?: number
          stdout?: string
          stderr?: string
          message?: string
        }
        if (typeof failure?.exitCode === "number") {
          return {
            stdout: failure.stdout ?? "",
            stderr: failure.stderr ?? failure.message ?? "",
            exitCode: failure.exitCode,
          }
        }
        throw error
      }
    },
    async close() {
      // `kill` is the current name; older builds called it `close`.
      if (typeof sandbox.kill === "function") {
        await sandbox.kill()
        return
      }
      if (typeof sandbox.close === "function") {
        await sandbox.close()
        return
      }
      throw new Error("e2b Sandbox has neither `kill` nor `close`")
    },
  }
}
