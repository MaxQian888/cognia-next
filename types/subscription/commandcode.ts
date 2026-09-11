import type { CommandCodeCredentialData, ProviderCredential } from "./credential"

/** Official OpenAI-compatible gateway; the API key is managed in the vault. */
export const COMMANDCODE_DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1"

export function toCommandCodeProviderCredential(
  credential: CommandCodeCredentialData
): ProviderCredential {
  return { provider: "commandcode", ...credential }
}
