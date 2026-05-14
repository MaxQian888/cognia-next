/**
 * Git-repo WASM plugin installer.
 *
 * Drives the `plugin_wasm_install_from_git` Tauri command which (a) shallow-
 * clones the repo, (b) runs `cargo component build --release` when the
 * Cargo manifest declares a `[package.metadata.component]` block, and
 * (c) copies the produced `.wasm` + `plugin.json` into the canonical
 * plugins dir. Toolchain absence surfaces as a structured error the UI
 * renders alongside install-help text.
 */

import type { PluginManifest } from "@/types/plugin"
import { canUseTauriInvoke } from "@/lib/native/utils"

export interface GitInstallArgs {
  /** HTTPS / SSH URL of the repository. */
  repoUrl: string
  /** Optional branch / tag / commit-ish to check out. */
  branch?: string
}

export interface GitInstallResult {
  manifest: PluginManifest
  path: string
  authorPublicKey?: string
  authorFingerprint?: string
}

export class GitToolchainMissingError extends Error {
  readonly kind = "toolchain-missing"
  constructor(message: string) {
    super(message)
    this.name = "GitToolchainMissingError"
  }
}

let cachedInvoke: (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>) | undefined

async function getInvoke(): Promise<
  <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
> {
  if (cachedInvoke) return cachedInvoke
  const mod = await import("@tauri-apps/api/core")
  cachedInvoke = mod.invoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
  return cachedInvoke
}

const TOOLCHAIN_HINTS = [
  "is git installed",
  "cargo component build failed",
  "is cargo-component installed",
]

function classifyError(message: string): Error {
  if (TOOLCHAIN_HINTS.some((hint) => message.toLowerCase().includes(hint))) {
    return new GitToolchainMissingError(message)
  }
  return new Error(message)
}

/**
 * Install a WASM plugin by cloning a Git repository and building it
 * locally via `cargo-component`. Throws a `GitToolchainMissingError` when
 * either `git` or `cargo-component` is missing so the UI can render the
 * "install Rust + cargo-component" help bubble.
 */
export async function installFromGit(args: GitInstallArgs): Promise<GitInstallResult> {
  if (!canUseTauriInvoke()) {
    throw new Error(
      "Git plugin installs require the Tauri desktop runtime (clone + cargo build are filesystem-level)."
    )
  }
  if (!args.repoUrl.trim()) {
    throw new Error("repoUrl is empty")
  }
  const invoke = await getInvoke()
  try {
    const result = await invoke<GitInstallResult & { signatureVerified: boolean }>(
      "plugin_wasm_install_from_git",
      {
        repoUrl: args.repoUrl,
        branch: args.branch ?? null,
      }
    )
    return {
      manifest: result.manifest,
      path: result.path,
      authorPublicKey: result.authorPublicKey,
      authorFingerprint: result.authorFingerprint,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw classifyError(message)
  }
}
