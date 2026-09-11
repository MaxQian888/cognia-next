import { isTauri } from "@/lib/tauri"
import { COMMANDCODE_DEFAULT_BASE_URL } from "@/types/subscription/commandcode"
import {
  getAccount,
  getActiveAccount,
  getProviderPreset,
  listPresets,
} from "@/lib/subscription/core/transport"

/** Resolve the explicitly selected/default CommandCode account without changing the active account. */
export async function resolveCommandcodeVaultCredential(
  providerId: string,
  selectedAccountId?: string | null
): Promise<{ apiKey: string; baseURL: string; headers?: Record<string, string> } | null> {
  if (providerId !== "commandcode" || !isTauri()) return null
  try {
    const accountId = selectedAccountId || (await getActiveAccount("commandcode")).activeAccountId
    if (!accountId) return null
    const account = await getAccount("commandcode", accountId)
    if (account?.credential.provider !== "commandcode") return null
    const apiKey = account.credential.accessToken.trim()
    if (!apiKey) return null
    const bound = account.presetId
      ? (await listPresets("commandcode")).find((preset) => preset.id === account.presetId)
      : null
    const preset = bound ?? (await getProviderPreset("commandcode"))
    const headers = Object.fromEntries(
      Object.entries(preset?.extraHeaders ?? {}).filter(
        ([name]) => !name.toLowerCase().startsWith("x-cognia-")
      )
    )
    return {
      apiKey,
      baseURL:
        preset?.baseUrl?.trim() ||
        account.credential.baseUrl?.trim() ||
        COMMANDCODE_DEFAULT_BASE_URL,
      ...(Object.keys(headers).length ? { headers } : {}),
    }
  } catch {
    return null
  }
}
