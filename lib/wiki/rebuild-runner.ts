/**
 * Wiki rebuild runner — wires the orchestrator to the host filesystem.
 *
 * Creates a `FileSystem` adapter and an `LlmClient` from the user's configured
 * provider. Two filesystem adapters share one contract:
 *
 *   - Tauri desktop → `@tauri-apps/plugin-fs` (renderer-local, unchanged);
 *   - any other host with filesystem access (the headless brain) → the
 *     host-neutral `fs_*_workspace` transport arms (`lib/files/workspace-fs`),
 *     which cognia-server implements natively and gates on its workspace-root
 *     policy, so `rootDir` must be an absolute path the host allows.
 *
 * Hosts without filesystem access (a plain browser, the mobile webview) get a
 * clear `HostFilesystemError`.
 */

import { readDir, readTextFile } from "@tauri-apps/plugin-fs"
import { detectPlatform, isTauri } from "@/lib/platform/detect"
import { getSettings } from "@/lib/db/settings"
import { createLlmClient, type LlmClient, type LlmConfig } from "@/lib/twin/distill/llm"
import {
  rebuildWiki,
  type FileSystem,
  type RebuildOptions,
  type RebuildResult,
} from "./orchestrator"

/** Thrown on hosts without filesystem access — the wiki rebuild needs to walk real files. */
export class HostFilesystemError extends Error {
  constructor() {
    super(
      "Wiki rebuild requires a host with filesystem access (the desktop app or a cloud host). It is not available in a plain browser."
    )
    this.name = "HostFilesystemError"
  }
}

/** @deprecated Renamed to {@link HostFilesystemError}; kept for existing callers. */
export const WebModeError = HostFilesystemError

/** Thrown when no LLM API key is configured. */
export class NoApiKeyError extends Error {
  constructor() {
    super(
      "No LLM API key configured. Add an API key in Settings → Providers before rebuilding the wiki."
    )
    this.name = "NoApiKeyError"
  }
}

/** Platforms whose process can reach its own filesystem (directly or via the host RPC arms). */
const HOST_FILESYSTEM_PLATFORMS = new Set(["tauri", "headless"])

/** True when this host can run a wiki rebuild at all. */
export function canRunWikiRebuildOnHost(): boolean {
  return HOST_FILESYSTEM_PLATFORMS.has(detectPlatform())
}

/**
 * Host-neutral filesystem over the `fs_*_workspace` transport arms. Walks the
 * tree lazily through `listWorkspaceDir` (non-recursive per call) and reads
 * files relative to `rootDir`. Used off-desktop.
 */
async function buildTransportFileSystem(rootDir: string): Promise<FileSystem> {
  const { listWorkspaceDir, readWorkspaceFile } = await import("@/lib/files/workspace-fs")

  async function walk(relDir: string | undefined): Promise<string[]> {
    const entries = await listWorkspaceDir(rootDir, relDir, false)
    const results: string[] = []
    for (const entry of entries) {
      if (entry.isDir) {
        results.push(...(await walk(entry.relPath)))
      } else {
        results.push(entry.relPath)
      }
    }
    return results
  }

  const relativePaths = await walk(undefined)
  return {
    walk: async () => relativePaths,
    readFile: async (relPath: string) => readWorkspaceFile(rootDir, relPath),
  }
}

async function buildTauriFileSystem(rootDir: string): Promise<FileSystem> {
  async function walk(dir: string): Promise<string[]> {
    const entries = await readDir(dir)
    const results: string[] = []
    for (const entry of entries) {
      const fullPath = `${dir}/${entry.name}`
      if (entry.isDirectory) {
        const children = await walk(fullPath)
        results.push(...children)
      } else {
        results.push(fullPath)
      }
    }
    return results
  }

  const allPaths = await walk(rootDir)
  const relativePaths = allPaths.map((p) => {
    const prefix = rootDir.endsWith("/") ? rootDir : rootDir + "/"
    return p.startsWith(prefix) ? p.slice(prefix.length) : p
  })

  return {
    walk: async () => relativePaths,
    readFile: async (relPath: string) => readTextFile(`${rootDir}/${relPath}`),
  }
}

async function buildLlmClient(): Promise<LlmClient> {
  const row = await getSettings()
  const apiKey = row.apiKey
  if (!apiKey) throw new NoApiKeyError()

  // Detect provider from the active provider ID. Default to anthropic when
  // the key looks like an Anthropic key, openai otherwise.
  let provider: LlmConfig["provider"] = "anthropic"
  if (row.activeProviderId) {
    if (row.activeProviderId.includes("openai")) provider = "openai"
    else if (row.activeProviderId.includes("google")) provider = "google"
    else if (row.activeProviderId.includes("mistral")) provider = "mistral"
    else if (row.activeProviderId.includes("cohere")) provider = "cohere"
  } else if (apiKey.startsWith("sk-ant")) {
    provider = "anthropic"
  } else if (apiKey.startsWith("sk-")) {
    provider = "openai"
  }

  const model =
    provider === "anthropic"
      ? "claude-sonnet-4-6"
      : provider === "openai"
        ? "gpt-4o"
        : provider === "google"
          ? "gemini-2.5-pro"
          : provider === "mistral"
            ? "mistral-large"
            : "command-r-plus"

  const config: LlmConfig = {
    provider,
    model,
    apiKey,
    baseURL: row.apiBaseUrl,
  }
  return createLlmClient(config)
}

export interface RunRebuildOptions {
  scope?: "cognia-self"
  rootDir?: string
  force?: boolean
}

export async function runWikiRebuild(opts: RunRebuildOptions = {}): Promise<RebuildResult> {
  if (!canRunWikiRebuildOnHost()) throw new HostFilesystemError()

  const scope = opts.scope ?? "cognia-self"
  const rootDir = opts.rootDir ?? "."

  const fs = isTauri()
    ? await buildTauriFileSystem(rootDir)
    : await buildTransportFileSystem(rootDir)
  const llm = await buildLlmClient()

  const rebuildOpts: RebuildOptions = {
    scope,
    rootDir,
    generatorVersion: "1.0.0",
    force: opts.force,
  }

  return rebuildWiki({ fs, llm }, rebuildOpts)
}
