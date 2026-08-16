import { APP_VERSION } from "@/lib/app-version"
import { getLocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import { hasNoLeakingPii, redactText } from "@cognia/redact"

export const SUPPORT_AGENT_ID = "char_builtin_support"
export const SUPPORT_AGENT_CANONICAL_ID = "cognia-pack:cognia-builtin-characters:builtin:support"
export const SUPPORT_DIAGNOSTICS_STORAGE_KEY = "cognia.support-agent.diagnostics-enabled"

const DIAGNOSTIC_QUERY =
  /\b(diagnostic|diagnostics|debug|error|failure|failed|crash|version|environment|runtime|device|troubleshoot)\b|诊断|调试|错误|失败|崩溃|版本|环境|运行时|设备|排障/i

export function isSupportAgentId(characterId: string | null | undefined): boolean {
  return characterId === SUPPORT_AGENT_ID || characterId === SUPPORT_AGENT_CANONICAL_ID
}

export function isSupportDiagnosticsEnabled(
  storage: Storage | undefined = globalThis.localStorage
): boolean {
  if (process.env.NEXT_PUBLIC_SUPPORT_AGENT_DIAGNOSTICS === "0") return false
  try {
    return storage?.getItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

const consentListeners = new Set<() => void>()

export function setSupportDiagnosticsEnabled(
  enabled: boolean,
  storage: Storage = localStorage
): void {
  storage.setItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY, String(enabled))
  for (const listener of consentListeners) listener()
}

/**
 * Observe the kill switch. Fires for in-window writes through
 * {@link setSupportDiagnosticsEnabled} and for other-window writes via the
 * `storage` event, so the chat strip and the Settings row never disagree.
 */
export function subscribeSupportDiagnosticsConsent(listener: () => void): () => void {
  consentListeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SUPPORT_DIAGNOSTICS_STORAGE_KEY) listener()
  }
  const win = typeof window !== "undefined" ? window : undefined
  win?.addEventListener("storage", onStorage)
  return () => {
    consentListeners.delete(listener)
    win?.removeEventListener("storage", onStorage)
  }
}

export function shouldReadSupportDiagnostics(userText: string | undefined): boolean {
  return Boolean(userText && DIAGNOSTIC_QUERY.test(userText))
}

export function serializeSupportDiagnostics(snapshot: unknown): string {
  const redacted = redactText(JSON.stringify(snapshot, null, 2)).redacted.slice(0, 6_000)
  if (!hasNoLeakingPii(redacted)) {
    throw new Error("Support diagnostics still contain sensitive data after redaction.")
  }
  return redacted
}

export async function buildSupportAgentContext({
  locale,
  userText,
  diagnosticsEnabled = isSupportDiagnosticsEnabled(),
  readDiagnostics = getLocalRuntimeDiagnostics,
}: {
  locale?: string
  userText?: string
  diagnosticsEnabled?: boolean
  readDiagnostics?: typeof getLocalRuntimeDiagnostics
}): Promise<string> {
  const { retrieveSupportDocumentation } = await import("./knowledge")
  const docs = retrieveSupportDocumentation({ locale, query: userText })
  const sections = [
    `## Version-matched Cognia documentation\n\nBundled app version: ${APP_VERSION}\n\n${docs}`,
  ]

  if (diagnosticsEnabled && shouldReadSupportDiagnostics(userText)) {
    const snapshot = await readDiagnostics().catch(() => null)
    if (snapshot) {
      const redacted = serializeSupportDiagnostics(snapshot)
      sections.push(`## Redacted local diagnostics\n\n\`\`\`json\n${redacted}\n\`\`\``)
    }
  }

  return sections.join("\n\n")
}

/** Final immutable runtime clamp applied after every normal Agent overlay. */
export function applySupportAgentSafety<T extends Record<string, unknown>>(options: T): T {
  const next: Record<string, unknown> = { ...options }
  next.permissionMode = "plan"
  next.toolSurface = "none"
  next.allowedTools = []
  next.disallowedTools = [
    "Bash",
    "Computer",
    "Edit",
    "Glob",
    "Grep",
    "NotebookEdit",
    "Read",
    "Task",
    "WebFetch",
    "WebSearch",
    "Write",
  ]
  next.mcpServers = {}
  delete next.agents
  delete next.agent
  delete next.additionalDirectories
  delete next.trustedWorkspaceRoots
  delete next.cwd
  delete next.env
  delete next.execution
  delete next.permissionRuleset
  delete next.alwaysAllowTools
  delete next.builtinTools
  delete next.pluginTools
  delete next.lsp
  delete next.anthropicTools
  delete next.toolResultReviewEnabled
  delete next.toolSearchEnabled
  delete next.alwaysLoadServers
  delete next.alwaysLoadTools
  delete next.claudeAgentSdk
  delete next.hooks
  delete next.plugins
  delete next.skills
  delete next.suppressApprovalForTools
  return next as T
}
