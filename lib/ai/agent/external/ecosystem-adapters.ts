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
  metadata?: Record<string, unknown>
}

export interface ExternalAgentEcosystemAdapterDefinition {
  id: string
  name: string
  description: string
  docsUrl?: string
  tags: string[]
  surfaces: ExternalAgentEcosystemSurfaceDefinition[]
}

/** Local agent surfaces share product metadata; protocol packages own their wire clients. */
function nativeAgentAdapter(definition: {
  id: string
  name: string
  command: string
  args: string[]
  docsUrl: string
  description: string
  setupHint: string
  envVarHint?: string
  limitationNote?: string
  defaultPermissionMode?: AcpPermissionMode
  protocol?: ExternalAgentProtocol
  transport?: ExternalAgentTransport
  metadata?: Record<string, unknown>
}): ExternalAgentEcosystemAdapterDefinition {
  const {
    id,
    name,
    command,
    args,
    docsUrl,
    protocol = "acp",
    transport = "stdio",
    ...surface
  } = definition
  return {
    id,
    name,
    description: surface.description,
    docsUrl,
    tags: ["coding", id, protocol],
    surfaces: [
      {
        id: `${protocol}-${transport}`,
        presetId: id,
        name,
        ...surface,
        docsUrl,
        protocol,
        transport,
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: surface.defaultPermissionMode ?? "default",
        tags: ["coding", id, protocol],
        process: { command, args },
      },
    ],
  }
}

export const EXTERNAL_AGENT_ECOSYSTEM_ADAPTERS: Record<
  string,
  ExternalAgentEcosystemAdapterDefinition
> = {
  openclaude: nativeAgentAdapter({
    id: "openclaude",
    name: "OpenClaude",
    command: "openclaude",
    args: [],
    protocol: "openclaude-cli",
    docsUrl: "https://github.com/twigpine/openclaude",
    description:
      "OpenClaude's bidirectional native stream protocol with host permission hooks and exact session recovery.",
    setupHint:
      "Install @twigpine/openclaude@0.33.0 and authenticate using its own CLI. Cognia uses OpenClaude's native protocol with mandatory tool hooks; Claude Code credentials are separate.",
    envVarHint:
      "Use native OpenClaude authentication and OPENCLAUDE_CONFIG_DIR when selecting a private configuration root.",
  }),
  crush: nativeAgentAdapter({
    id: "crush",
    name: "Charm Crush",
    command: "crush",
    args: [],
    protocol: "crush-http",
    transport: "http",
    docsUrl: "https://github.com/charmbracelet/crush",
    description:
      "Charm Crush's native service API through a private host socket, including streamed tools and user decisions.",
    setupHint:
      "Install Crush 0.98.2 and configure its native provider. Cognia owns the private Unix socket server and verifies its bundled host bridge.",
    envVarHint:
      "Native Crush credentials and configuration stay with Crush. Configure provider credentials in the native setup or explicit process environment.",
    limitationNote:
      "Requires a local macOS or Linux process host. Public unauthenticated server endpoints are not used.",
    metadata: { localProcessService: true },
  }),
  "continue-dev": nativeAgentAdapter({
    id: "continue-dev",
    name: "Continue",
    command: "cn",
    args: [],
    protocol: "continue-cli",
    defaultPermissionMode: "plan",
    docsUrl: "https://docs.continue.dev/cli/overview",
    description:
      "Continue's native headless CLI with bounded structured results and host-owned conversation history.",
    setupHint:
      "Install the official Continue CLI and run cn login. Cognia uses headless JSON output and never starts the unauthenticated cn serve endpoint.",
    envVarHint:
      "Use native Continue configuration and login under ~/.continue, or explicitly configure its documented provider credentials.",
    limitationNote:
      "Headless output is a final result, without a per-tool host approval stream. Read-only plan or explicitly authorized automatic execution is required; history is replayed by the host.",
  }),
  "rovo-dev": nativeAgentAdapter({
    id: "rovo-dev",
    name: "Rovo Dev",
    command: "acli",
    args: ["rovodev", "serve"],
    protocol: "rovo-http",
    transport: "http",
    docsUrl: "https://support.atlassian.com/rovo/docs/use-rovo-dev-cli/",
    description:
      "Atlassian Rovo Dev's native streaming service with an owned authenticated local process.",
    setupHint:
      "Install Atlassian CLI and authenticate Rovo Dev. Cognia starts its own bearer-authenticated local service with configured permissions respected.",
    envVarHint:
      "Use native acli authentication. Explicit USER_EMAIL and USER_API_TOKEN are accepted only when required by your native setup.",
    limitationNote:
      "Requires a local macOS or Linux process host. Authentication must prove ownership of the server before a prompt is sent.",
    metadata: { localProcessService: true },
  }),
  codebuff: nativeAgentAdapter({
    id: "codebuff",
    name: "Codebuff",
    command: "node",
    args: [],
    protocol: "codebuff-sdk",
    docsUrl: "https://www.codebuff.com/docs/help/sdk",
    description:
      "Codebuff's pinned SDK through a verified isolated host bridge with gated network and tool access.",
    setupHint:
      "Cognia supplies the verified bridge and @codebuff/sdk 0.10.7. Configure CODEBUFF_API_KEY and a workspace; the Codebuff CLI is not substituted for this SDK protocol.",
    envVarHint:
      "Set CODEBUFF_API_KEY in the process environment. Credentials remain in host secret storage and are not placed in prompts.",
    limitationNote:
      "Requires a local macOS or Linux sandbox with bridge networking disabled and host-gated requests. Native MCP and provider OAuth are unavailable.",
    metadata: { bundledBridge: "codebuff" },
  }),
  auggie: nativeAgentAdapter({
    id: "auggie",
    name: "Auggie",
    command: "auggie",
    args: ["--acp"],
    docsUrl: "https://docs.augmentcode.com/cli/acp/agent",
    description:
      "Augment's native ACP agent using its own login and negotiated session capabilities.",
    setupHint:
      "Install @augmentcode/auggie@0.36.0, then run auggie login. Cognia starts the installed CLI with automatic updates disabled. Update outside hosted sessions.",
    envVarHint:
      "Use the native Auggie login or explicitly supply AUGMENT_SESSION_AUTH session JSON. Cognia never prints the credential.",
  }),
  "autohand-code": nativeAgentAdapter({
    id: "autohand-code",
    name: "Autohand Code",
    command: "autohand",
    args: ["--acp"],
    docsUrl: "https://github.com/autohandai/code-cli/blob/v0.9.8/docs/guides/ACP.md",
    description:
      "Autohand Code's native ACP with streamed turns, host tool decisions and negotiated session recovery.",
    setupHint:
      "Install autohand-cli@0.9.8, then run autohand --setup for the native account/provider configuration. Cognia uses native ACP, not the older separate ACP bridge.",
    envVarHint:
      "Reuse the native configuration under ~/.autohand. Provider credentials stay in the native configuration or an explicitly configured process environment.",
  }),
  codebuddy: nativeAgentAdapter({
    id: "codebuddy",
    name: "CodeBuddy",
    command: "codebuddy",
    args: ["--acp"],
    docsUrl: "https://www.codebuddy.ai/docs/cli/acp",
    description:
      "Tencent CodeBuddy's native ACP with session, tool and model controls negotiated from the installed CLI.",
    setupHint:
      "Install @tencent-ai/codebuddy-code@2.177.0 and complete native CodeBuddy login. Cognia uses codebuddy --acp. Sandbox permission-bypass environment switches are not accepted.",
    envVarHint:
      "CODEBUDDY_API_KEY is a model credential; CODEBUDDY_AUTH_TOKEN is a platform credential. Use only the credential required by the selected native setup.",
  }),
  "command-code": nativeAgentAdapter({
    id: "command-code",
    name: "Command Code",
    command: "commandcode",
    args: ["acp"],
    docsUrl: "https://commandcode.ai/docs/acp",
    description:
      "Command Code's native ACP with an isolated process per conversation and host tool decisions.",
    setupHint:
      "Install command-code@1.88.0 and run commandcode login. Cognia uses the package's commandcode alias to avoid the Windows system cmd name. Each conversation owns its project process.",
    envVarHint:
      "Native authentication and custom providers are configured under ~/.commandcode. The Windows system cmd executable is not this agent.",
    limitationNote:
      "Client stdio and HTTP MCP are supported; legacy SSE is unavailable. Native same-name MCP configuration takes precedence.",
  }),
  kilocode: nativeAgentAdapter({
    id: "kilocode",
    name: "Kilo Code",
    command: "kilo",
    args: ["acp"],
    docsUrl: "https://kilo.ai/docs/code-with-ai/platforms/cli",
    description:
      "Kilo Code's native ACP for streaming, tools, model selection and advertised native sessions.",
    setupHint:
      "Install @kilocode/cli@7.8.18 and authenticate in Kilo. Cognia launches kilo acp and preserves the system installation when removing its saved configuration.",
    envVarHint:
      "Use native login or explicitly supply KILO_API_KEY and optional KILO_ORG_ID. KILO_AUTH_CONTENT contains native auth JSON and must remain private.",
  }),
  "mistral-vibe": nativeAgentAdapter({
    id: "mistral-vibe",
    name: "Mistral Vibe",
    command: "vibe-acp",
    args: [],
    docsUrl: "https://github.com/mistralai/mistral-vibe/blob/v3.0.1/docs/acp-setup.md",
    description:
      "Mistral Vibe's official ACP executable with native authentication and negotiated tools and sessions.",
    setupHint:
      "Install mistral-vibe 3.0.1 using the official installer or uv. Cognia launches the separate vibe-acp executable and uses its advertised authentication methods.",
    envVarHint:
      "MISTRAL_API_KEY can configure the native provider. VIBE_HOME selects native configuration and credential storage; default ~/.vibe.",
  }),
  "mimo-code": nativeAgentAdapter({
    id: "mimo-code",
    name: "MiMo Code",
    command: "mimo",
    args: ["acp"],
    docsUrl: "https://github.com/XiaomiMiMo/MiMo-Code",
    description:
      "Xiaomi MiMo Code's native ACP for streamed replies, host tool decisions and native session recovery.",
    setupHint:
      "Install MiMo Code from the official Xiaomi installer and authenticate with mimo auth login. Cognia launches mimo acp; upstream's legacy OpenCode authentication label is not used as a launch command.",
    envVarHint:
      "MIMOCODE_HOME selects MiMo's own data/config/cache/state root. Existing MiMo credentials remain native; OpenCode credentials are not copied.",
  }),
  "hermes-agent": nativeAgentAdapter({
    id: "hermes-agent",
    name: "Hermes Agent",
    command: "hermes",
    args: ["acp"],
    docsUrl:
      "https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/acp.md",
    description:
      "Hermes Agent's native ACP with daemon-aware cancellation and advertised native sessions.",
    setupHint:
      "Install Hermes with its ACP extra, configure the native provider with hermes model, and verify hermes acp --check. Cognia uses the daemon-aware ACP cancellation path.",
    envVarHint:
      "HERMES_HOME selects native state; default ~/.hermes. Configure the native provider rather than placing credentials in chat prompts.",
    limitationNote:
      "The ACP process is a gateway viewer. Detaching a viewer is distinct from cancelling active daemon work.",
  }),
  "oh-my-pi": nativeAgentAdapter({
    id: "oh-my-pi",
    name: "oh-my-pi",
    command: "omp",
    args: ["acp"],
    docsUrl: "https://github.com/can1357/oh-my-pi",
    description:
      "oh-my-pi's official ACP with guarded host files and terminals, tool decisions and native session management.",
    setupHint:
      "Install @oh-my-pi/pi-coding-agent or the official omp binary and configure its native provider. Cognia launches omp acp with guarded client file and terminal ports inside the host sandbox.",
    envVarHint:
      "Native OMP configuration is under ~/.omp/agent. Pi's account and state are a separate product; Cognia does not copy them into OMP.",
    limitationNote:
      "This application route uses official ACP. The separate experimental native RPC package is not substituted for the guarded ACP host.",
  }),
  muse: nativeAgentAdapter({
    id: "muse",
    name: "Meta Muse Code",
    command: "muse-acp",
    args: [],
    docsUrl: "https://github.com/BrokkAi/muse-acp",
    description:
      "Meta Muse Code through the BrokkAi ACP bridge to its native Muse Session Protocol.",
    setupHint:
      "Install and authenticate native Muse Code with muse login, then install @brokkai/muse-acp. The unscoped muse-acp package is a different project. Cognia requires prompt-based tool approval and negotiated Muse session grants.",
    envVarHint:
      "MUSE_CLI can locate the installed vendor CLI. Native Muse credentials and state remain Muse-owned.",
    limitationNote:
      "Community adapter. Client MCP requires the native sessionMcp grant; missing grants and unsupported SSE are refused explicitly.",
  }),
  amp: nativeAgentAdapter({
    id: "amp",
    name: "Amp",
    command: "amp-acp",
    args: [],
    docsUrl: "https://github.com/tao12345666333/amp-acp",
    description:
      "Amp through its local ACP bridge, with explicit launch authority and host process containment.",
    setupHint:
      "Install and authenticate native Amp, then install amp-acp 0.10.0. This community bridge does not relay per-tool host approvals. Explicit automatic authority and the host sandbox are required; Orb execution is unavailable.",
    envVarHint:
      "AMP_API_KEY or native Amp login; AMP_CLI_PATH can select the installed executable. AMP_ACP_STATE_DIR stores exact native thread mappings.",
    limitationNote:
      "No per-tool Cognia approval loop. Mandatory host approval rules and remote Orb execution are refused; native thread recovery never selects the latest unrelated thread.",
    defaultPermissionMode: "bypassPermissions",
  }),
  zcode: nativeAgentAdapter({
    id: "zcode",
    name: "ZCode",
    command: "zcode-acp",
    args: [],
    docsUrl: "https://github.com/Liang-HZ/zcode-acp",
    description: "Z.ai ZCode through the macOS ACP bridge with one process per conversation.",
    setupHint:
      "Install and sign into the official ZCode macOS application, then install zcode-acp 0.9.1. Cognia launches the bridge without the auto-approving run subcommand. Native terminal use is also available.",
    envVarHint:
      "ZCODE_CJS selects the installed desktop engine; native state remains under ~/.zcode. The adapter keeps diagnostics under ~/.zcode-acp.",
    limitationNote:
      "Community bridge for the signed-in macOS desktop engine. Text input only; native resume is distinct from legacy session/load.",
  }),
  antigravity: {
    id: "antigravity",
    name: "Google Antigravity",
    description: "Google's official Antigravity ACP server",
    docsUrl: "https://antigravity.google/docs/ide/extensions/zed/",
    tags: ["coding", "google", "antigravity", "acp"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "antigravity-acp",
        name: "Antigravity (ACP)",
        description:
          "Connect the official Antigravity ACP server using its native account and model configuration.",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "google", "antigravity", "acp"],
        setupHint:
          "Install the official antigravity-acp archive from the ACP Registry. Keep agy_acp_server.par and localharness_external together and executable, and add that directory to PATH. Cognia uses the separate ACP server, not agy print mode; removing a configuration preserves the system installation and native account.",
        envVarHint:
          "Authenticate with the ACP server's advertised Google account, enterprise, Gemini API or Agent Platform method. The agy CLI login is separate. A custom GEMINI_HOME selects configuration and file storage, but does not isolate the operating system keychain.",
        limitationNote:
          "Requires a Cognia process host and sandbox. Plan mode, private-state cloning, Cognia model gateway and transcript import are unavailable. Native session/model features depend on negotiated capabilities; authenticated acceptance is recorded separately.",
        process: { command: "agy_acp_server.par", args: [] },
        icon: "antigravity",
      },
    ],
  },
  grok: {
    id: "grok",
    name: "Grok Build",
    description: "xAI Grok Build over its native ACP server",
    docsUrl: "https://github.com/xai-org/grok-build",
    tags: ["coding", "xai", "grok", "acp"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "grok",
        name: "Grok Build",
        description:
          "Native Grok Build with streamed replies, tool approvals, user questions, MCP and persisted sessions.",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "xai", "grok", "acp"],
        docsUrl: "https://github.com/xai-org/grok-build",
        setupHint:
          "Install @xai-official/grok@1.0.62 and authenticate with Grok Build, or supply XAI_API_KEY locally. Cognia launches grok agent --no-leader stdio with automatic updates disabled. Update outside hosted sessions. Removing a configuration preserves the system installation and shared Grok data.",
        envVarHint:
          "Use the existing Grok Build login or XAI_API_KEY. Optional GROK_HOME selects state (default ~/.grok); isolated configurations use their own login and settings.",
        limitationNote:
          "Grok Build 1.0.62 passed isolated ACP compatibility checks; authenticated xAI acceptance is pending. Session fork, image input and audio input are unavailable in this release.",
        process: { command: "grok", args: ["agent", "--no-leader", "stdio"] },
        icon: "xai",
      },
    ],
  },
  "minimax-code": {
    id: "minimax-code",
    name: "MiniMax Code",
    description: "MiniMax Code's native ACP agent with per-conversation process isolation",
    docsUrl: "https://github.com/MiniMax-AI/minimax-code",
    tags: ["coding", "minimax", "acp"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "minimax-code",
        name: "MiniMax Code",
        description:
          "Native MiniMax Code with streamed replies, images, tool approvals, MCP and persisted sessions. Each conversation owns a process.",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "minimax", "acp"],
        docsUrl: "https://github.com/MiniMax-AI/minimax-code",
        setupHint:
          "Install @minimax-ai/code@0.6.12 with Node.js 22.19+ (22.x), 24.2+ (24.x), 25 or 26, including optional dependencies and the MiniMax/SQLite install scripts. Run mcode login in the configuration's state directory. Cognia launches mcode acp and preserves the system installation and login when removing a configuration.",
        envVarHint:
          "MINIMAX_DATA_DIR selects state; MAVIS_DATA_DIR is its fallback. Default state is ~/.minimax. Native Default may preapprove edits and classified shell operations. Accept Edits, Don't ask and mandatory host approval rules are unavailable; native Auto is hidden.",
        process: { command: "mcode", args: ["acp"] },
        icon: "minimax",
      },
    ],
  },
  kimi: {
    id: "kimi",
    name: "Kimi Code",
    description: "Moonshot AI Kimi Code over its native ACP server",
    docsUrl: "https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started",
    tags: ["coding", "kimi", "moonshot", "acp"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "kimi",
        name: "Kimi Code",
        description:
          "Native Kimi Code CLI with subscription login, streamed replies, images, tool approvals, MCP and persisted sessions.",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "kimi", "acp"],
        docsUrl: "https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html",
        setupHint:
          "Install npm install -g @moonshot-ai/kimi-code@2.2.0 with Node.js 22.19 or newer, then run kimi login for your Kimi Code subscription. Cognia launches kimi acp using the existing login. KIMI_CODE_HOME selects separate state; update outside hosted sessions with kimi upgrade. Removing this configuration preserves the system installation and Kimi data. The archived Python kimi-cli is not this runtime.",
        envVarHint:
          "Subscription login needs no API key. Optional KIMI_CODE_HOME selects state (default ~/.kimi-code). For a custom provider use KIMI_MODEL_NAME, KIMI_MODEL_PROVIDER_TYPE, KIMI_MODEL_BASE_URL and KIMI_MODEL_API_KEY; these replace subscription model selection.",
        process: { command: "kimi", args: ["acp"] },
        icon: "kimi",
      },
    ],
  },
  cline: {
    id: "cline",
    name: "Cline",
    description: "Cline's official CLI agent over native ACP",
    docsUrl: "https://docs.cline.bot/usage/acp",
    tags: ["coding", "cline", "acp"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "cline",
        name: "Cline",
        description:
          "Official Cline CLI with streamed text, Plan/Act, tool approvals and persisted session resume.",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "cline", "acp"],
        docsUrl: "https://docs.cline.bot/usage/acp",
        setupHint:
          "Install npm install -g cline@3.0.67. Use cline auth for Cline, ClinePass or ChatGPT login, or set CLINE_PROVIDER, CLINE_MODEL and CLINE_API_KEY locally for BYOK. --config or CLINE_DIR selects ACP state; --data-dir is ignored upstream in ACP and is rejected here. Auto-update is disabled while hosted. Remove only Cognia configuration; system installation and Cline data remain.",
        envVarHint:
          "CLINE_PROVIDER, CLINE_MODEL, CLINE_API_KEY; optional CLINE_DIR. A pinned provider disables provider switching. ACP restores saved OAuth credentials; other provider keys must be supplied through CLINE_API_KEY.",
        limitationNote:
          "Cline 3.0.67 ACP accepts but does not forward images or per-session MCP servers. Session listing/deletion is not advertised. Configure native MCP with cline mcp; authenticated model, edit and MCP acceptance is pending.",
        process: { command: "cline", args: ["--acp", "--auto-approve", "false"] },
      },
    ],
  },
  aider: {
    id: "aider",
    name: "Aider",
    description: "Official Aider CLI with Cognia session history",
    docsUrl: "https://aider.chat/docs/scripting.html",
    tags: ["coding", "aider", "cli"],
    surfaces: [
      {
        id: "cli-stdio",
        presetId: "aider",
        name: "Aider",
        description:
          "Official Aider CLI with streamed text, file edits and separate Cognia session histories.",
        protocol: "aider-cli",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "bypassPermissions",
        tags: ["coding", "aider", "cli"],
        docsUrl: "https://aider.chat/docs/install.html",
        setupHint:
          "Install Aider in an isolated Python 3.12 environment using uv tool install --force --python python3.12 --with pip aider-chat==0.86.2. Set --model and the provider API key in Cognia. Native .aider.conf.yml and .env discovery is isolated. Confirmations are automatic inside the mandatory host sandbox; Plan uses ask mode and dry-run. There are no native ACP approvals, MCP or structured tool events. Cognia removes its saved configuration and selected session history, never the system installation.",
        envVarHint:
          "For DeepSeek: --model deepseek/deepseek-flash with DEEPSEEK_API_KEY. Other providers use their Aider model identifier and provider key.",
        process: { command: "aider", args: [] },
      },
    ],
  },
  qoder: {
    id: "qoder",
    name: "Qoder",
    description: "Qoder over its official ACP server",
    docsUrl: "https://docs.qoder.com/cli/acp",
    tags: ["coding", "qoder", "acp"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "qoder",
        name: "Qoder",
        description:
          "Run Qoder over native ACP with streamed replies, tool approval and per-session MCP servers.",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "qoder", "acp"],
        docsUrl: "https://docs.qoder.com/cli/acp",
        setupHint:
          "Install with curl -fsSL https://qoder.com/install | bash. Run qoder login, or supply QODER_PERSONAL_ACCESS_TOKEN locally. Cognia uses native ACP, explicit default permissions and per-session MCP; background auto-update is disabled for this process. Update separately with qoder update. Removing an agent keeps your system installation and Qoder data. Windows hosting is unavailable in Cognia's strict sandbox.",
        envVarHint:
          "Use your existing Qoder CLI login, or QODER_PERSONAL_ACCESS_TOKEN. QODER_CONFIG_DIR selects a separate configuration directory. A provider API key alone does not replace Qoder authentication; BYOK availability depends on your Qoder account.",
        process: {
          command: "qoder",
          args: [
            "--acp",
            "--permission-mode",
            "default",
            "--strict-mcp-config",
            "--settings",
            '{"general":{"enableAutoUpdate":false}}',
          ],
        },
      },
    ],
  },
  goose: {
    id: "goose",
    name: "Goose",
    description: "AAIF Goose over native ACP",
    docsUrl: "https://goose-docs.ai/docs/gdk/acp/",
    tags: ["coding", "goose", "aaif"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "goose",
        name: "Goose",
        description:
          "Run Goose through its native ACP server with its developer extension and Cognia tools.",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "goose", "acp"],
        docsUrl: "https://goose-docs.ai/docs/gdk/acp/",
        setupHint:
          "Install Goose with `brew install block-goose-cli` on macOS, or the official CLI installer on Linux. Run `goose configure` to choose a provider and model, or set GOOSE_PROVIDER, GOOSE_MODEL, and the provider API key in this agent's environment. Update with your package manager or `goose update`. Cognia removes saved configurations, never your system installation.",
        envVarHint:
          "GOOSE_PROVIDER, GOOSE_MODEL, and the chosen provider's API key (for example OPENAI_API_KEY or ANTHROPIC_API_KEY). Existing Goose configuration is also supported.",
        process: {
          command: "goose",
          args: ["acp", "--with-builtin", "developer"],
          // Goose defaults to auto mode. Keep tool approval in the ACP client.
          env: { GOOSE_MODE: "approve" },
        },
        icon: "goose",
      },
    ],
  },
  devin: {
    id: "devin",
    name: "Devin",
    description: "Cognition Devin CLI over native ACP",
    docsUrl: "https://docs.devin.ai/cli/acp/jetbrains",
    tags: ["coding", "cognition", "devin"],
    surfaces: [
      {
        id: "acp-stdio",
        presetId: "devin",
        name: "Devin CLI",
        description:
          "Run Devin through its native ACP server using your existing CLI login. Select models, including SWE-2, after connecting. Cognia tools are available in each conversation alongside Devin’s native tools.",
        protocol: "acp",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "cognition", "devin", "acp"],
        docsUrl: "https://docs.devin.ai/cli/acp/jetbrains",
        setupHint:
          "Install Devin CLI and run `devin auth login` once. Cognia launches `devin acp` and discovers models from the session; use `acp --model swe2` to select SWE-2 at launch. Choose Accept Edits (Code) for file changes. Cognia tools are available in each conversation alongside Devin’s native tools.",
        process: { command: "devin", args: ["acp"] },
      },
    ],
  },
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
        docsUrl: "https://github.com/agentclientprotocol/codex-acp",
        envVarHint:
          "Supports ChatGPT sign-in or API-key auth through the local adapter route. Common automation setup uses OPENAI_API_KEY or CODEX_API_KEY.",
        setupHint:
          "Requires the installed `codex-acp` binary from @agentclientprotocol/codex-acp on PATH. Cognia checks executable identity and version through runtime inspection.",
        process: {
          command: "codex-acp",
          args: [],
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
        docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
        envVarHint:
          "Reuses your active Claude subscription (Claude Code sign-in) or ANTHROPIC_API_KEY automatically.",
        setupHint:
          "Requires the official Claude Agent ACP adapter (`npm install -g @agentclientprotocol/claude-agent-acp`); Cognia launches the installed binary without an on-demand network fetch.",
        process: {
          command: "claude-agent-acp",
          args: [],
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
        envVarHint:
          "Authenticate Gemini CLI with a Gemini API key, Vertex AI, gateway, or enterprise Code Assist credentials; GOOGLE_API_KEY is one supported path, not a universal requirement.",
        setupHint:
          "Requires the installed `gemini` binary from @google/gemini-cli on PATH and launches `gemini --acp`. Runtime inspection checks the installed executable and version.",
        process: {
          command: "gemini",
          args: ["--acp"],
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
          "Authenticates via COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN (fine-grained PAT with Copilot Requests permission), or run `copilot` once and use /login.",
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
        setupHint:
          "Requires the installed `qwen` binary from @qwen-code/qwen-code on PATH. Launches `qwen --acp` using the inspected executable and version.",
        process: {
          command: "qwen",
          args: ["--acp"],
        },
        icon: "qwen",
      },
    ],
  },
  pi: {
    id: "pi",
    name: "Pi",
    description: "Pi coding agent surfaces (native RPC)",
    docsUrl: "https://pi.dev/docs/latest/rpc",
    tags: ["coding", "pi"],
    surfaces: [
      {
        // Native first-party surface: Cognia drives `pi --mode rpc` directly
        // over Pi's own JSONL command/event protocol. No ACP anywhere in the
        // path, so thinking levels, the steering/follow-up queues, compaction
        // lifecycle, session tree/fork and usage detail all survive instead of
        // being flattened into ACP's smaller vocabulary.
        id: "rpc-stdio",
        presetId: "pi-rpc",
        name: "Pi (native RPC)",
        description: "Pi coding agent over its native `pi --mode rpc` protocol",
        protocol: "pi-rpc",
        transport: "stdio",
        supportTier: "executable",
        executionMode: "direct",
        defaultPermissionMode: "default",
        tags: ["coding", "pi", "native", "preview"],
        docsUrl: "https://pi.dev/docs/latest/rpc",
        setupHint:
          "Requires Pi 1.0.2 (`npm install -g @earendil-works/pi-coding-agent@1.0.2`) on PATH and Node.js >= 22.19.0. Pi owns its own provider credentials in ~/.pi — Cognia never reads or injects them. Newer Pi versions run but are reported as unverified.",
        limitationNote:
          "Preview surface. macOS and Linux only: external agents always run inside the strict sandbox and there is no unsandboxed fallback.",
        process: {
          command: "pi",
          args: ["--mode", "rpc"],
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
          args: ["exec", "--output-format", "acp-daemon"],
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
        docsUrl: "https://docs.cursor.com/en/cli/acp",
        setupHint:
          "Install Cursor CLI and ensure `cursor-agent` is on PATH; Cognia launches its ACP server via `cursor-agent acp`.",
        process: {
          command: "cursor-agent",
          args: ["acp"],
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
  const canonicalPresetId = presetId === "codex-acp" ? "codex" : presetId
  for (const adapter of listExternalAgentEcosystemAdapters()) {
    const surface = adapter.surfaces.find((item) => item.presetId === canonicalPresetId)
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
