/**
 * Standalone CLI configuration schema.
 *
 * The CLI is desktop-independent: it never reads the desktop's IndexedDB or OS
 * keyring. All runtime config comes from layered JSON files + env + flags, which
 * resolve into a {@link ResolvedConfig} and from there into the SAME
 * `BuildOptionsContext` the desktop feeds to `resolveSendOptions` — so the agent
 * behaves identically. See `cli/src/config/to-build-context.ts`.
 *
 * Two files back the config, both under the CLI home (`~/.cognia/` by default):
 *   - `config.json`      — non-secret settings, safe to commit/share
 *   - `credentials.json` — provider API keys only, written with 0600 perms
 *
 * A project-local `./.cognia/config.json` overlays the user file, and env vars
 * + CLI flags overlay on top of that. Credentials overlay api keys last so a
 * shared `config.json` never has to carry a secret.
 */

import { z } from "zod"
import { DEFAULT_BUILTIN_TOOLS, type BuiltinToolsConfig } from "@/lib/claude/types"

/** AI SDK protocol families the sidecar's dispatch table understands. */
export const RESOLVER_PROTOCOLS = ["openai", "anthropic", "google", "mistral", "cohere"] as const

/** SDK permission modes, mirrored from `SendOptions["permissionMode"]`. */
export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const

export const builtinToolsSchema: z.ZodType<Partial<BuiltinToolsConfig>> = z
  .object({
    fileExtras: z.boolean().optional(),
    coreFiles: z.boolean().optional(),
    coreFilesOnAnthropic: z.boolean().optional(),
    git: z.boolean().optional(),
    process: z.boolean().optional(),
    environment: z.boolean().optional(),
    shellAdvanced: z.boolean().optional(),
    terminalRepl: z.boolean().optional(),
    lsp: z.boolean().optional(),
  })
  .strict()

export const providerConfigSchema = z
  .object({
    /** Secret. Normally lives in credentials.json, but accepted here too. */
    apiKey: z.string().min(1).optional(),
    /**
     * Subscription / OAuth token (secret). For Anthropic this is the Claude
     * Pro/Max `CLAUDE_CODE_OAUTH_TOKEN` — `to-build-context` forwards it to the
     * native agent SDK so the CLI authenticates with a subscription instead of
     * a metered API key. Normally lives in credentials.json.
     */
    authToken: z.string().min(1).optional(),
    /** Self-hosted / proxy base URL. */
    baseURL: z.string().url().optional(),
    /**
     * AI SDK family for custom/unknown provider ids. Built-in ids
     * (anthropic/openai/google/…) derive their protocol in the sidecar, so
     * this is only required for self-hosted providers.
     */
    protocol: z.enum(RESOLVER_PROTOCOLS).optional(),
    /** Per-provider default model id. */
    model: z.string().min(1).optional(),
  })
  .strict()

export type ProviderConfig = z.infer<typeof providerConfigSchema>

/**
 * The `config.json` shape. Every field is optional — an empty file is valid and
 * resolves entirely from defaults + env + flags.
 */
export const cliConfigFileSchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    systemPrompt: z.string().optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    builtinTools: builtinToolsSchema.optional(),
    providers: z.record(z.string(), providerConfigSchema).optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict()

export type CliConfigFile = z.infer<typeof cliConfigFileSchema>

/** The `credentials.json` shape — api keys / subscription tokens by provider id. */
export const credentialsFileSchema = z
  .object({
    providers: z
      .record(
        z.string(),
        z
          .object({
            apiKey: z.string().min(1).optional(),
            authToken: z.string().min(1).optional(),
          })
          .strict()
          // At least one secret must be present for an entry to be meaningful.
          .refine((v) => Boolean(v.apiKey || v.authToken), {
            message: "provider credential needs an apiKey or authToken",
          })
      )
      .optional(),
  })
  .strict()

export type CredentialsFile = z.infer<typeof credentialsFileSchema>

/**
 * Fully-resolved, defaults-applied config. This is what the rest of the CLI
 * consumes — `provider`, `permissionMode`, `builtinTools`, `cwd`, and
 * `providers` are always present; `model`/`systemPrompt`/`allowedTools` stay
 * optional because the agent has sensible fallbacks for each.
 */
export interface ResolvedConfig {
  provider: string
  model?: string
  systemPrompt?: string
  permissionMode: (typeof PERMISSION_MODES)[number]
  allowedTools?: string[]
  builtinTools: BuiltinToolsConfig
  providers: Record<string, ProviderConfig>
  cwd: string
}

/** Provider id assumed when neither config, env, nor flag names one. */
export const DEFAULT_PROVIDER = "anthropic"

/**
 * Baseline config before any file/env/flag is applied. `cwd` is intentionally
 * empty here and filled with `process.cwd()` by the loader so this constant
 * stays pure (no environment reads at module load).
 */
export const DEFAULT_RESOLVED_CONFIG: Omit<ResolvedConfig, "cwd"> = {
  provider: DEFAULT_PROVIDER,
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: {},
}
