/**
 * Wiki rebuild runner — wires the orchestrator to the Tauri host.
 *
 * Creates a `FileSystem` adapter backed by `@tauri-apps/plugin-fs` and an
 * `LlmClient` from the user's configured provider. Only available in Tauri
 * desktop mode; web callers get a clear error.
 */

import { isTauri } from "@/lib/tauri"
import { getSettings } from "@/lib/db/settings"
import type { LlmClient, LlmConfig } from "@/lib/twin/distill/llm"
import {
  rebuildWiki,
  type FileSystem,
  type RebuildOptions,
  type RebuildResult,
} from "./orchestrator"

/** Thrown when called outside Tauri — the wiki rebuild needs real filesystem access. */
export class WebModeError extends Error {
  constructor() {
    super(
      "Wiki rebuild requires the Tauri desktop app. File system access is not available in web mode."
    )
    this.name = "WebModeError"
  }
}

/** Thrown when no LLM API key is configured. */
export class NoApiKeyError extends Error {
  constructor() {
    super(
      "No LLM API key configured. Add an API key in Settings → Providers before rebuilding the wiki."
    )
    this.name = "NoApiKeyError"
  }
}

async function buildTauriFileSystem(rootDir: string): Promise<FileSystem> {
  const { readDir, readTextFile } = await import("@tauri-apps/plugin-fs")

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

  const { createLlmClient } = await import("@/lib/twin/distill/llm")
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
  if (!isTauri()) throw new WebModeError()

  const scope = opts.scope ?? "cognia-self"
  const rootDir = opts.rootDir ?? "."

  const fs = await buildTauriFileSystem(rootDir)
  const llm = await buildLlmClient()

  const rebuildOpts: RebuildOptions = {
    scope,
    rootDir,
    generatorVersion: "1.0.0",
    force: opts.force,
  }

  return rebuildWiki({ fs, llm }, rebuildOpts)
}
