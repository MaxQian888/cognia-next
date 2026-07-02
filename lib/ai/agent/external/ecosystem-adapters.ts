import type {
  AcpPermissionMode,
  ExternalAgentEcosystemExecutionMode,
  ExternalAgentEcosystemSupportTier,
  ExternalAgentProtocol,
  ExternalAgentTransport,
} from "@/types/agent/external-agent"

export interface ExternalAgentEcosystemSurfaceProcessConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface ExternalAgentEcosystemSurfaceNetworkConfig {
  endpoint: string
}

export interface ExternalAgentEcosystemSurfaceDefinition {
  id: string
  presetId?: string
  name: string
  description: string
  protocol: ExternalAgentProtocol
  transport: ExternalAgentTransport
  supportTier: ExternalAgentEcosystemSupportTier
  executionMode: ExternalAgentEcosystemExecutionMode
  defaultPermissionMode: AcpPermissionMode
  tags: string[]
  docsUrl?: string
  envVarHint?: string
  setupHint?: string
  limitationNote?: string
  process?: ExternalAgentEcosystemSurfaceProcessConfig
  network?: ExternalAgentEcosystemSurfaceNetworkConfig
  icon?: string
}

export interface ExternalAgentEcosystemAdapterDefinition {
  id: string
  name: string
  description: string
  docsUrl?: string
  tags: string[]
  surfaces: ExternalAgentEcosystemSurfaceDefinition[]
}

export const EXTERNAL_AGENT_ECOSYSTEM_ADAPTERS: Record<
  string,
  ExternalAgentEcosystemAdapterDefinition
> = {
  codex: {
    id: "codex",
    name: "Codex",
    description: "OpenAI Codex coding assistant surfaces",
    docsUrl: "https://developers.openai.com/codex",
    tags: ["coding", "openai", "codex"],
    surfaces: [
      {
        id: "app-server-stdio",
        presetId: "codex-app-server",
        name: "Codex (app-server)",
        description: "OpenAI Codex via the native first-party app-server protocol",
        protocol: "codex-app-server",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "openai", "codex", "app-server"],
        docsUrl: "https://developers.openai.com/codex/app-server",
        envVarHint:
          "Reuses your active Codex subscription (ChatGPT sign-in) or OPENAI_API_KEY / CODEX_API_KEY automatically.",
        setupHint:
          "Requires the official OpenAI Codex CLI on PATH (`codex`). Cognia launches `codex app-server` directly — no third-party adapter.",
        process: {
          command: "codex",
          args: ["app-server"],
        },
        icon: "openai",
      },
      {
        id: "acp-stdio",
        presetId: "codex",
        name: "Codex CLI",
        description: "OpenAI Codex coding assistant via ACP adapter",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "openai", "codex"],
        docsUrl: "https://github.com/zed-industries/codex-acp",
        envVarHint:
          "Supports ChatGPT sign-in or API-key auth through the local adapter route. Common automation setup uses OPENAI_API_KEY or CODEX_API_KEY.",
        setupHint:
          "Current Cognia executable route uses the ACP adapter (`npx -y @zed-industries/codex-acp`) rather than the native OpenAI Codex runtime directly.",
        process: {
          command: "npx",
          args: ["-y", "@zed-industries/codex-acp"],
        },
        icon: "openai",
      },
      {
        id: "official-cli",
        name: "Official Codex CLI",
        description: "OpenAI Codex CLI installed and run outside Cognia direct ACP execution.",
        protocol: "custom",
        transport: "stdio",
        supportTier: "documented-only",
        executionMode: "external",
        defaultPermissionMode: "default",
        tags: ["coding", "openai", "codex", "cli"],
        docsUrl: "https://developers.openai.com/codex/cli",
        setupHint:
          "Install and authenticate the official Codex CLI from OpenAI docs. Cognia currently documents this surface but executes Codex through the ACP adapter route.",
        limitationNote:
          "Official Codex CLI is part of the Codex product surface, but Cognia does not launch it directly in this change.",
        icon: "openai",
      },
      {
        id: "ide-extension",
        name: "Codex IDE Extension",
        description:
          "OpenAI Codex IDE extension for VS Code, JetBrains, Cursor, and related editors.",
        protocol: "custom",
        transport: "http",
        supportTier: "documented-only",
        executionMode: "external",
        defaultPermissionMode: "default",
        tags: ["coding", "openai", "codex", "ide"],
        docsUrl: "https://developers.openai.com/codex/ide",
        setupHint:
          "Install the official Codex IDE extension in your editor and authenticate there. Cognia links to this surface but does not host the IDE session directly.",
        limitationNote:
          "IDE extension workflows stay in the editor product surface and are not directly executable from Cognia today.",
        icon: "openai",
      },
      {
        id: "slack",
        name: "Codex Slack Integration",
        description:
          "OpenAI Codex Slack app for launching Codex cloud tasks from Slack channels and threads.",
        protocol: "http",
        transport: "http",
        supportTier: "documented-only",
        executionMode: "external",
        defaultPermissionMode: "default",
        tags: ["coding", "openai", "codex", "slack"],
        docsUrl: "https://developers.openai.com/codex/integrations/slack",
        setupHint:
          "Configure the official Codex Slack integration in your OpenAI workspace. Cognia currently exposes docs and limitations only.",
        limitationNote:
          "Slack task execution runs through OpenAI Codex cloud, not through Cognia direct external-agent execution.",
        icon: "openai",
      },
      {
        id: "cloud",
        name: "Codex Cloud",
        description: "OpenAI hosted Codex cloud task workflows and managed environments.",
        protocol: "http",
        transport: "http",
        supportTier: "documented-only",
        executionMode: "external",
        defaultPermissionMode: "default",
        tags: ["coding", "openai", "codex", "cloud"],
        docsUrl: "https://developers.openai.com/codex",
        setupHint:
          "Use the official Codex cloud workflow from ChatGPT/OpenAI products. Cognia does not orchestrate Codex cloud tasks directly in this change.",
        limitationNote:
          "Codex cloud remains an official product surface outside Cognia direct execution until a dedicated hosted bridge exists.",
        icon: "openai",
      },
    ],
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic Claude Code coding agent surfaces",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
    tags: ["coding", "anthropic", "claude"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "claude-code",
        name: "Claude Code",
        description: "Anthropic Claude Code Agent for coding tasks",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "anthropic", "claude"],
        docsUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
        envVarHint: "Requires ANTHROPIC_API_KEY environment variable",
        process: {
          command: "npx",
          args: ["-y", "@anthropics/claude-code", "--stdio"],
        },
        icon: "anthropic",
      },
    ],
  },
  "gemini-cli": {
    id: "gemini-cli",
    name: "Gemini CLI",
    description: "Google Gemini CLI coding assistant surfaces",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    tags: ["coding", "google", "gemini"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "gemini-cli",
        name: "Gemini CLI",
        description: "Google Gemini CLI coding assistant",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "google", "gemini"],
        docsUrl: "https://github.com/google-gemini/gemini-cli",
        envVarHint: "Requires GOOGLE_API_KEY environment variable",
        process: {
          command: "npx",
          args: ["-y", "@google/gemini-cli", "--stdio"],
        },
        icon: "google",
      },
    ],
  },
  "copilot-cli": {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    description: "GitHub Copilot CLI coding agent surfaces",
    docsUrl: "https://docs.github.com/copilot/reference/copilot-cli-reference/acp-server",
    tags: ["coding", "github", "copilot"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "copilot-cli",
        name: "GitHub Copilot CLI",
        description: "GitHub Copilot CLI coding agent via its native ACP server mode",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "github", "copilot"],
        docsUrl: "https://docs.github.com/copilot/reference/copilot-cli-reference/acp-server",
        envVarHint:
          "Authenticates via COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN (PAT with Copilot Requests permission), or run `copilot` once and use /login.",
        setupHint:
          "Requires the GitHub Copilot CLI on PATH (`npm install -g @github/copilot`, Node 22+). ACP support is public preview and may change.",
        process: {
          command: "copilot",
          args: ["--acp"],
        },
        icon: "github",
      },
    ],
  },
  kiro: {
    id: "kiro",
    name: "Kiro CLI",
    description: "AWS Kiro CLI coding agent surfaces",
    docsUrl: "https://kiro.dev/docs/cli/acp/",
    tags: ["coding", "aws", "kiro"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "kiro",
        name: "Kiro CLI",
        description: "AWS Kiro CLI coding agent via its native ACP mode",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "aws", "kiro"],
        docsUrl: "https://kiro.dev/docs/cli/acp/",
        setupHint:
          "Install the Kiro CLI (https://kiro.dev/docs/cli/installation/) and sign in once via `kiro-cli` (AWS Builder ID / IAM Identity Center browser login). Use the full binary path if `kiro-cli` is not on PATH.",
        process: {
          command: "kiro-cli",
          args: ["acp"],
        },
        icon: "aws",
      },
    ],
  },
  "qwen-code": {
    id: "qwen-code",
    name: "Qwen Code",
    description: "Alibaba Qwen Code CLI coding assistant surfaces",
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed/",
    tags: ["coding", "alibaba", "qwen"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "qwen-code",
        name: "Qwen Code",
        description: "Alibaba Qwen Code CLI coding assistant via ACP",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "alibaba", "qwen"],
        docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed/",
        envVarHint:
          "Uses Qwen OAuth device login on first run, or OpenAI-compatible auth via OPENAI_API_KEY / OPENAI_BASE_URL (config in ~/.qwen/).",
        process: {
          command: "npx",
          args: ["-y", "@qwen-code/qwen-code", "--acp"],
        },
        icon: "qwen",
      },
    ],
  },
  pi: {
    id: "pi",
    name: "Pi",
    description: "Pi coding agent surfaces (via community ACP adapter)",
    docsUrl: "https://github.com/svkozak/pi-acp",
    tags: ["coding", "pi", "experimental"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "pi",
        name: "Pi (community adapter)",
        description:
          "Pi coding agent bridged over ACP by the community pi-acp adapter (experimental)",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "pi", "community-adapter", "experimental"],
        docsUrl: "https://github.com/svkozak/pi-acp",
        setupHint:
          "Requires the Pi agent (`npm install -g @earendil-works/pi-coding-agent`) with provider keys configured in Pi's own settings (~/.pi/agent/settings.json). Pi has no native ACP support yet; the third-party pi-acp adapter bridges ACP to `pi --mode rpc`.",
        limitationNote:
          "pi-acp is a community adapter, not an official Pi surface — behavior may lag Pi releases.",
        process: {
          command: "npx",
          args: ["-y", "pi-acp"],
        },
        icon: "pi",
      },
    ],
  },
  droid: {
    id: "droid",
    name: "Factory Droid",
    description: "Factory Droid CLI coding agent surfaces",
    docsUrl: "https://docs.factory.ai/integrations/zed",
    tags: ["coding", "factory", "droid"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "droid",
        name: "Factory Droid",
        description: "Factory Droid CLI coding agent via its native ACP output mode",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "factory", "droid"],
        docsUrl: "https://docs.factory.ai/integrations/zed",
        envVarHint:
          "Authenticates via FACTORY_API_KEY (create at app.factory.ai/settings/api-keys), or run `droid` once for device-code browser login.",
        setupHint:
          "Install the Factory Droid CLI (`curl -fsSL https://app.factory.ai/cli | sh`) and ensure `droid` is on PATH, or use the full binary path.",
        process: {
          command: "droid",
          args: ["exec", "--output-format", "acp"],
        },
        icon: "factory",
      },
    ],
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    description: "Cursor agent ecosystem surfaces across local CLI and hosted agent workflows",
    docsUrl: "https://docs.cursor.com/en/cli/overview",
    tags: ["coding", "cursor", "agent"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "cursor-cli",
        name: "Cursor CLI",
        description: "Cursor local CLI agent surface for direct ACP-style local execution",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "cursor", "local"],
        docsUrl: "https://docs.cursor.com/en/cli/overview",
        setupHint:
          "Install Cursor CLI and ensure `cursor-agent` is available on PATH before connecting.",
        process: {
          command: "cursor-agent",
          args: [],
        },
        icon: "cursor",
      },
      {
        id: "mcp-config",
        name: "Cursor MCP Configuration",
        description:
          "Cursor MCP integration surface managed from Cursor-side configuration and extension APIs",
        protocol: "acp",
        transport: "http",
        supportTier: "documented-only",
        executionMode: "external",
        defaultPermissionMode: "default",
        tags: ["cursor", "mcp", "configuration"],
        docsUrl: "https://docs.cursor.com/en/context/mcp-extension-api",
        setupHint:
          "Use Cursor-side MCP configuration or extension APIs; Cognia does not execute this surface directly yet.",
        limitationNote:
          "Official surface is documented, but direct Cognia bridge is not implemented in this change.",
      },
      {
        id: "background-agent",
        name: "Cursor Background Agents",
        description:
          "Cursor hosted background-agent workflow surfaced through Cursor web/desktop products",
        protocol: "acp",
        transport: "http",
        supportTier: "documented-only",
        executionMode: "external",
        defaultPermissionMode: "default",
        tags: ["cursor", "background-agent", "hosted"],
        docsUrl: "https://docs.cursor.com/background-agents",
        setupHint:
          "Use Cursor hosted background agents from Cursor products; Cognia currently links to docs and limitations only.",
        limitationNote:
          "Background Agents remain outside Cognia direct execution until a stable hosted bridge exists.",
      },
    ],
  },
}

export function getExternalAgentEcosystemAdapter(
  adapterId: string
): ExternalAgentEcosystemAdapterDefinition | null {
  return EXTERNAL_AGENT_ECOSYSTEM_ADAPTERS[adapterId] ?? null
}

export function listExternalAgentEcosystemAdapters(): ExternalAgentEcosystemAdapterDefinition[] {
  return Object.values(EXTERNAL_AGENT_ECOSYSTEM_ADAPTERS)
}

export function findExternalAgentSurfaceByPresetId(presetId: string): {
  adapter: ExternalAgentEcosystemAdapterDefinition
  surface: ExternalAgentEcosystemSurfaceDefinition
} | null {
  for (const adapter of listExternalAgentEcosystemAdapters()) {
    const surface = adapter.surfaces.find((item) => item.presetId === presetId)
    if (surface) {
      return { adapter, surface }
    }
  }
  return null
}

export function findExternalAgentSurface(
  adapterId: string,
  surfaceId: string
): {
  adapter: ExternalAgentEcosystemAdapterDefinition
  surface: ExternalAgentEcosystemSurfaceDefinition
} | null {
  const adapter = getExternalAgentEcosystemAdapter(adapterId)
  if (!adapter) {
    return null
  }

  const surface = adapter.surfaces.find((item) => item.id === surfaceId)
  if (!surface) {
    return null
  }

  return {
    adapter,
    surface,
  }
}

/**
 * Check if a surface is directly executable by Cognia.
 * Returns an error with documentation link if the surface is not executable.
 */
export function checkSurfaceExecutability(
  adapterId: string,
  surfaceId: string
): { executable: true } | { executable: false; error: string; docsUrl?: string } {
  const resolved = findExternalAgentSurface(adapterId, surfaceId)
  if (!resolved) {
    return { executable: false, error: `Surface "${adapterId}/${surfaceId}" not found` }
  }

  const { surface } = resolved
  if (surface.supportTier === "documented-only") {
    return {
      executable: false,
      error: `Surface "${surface.name}" is not directly executable by Cognia. ${surface.limitationNote || "This surface requires external setup."}`,
      docsUrl: surface.docsUrl,
    }
  }

  return { executable: true }
}

/**
 * List all surfaces with their support tier for UI display.
 */
export function listAllSurfacesWithTier(): Array<{
  adapterId: string
  adapterName: string
  surfaceId: string
  surfaceName: string
  supportTier: ExternalAgentEcosystemSupportTier
  executionMode: ExternalAgentEcosystemExecutionMode
  docsUrl?: string
  limitationNote?: string
}> {
  const result: Array<{
    adapterId: string
    adapterName: string
    surfaceId: string
    surfaceName: string
    supportTier: ExternalAgentEcosystemSupportTier
    executionMode: ExternalAgentEcosystemExecutionMode
    docsUrl?: string
    limitationNote?: string
  }> = []

  for (const adapter of listExternalAgentEcosystemAdapters()) {
    for (const surface of adapter.surfaces) {
      result.push({
        adapterId: adapter.id,
        adapterName: adapter.name,
        surfaceId: surface.id,
        surfaceName: surface.name,
        supportTier: surface.supportTier,
        executionMode: surface.executionMode,
        docsUrl: surface.docsUrl,
        limitationNote: surface.limitationNote,
      })
    }
  }

  return result
}

export function resolveExternalAgentSurfaceFromMetadata(metadata?: Record<string, unknown>): {
  adapter: ExternalAgentEcosystemAdapterDefinition
  surface: ExternalAgentEcosystemSurfaceDefinition
} | null {
  if (!metadata) {
    return null
  }

  const adapterId =
    typeof metadata.ecosystemAdapterId === "string" ? metadata.ecosystemAdapterId : undefined
  const surfaceId =
    typeof metadata.ecosystemSurfaceId === "string" ? metadata.ecosystemSurfaceId : undefined

  if (adapterId && surfaceId) {
    const resolved = findExternalAgentSurface(adapterId, surfaceId)
    if (resolved) {
      return resolved
    }
  }

  const presetId = typeof metadata.preset === "string" ? metadata.preset : undefined
  if (presetId) {
    return findExternalAgentSurfaceByPresetId(presetId)
  }

  return null
}
