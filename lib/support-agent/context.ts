import { APP_VERSION } from "@/lib/app-version"
import { getLocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import { hasNoLeakingPii, redactText } from "@cognia/redact"

export const SUPPORT_AGENT_ID = "char_builtin_support"
export const SUPPORT_DIAGNOSTICS_STORAGE_KEY = "cognia.support-agent.diagnostics-enabled"

const DIAGNOSTIC_QUERY =
  /\b(diagnostic|diagnostics|debug|error|failure|failed|crash|version|environment|runtime|device|troubleshoot)\b|诊断|调试|错误|失败|崩溃|版本|环境|运行时|设备|排障/i

interface SupportDoc {
  source: string
  en: string
  zh: string
}

/** Bundled, version-stamped product-doc excerpts; no network or filesystem read. */
const SUPPORT_DOCS: readonly SupportDoc[] = [
  {
    source: "docs/content/docs/{locale}/index.mdx",
    en: "Cognia is a local-first AI workspace. Conversations, Agents, projects, workflows, and diagnostics are managed from the application navigation and Settings.",
    zh: "Cognia 是本地优先的 AI 工作空间。会话、Agent、项目、工作流和诊断均可从应用导航与设置中管理。",
  },
  {
    source: "docs/content/docs/{locale}/adr/0028-per-session-claude-isolation.md",
    en: "Provider accounts and session execution are isolated per conversation. Credential values are never product-document context and must not be requested or displayed by support.",
    zh: "Provider 账号与会话执行按会话隔离。凭据值不属于产品文档上下文，支持助手不得请求或展示凭据。",
  },
  {
    source: "docs/content/docs/{locale}/adr/0102-unified-observability-crash-diagnostics.md",
    en: "Diagnostics are consent-aware and privacy-gated. Prefer stable error codes, runtime status, and redacted environment facts; never include prompt content, secrets, or raw local files.",
    zh: "诊断遵循用户同意与隐私网关。应优先使用稳定错误码、运行状态和已脱敏的环境信息；不得包含提示词内容、密钥或原始本地文件。",
  },
  {
    source: "docs/content/docs/{locale}/adr/0097-cross-device-settings-contract-and-companion-reach.md",
    en: "Desktop and Companion share selected metadata, while device-local paths and credentials require explicit rebinding or authorization on each device.",
    zh: "桌面端与 Companion 仅共享选定元数据；设备本地路径和凭据必须在每台设备上显式重新绑定或授权。",
  },
]

export function isSupportAgentId(characterId: string | null | undefined): boolean {
  return characterId === SUPPORT_AGENT_ID
}

export function isSupportDiagnosticsEnabled(storage: Storage | undefined = globalThis.localStorage): boolean {
  if (process.env.NEXT_PUBLIC_SUPPORT_AGENT_DIAGNOSTICS === "0") return false
  try {
    return storage?.getItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY) !== "false"
  } catch {
    return false
  }
}

export function setSupportDiagnosticsEnabled(enabled: boolean, storage: Storage = localStorage): void {
  storage.setItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY, String(enabled))
}

export function shouldReadSupportDiagnostics(userText: string | undefined): boolean {
  return Boolean(userText && DIAGNOSTIC_QUERY.test(userText))
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
  const chinese = locale?.toLowerCase().startsWith("zh") ?? false
  const docs = SUPPORT_DOCS.map(
    (doc) => `- [${doc.source.replace("{locale}", chinese ? "zh" : "en")}] ${chinese ? doc.zh : doc.en}`
  ).join("\n")
  const sections = [
    `## Version-matched Cognia documentation\n\nBundled app version: ${APP_VERSION}\n\n${docs}`,
  ]

  if (diagnosticsEnabled && shouldReadSupportDiagnostics(userText)) {
    const snapshot = await readDiagnostics().catch(() => null)
    if (snapshot) {
      const redacted = redactText(JSON.stringify(snapshot, null, 2)).redacted.slice(0, 6000)
      if (hasNoLeakingPii(redacted)) {
        sections.push(`## Redacted local diagnostics\n\n\`\`\`json\n${redacted}\n\`\`\``)
      }
    }
  }

  return sections.join("\n\n")
}

/** Final immutable runtime clamp applied after every normal Agent overlay. */
export function applySupportAgentSafety<T extends Record<string, unknown>>(options: T): T {
  const next = { ...options }
  next.permissionMode = "plan"
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
  return next
}
