/**
 * Desktop → CLI credentials push (WS2).
 *
 * Projects the desktop's configured provider secrets into the cognia CLI's
 * `~/.cognia/credentials.json` (shape `{ providers: { [id]: { apiKey?,
 * authToken? } } }`, written 0600) so the standalone `cognia-agent` CLI runs
 * with the same portable auth. Provider API keys come straight from
 * `AppSettings.providerSettings`; the Anthropic subscription bearer and Codex
 * API-key credential are read from their active vault accounts. ChatGPT-login
 * Codex credentials remain desktop-only because the CLI file cannot represent
 * their account headers and refresh lifecycle.
 *
 * The CredentialsFile shape is intentionally re-declared here (not imported
 * from `cli/`) so the app bundle never depends on the standalone CLI package.
 * It mirrors `cli/src/config/schema.ts:credentialsFileSchema`.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { isTauri } from "@/lib/tauri"
import { getAccount, getActiveAccount } from "@/lib/subscription/core/transport"
import {
  resolveCodexVaultCredential,
  type CodexVaultCredential,
} from "@/lib/subscription/codex/chat-bridge"

import { writeCliHomeFile } from "./home"

export const CREDENTIALS_FILE_NAME = "credentials.json"

export interface CliProviderSecret {
  apiKey?: string
  authToken?: string
}

export interface CliCredentialsFile {
  providers: Record<string, CliProviderSecret>
}

/**
 * Pure: assemble a `credentials.json` body from gathered secrets, trimming
 * blanks and dropping any provider left without a usable secret. Returns
 * `null` when there is nothing worth writing.
 */
export function buildCredentialsFile(
  providers: Record<string, CliProviderSecret>
): CliCredentialsFile | null {
  const out: Record<string, CliProviderSecret> = {}
  for (const [id, secret] of Object.entries(providers)) {
    const entry: CliProviderSecret = {}
    const apiKey = secret.apiKey?.trim()
    const authToken = secret.authToken?.trim()
    if (apiKey) entry.apiKey = apiKey
    if (authToken) entry.authToken = authToken
    if (entry.apiKey || entry.authToken) out[id] = entry
  }
  return Object.keys(out).length > 0 ? { providers: out } : null
}

export interface GatherCredentialsDeps {
  /** Read the active Anthropic subscription bearer (→ `authToken`), or null. */
  readAnthropicAuthToken?: () => Promise<string | null>
  /** Read the active Codex vault credential; ChatGPT-login mode is not portable. */
  readCodexVaultCredential?: () => Promise<CodexVaultCredential | null>
}

/**
 * Collect provider secrets from `AppSettings.providerSettings` (each provider's
 * stored `apiKey`) plus the active Anthropic subscription bearer and a portable
 * Codex API-key vault credential when connected.
 */
export async function gatherCredentials(
  settings: Pick<AppSettings, "providerSettings">,
  deps: GatherCredentialsDeps = {}
): Promise<Record<string, CliProviderSecret>> {
  const out: Record<string, CliProviderSecret> = {}
  const providerSettings = settings.providerSettings ?? {}
  for (const [id, ps] of Object.entries(providerSettings)) {
    const apiKey = ps?.apiKey?.trim()
    if (apiKey) out[id] = { ...(out[id] ?? {}), apiKey }
  }
  const readToken = deps.readAnthropicAuthToken ?? defaultReadAnthropicAuthToken
  const authToken = await readToken()
  if (authToken) out.anthropic = { ...(out.anthropic ?? {}), authToken }

  if (!out.codex?.apiKey) {
    const readCodexCredential =
      deps.readCodexVaultCredential ?? (() => resolveCodexVaultCredential("codex"))
    const credential = await readCodexCredential()
    // ChatGPT-login credentials require account-scoped headers and refresh
    // semantics that credentials.json cannot represent. Only the portable
    // standard API-key mode (identified by the absence of those headers) is
    // projected into the standalone CLI.
    const codexApiKey = credential && !credential.headers ? credential.apiKey.trim() : ""
    if (codexApiKey) out.codex = { apiKey: codexApiKey }
  }
  return out
}

/** Default Anthropic-bearer reader: the active subscription account's token. */
async function defaultReadAnthropicAuthToken(): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const snap = await getActiveAccount("anthropic")
    const id = snap.activeAccountId
    if (!id) return null
    const account = await getAccount("anthropic", id)
    const cred = account?.credential as { accessToken?: unknown } | undefined
    return cred && typeof cred.accessToken === "string" && cred.accessToken
      ? cred.accessToken
      : null
  } catch {
    return null
  }
}

export interface PushCredentialsDeps extends GatherCredentialsDeps {
  write?: (fileName: string, content: string, secret: boolean) => Promise<void>
}

/**
 * Write `credentials.json` (0600) to the CLI home. Returns the number of
 * providers written, or 0 when there were no secrets to push.
 */
export async function pushCredentialsToCli(
  settings: Pick<AppSettings, "providerSettings">,
  deps: PushCredentialsDeps = {}
): Promise<number> {
  const secrets = await gatherCredentials(settings, deps)
  const file = buildCredentialsFile(secrets)
  if (!file) return 0
  const write = deps.write ?? writeCliHomeFile
  await write(CREDENTIALS_FILE_NAME, JSON.stringify(file, null, 2) + "\n", true)
  return Object.keys(file.providers).length
}
