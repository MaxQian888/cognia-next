/**
 * Fallback Codex configuration for `cognia-agent x codex`.
 *
 * The launcher normally points Codex at the gateway with `-c` overrides on
 * the command line (`model_provider=cognia`, `model_providers.cognia.*`). If
 * an installed Codex refuses dotted `-c` keys, this writes a temporary
 * `CODEX_HOME` with an equivalent `config.toml` and links the user's own
 * `auth.json` and `prompts/` into it, so their login and prompts survive.
 * The user's real `~/.codex/config.toml` is never touched.
 *
 * Opt-in through `--codex-home-fallback` (or `COGNIA_X_CODEX_HOME_FALLBACK=1`).
 * It is a fallback and therefore dormant by default: the type below says so,
 * the CLI help says so, and `codex-config.test.ts` pins that nothing is
 * written unless the flag is on.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const CODEX_HOME_FALLBACK_ENV = "COGNIA_X_CODEX_HOME_FALLBACK"

/** `wire_api = "chat"` on purpose: see `agent-launcher.ts` for why not `responses`. */
export function renderCodexConfigToml(gatewayBaseUrl: string, model?: string): string {
  const base = `${gatewayBaseUrl.replace(/\/$/, "")}/v1`
  const lines = [
    "# Written by cognia-agent x codex for ONE launch. Not your ~/.codex/config.toml.",
    'model_provider = "cognia"',
    ...(model ? [`model = ${JSON.stringify(model)}`] : []),
    "",
    "[model_providers.cognia]",
    'name = "Cognia gateway"',
    `base_url = ${JSON.stringify(base)}`,
    'env_key = "COGNIA_GATEWAY_KEY"',
    'wire_api = "chat"',
    "",
  ]
  return lines.join("\n")
}

export interface TemporaryCodexHome {
  dir: string
  /** Removes the temporary home. Idempotent. */
  cleanup: () => void
}

export interface TemporaryCodexHomeDeps {
  /** The user's real Codex home. Default `$CODEX_HOME` or `~/.codex`. */
  userCodexHome?: string
  mkdtemp?: (prefix: string) => string
  fs?: Pick<typeof fs, "existsSync" | "writeFileSync" | "symlinkSync" | "rmSync" | "mkdirSync">
}

/**
 * Create the temporary home. Links (never copies) `auth.json` and `prompts/`
 * from the user's home when they exist.
 */
export function writeTemporaryCodexHome(
  input: { gatewayBaseUrl: string; model?: string },
  deps: TemporaryCodexHomeDeps = {}
): TemporaryCodexHome {
  const fsImpl = deps.fs ?? fs
  const mkdtemp =
    deps.mkdtemp ?? ((prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const userHome = deps.userCodexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
  const dir = mkdtemp("cognia-x-codex-")
  fsImpl.mkdirSync(dir, { recursive: true })
  fsImpl.writeFileSync(
    path.join(dir, "config.toml"),
    renderCodexConfigToml(input.gatewayBaseUrl, input.model)
  )
  for (const entry of ["auth.json", "prompts"]) {
    const source = path.join(userHome, entry)
    if (fsImpl.existsSync(source)) {
      fsImpl.symlinkSync(source, path.join(dir, entry))
    }
  }
  let cleaned = false
  return {
    dir,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      fsImpl.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Whether the fallback was requested, by flag or by environment. */
export function codexHomeFallbackRequested(
  flag: boolean | undefined,
  env: Record<string, string | undefined> = process.env
): boolean {
  return flag === true || env[CODEX_HOME_FALLBACK_ENV] === "1"
}
