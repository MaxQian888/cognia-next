/**
 * E2B-backed worktree backend for `runIssueLoop`. Implements the
 * `E2BBackend` interface defined in `./workspace.ts`. Each clone provisions
 * a fresh E2B Sandbox, performs `git clone` inside it, and stores the
 * `sandboxId` in the returned `WorkspaceHandle.path` so subsequent
 * `commitAndPush` calls can reconnect.
 *
 * The dependency on `@e2b/code-interpreter` is dynamic so consumers without
 * an E2B account can keep the local backend without bundling the SDK.
 *
 * The plugin's activate() registers an instance via `setE2BBackend(...)` —
 * see `plugins/github-delivery/src/index.ts`.
 */

import type { E2BBackend, WorkspaceHandle } from "./workspace"
import { Sandbox } from "@e2b/code-interpreter"

/** Sandbox-internal directory we always clone into. */
const SANDBOX_REPO_DIR = "/home/user/repo"

/** Minimal subset of the `@e2b/code-interpreter` Sandbox we depend on.
 *  Lets tests inject a fake without dragging the real SDK in. */
export interface E2BSandboxLike {
  sandboxId: string
  git: {
    clone(url: string, opts?: { path?: string; branch?: string }): Promise<unknown>
    add(path: string, opts?: { all?: boolean }): Promise<unknown>
    commit(path: string, message: string): Promise<unknown>
    push(
      path: string,
      opts?: { remote?: string; branch?: string; setUpstream?: boolean }
    ): Promise<unknown>
    setConfig(
      key: string,
      value: string,
      opts?: { scope?: string; path?: string }
    ): Promise<unknown>
  }
  commands: {
    run(
      cmd: string,
      opts?: { cwd?: string }
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>
  }
  kill(): Promise<void>
}

export interface E2BSandboxFactory {
  /** Create a new sandbox. Tests pass a fake; production resolves to `Sandbox.create()`. */
  create(opts: { apiKey: string; timeoutMs?: number }): Promise<E2BSandboxLike>
  /** Reconnect to an existing sandbox by id. Tests can no-op. */
  connect(sandboxId: string, opts: { apiKey: string }): Promise<E2BSandboxLike>
}

let _factory: E2BSandboxFactory | null = null

/** Inject a sandbox factory. Production wires the default once at startup. */
export function setE2BSandboxFactory(factory: E2BSandboxFactory | null): void {
  _factory = factory
}

/**
 * Resolve to the active factory. Throws when neither a test factory nor the
 * SDK is available — surfaces a clear "install / configure" hint.
 */
async function getFactory(): Promise<E2BSandboxFactory> {
  if (_factory) return _factory
  try {
    const sdk = Sandbox
    if (!sdk?.create) {
      throw new Error("E2B SDK shape changed; expected `Sandbox.create`")
    }
    return {
      create: (opts) => sdk.create(opts),
      connect: (sandboxId, opts) => sdk.connect(sandboxId, opts),
    }
  } catch (err) {
    throw new Error(
      `E2B SDK not available: ${
        err instanceof Error ? err.message : String(err)
      }. Install '@e2b/code-interpreter' and configure an API key.`
    )
  }
}

export interface CreateE2BBackendOptions {
  /** Resolve the per-call E2B API key. The caller usually pulls it from the OS keyring. */
  getApiKey: () => Promise<string | null>
  /** Sandbox boot timeout (ms). Default 5 minutes — generous for cold starts. */
  sandboxTimeoutMs?: number
  /** Override the sandbox factory (tests). */
  factoryOverride?: E2BSandboxFactory
}

/**
 * Build an E2BBackend. The returned object plugs straight into
 * `setE2BBackend(...)` from `./workspace.ts`.
 */
export function createE2BBackend(opts: CreateE2BBackendOptions): E2BBackend {
  if (opts.factoryOverride) setE2BSandboxFactory(opts.factoryOverride)
  const timeout = opts.sandboxTimeoutMs ?? 5 * 60_000

  return {
    async clone({ repoFullName, branch, token }) {
      const apiKey = await opts.getApiKey()
      if (!apiKey) {
        throw new Error("E2B API key is missing. Configure it in Settings → GitHub Delivery.")
      }
      const factory = await getFactory()
      const sandbox = await factory.create({ apiKey, timeoutMs: timeout })
      try {
        // We embed the short-lived token directly in the clone URL — same as
        // the local backend. The credential lives on the sandbox just long
        // enough for the clone; we never persist it to git config.
        const remote = `https://x-access-token:${token}@github.com/${repoFullName}.git`
        await sandbox.git.clone(remote, { path: SANDBOX_REPO_DIR, branch })
        // Configure user identity so future commits don't fail. Email is a
        // cognia-shaped placeholder — replace if the workflow author wants
        // attribution to a specific bot account.
        await sandbox.git.setConfig("user.name", "cognia-bot", {
          scope: "local",
          path: SANDBOX_REPO_DIR,
        })
        await sandbox.git.setConfig("user.email", "bot@cognia.local", {
          scope: "local",
          path: SANDBOX_REPO_DIR,
        })
        return {
          backend: "e2b",
          path: sandbox.sandboxId,
          repoFullName,
          branch,
          createdAt: Date.now(),
        } satisfies WorkspaceHandle
      } catch (err) {
        // Best-effort cleanup so a failed clone doesn't leave a billed sandbox.
        try {
          await sandbox.kill()
        } catch {
          // ignore — primary error wins
        }
        throw err
      }
    },

    async commitAndPush({ workspace, message, remoteBranch }) {
      const apiKey = await opts.getApiKey()
      if (!apiKey) throw new Error("E2B API key is missing.")
      const factory = await getFactory()
      const sandbox = await factory.connect(workspace.path, { apiKey })
      await sandbox.git.add(SANDBOX_REPO_DIR, { all: true })
      await sandbox.git.commit(SANDBOX_REPO_DIR, message)
      const branch = remoteBranch ?? workspace.branch
      await sandbox.git.push(SANDBOX_REPO_DIR, {
        remote: "origin",
        branch,
        setUpstream: true,
      })
      // Capture the SHA so the caller can paste it into the PR body.
      const out = await sandbox.commands.run("git rev-parse HEAD", { cwd: SANDBOX_REPO_DIR })
      return out.stdout.trim()
    },

    async remove(handle) {
      try {
        const apiKey = await opts.getApiKey()
        if (!apiKey) return false
        const factory = await getFactory()
        const sandbox = await factory.connect(handle.path, { apiKey })
        await sandbox.kill()
        return true
      } catch {
        // GC is best-effort; the user can clean up dangling sandboxes from
        // the E2B console.
        return false
      }
    },
  }
}
