export const BUILTIN_PROTOCOL_NAMES: readonly string[]
export function isBuiltInProtocol(protocol: string): boolean
export function normalizeProtocol(protocol: string): string
export const PROVIDER_PROTOCOL: Readonly<Record<string, string>>
export function resolveProviderProtocol(providerId: string): string
export const RESPONSES_ONLY_PROVIDERS: ReadonlySet<string>
export const OPENAI_HOST_PROVIDERS: ReadonlySet<string>
export function isMisroutedToOpenAi(providerId: string, baseURL?: string): boolean
export function isGenuineOpenAiEndpoint(baseURL?: string): boolean
export function isResponsesOnlyEndpoint(baseURL?: string): boolean
export function isOpenAiNativeSurface(input?: {
  providerId?: string
  baseURL?: string
}): boolean
export function decideOpenAiEndpointFlavor(input?: {
  apiFlavor?: string
  baseURL?: string
  providerId?: string
}): "responses" | "chat-completions"
