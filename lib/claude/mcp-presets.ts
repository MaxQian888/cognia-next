// Curated catalog of well-known MCP servers, used to populate the "Add server"
// gallery. Each preset pre-fills name/transport/config and lists the env vars
// or args the user must fill in. The catalog stays editable in code, not the
// database — built-in presets shouldn't take up storage space and should
// version with the app.

import type { McpTransport } from "@cognia/agent-config-types"

export interface McpPresetField {
  /** The key under which the user's value lives. For env vars: env name.
   *  For headers: header name. For url: ignored (single field per preset). */
  key: string
  label: string
  /**
   * Where this value plugs into the config:
   *   - "env": stdio-only environment variable.
   *   - "arg-replace": stdio-only argv token swap.
   *   - "url": http/sse URL — replaces `config.url` directly.
   *   - "header": http/sse header — written under `config.headers[key]`.
   */
  placement: "env" | "arg-replace" | "url" | "header"
  /** When placement === "arg-replace", which token to swap (e.g. "<PATH>"). */
  token?: string
  description?: string
  placeholder?: string
  /** If true, render as a password field. */
  secret?: boolean
}

export interface McpPreset {
  id: string
  name: string
  description: string
  /** One- or two-letter glyph or emoji shown in the gallery card. */
  icon: string
  transport: McpTransport
  /** Default config — has placeholder tokens that fields above replace. */
  config: Record<string, unknown>
  /** Fields the user must fill in before save. */
  fields: McpPresetField[]
  /** Optional canonical docs URL. */
  docsUrl?: string
  tags?: string[]
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read/write files in directories you allow.",
    icon: "📁",
    transport: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "<PATH>"],
    },
    fields: [
      {
        key: "PATH",
        label: "Allowed directory",
        placement: "arg-replace",
        token: "<PATH>",
        placeholder: "/Users/me/projects",
        description: "Absolute path the server is allowed to access.",
      },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    tags: ["files"],
  },
  {
    // GitHub's own remote server. Replaces @modelcontextprotocol/server-github,
    // which npm now marks "no longer supported".
    id: "github",
    name: "GitHub",
    description: "Read repos, files, issues, and PRs through GitHub's official remote server.",
    icon: "🐙",
    transport: "http",
    config: {
      url: "https://api.githubcopilot.com/mcp/",
      headers: {} as Record<string, string>,
    },
    fields: [
      {
        key: "Authorization",
        label: "Authorization header",
        placement: "header",
        secret: true,
        placeholder: "Bearer ghp_…",
        description:
          "Create a token at github.com/settings/tokens and prefix it with 'Bearer '. Needs at least 'repo' scope.",
      },
    ],
    docsUrl: "https://github.com/github/github-mcp-server",
    tags: ["dev"],
  },
  {
    id: "gitlab",
    name: "GitLab",
    description: "Search and read GitLab projects, issues, and merge requests.",
    icon: "🦊",
    transport: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@zereight/mcp-gitlab"],
      env: { GITLAB_PERSONAL_ACCESS_TOKEN: "", GITLAB_API_URL: "https://gitlab.com/api/v4" },
    },
    fields: [
      {
        key: "GITLAB_PERSONAL_ACCESS_TOKEN",
        label: "Personal access token",
        placement: "env",
        secret: true,
      },
      {
        key: "GITLAB_API_URL",
        label: "API URL",
        placement: "env",
        description: "Override only for self-hosted GitLab.",
      },
    ],
    docsUrl: "https://github.com/zereight/gitlab-mcp",
    tags: ["dev"],
  },
  {
    // Brave's first-party package. Transport defaults to stdio, so no args.
    id: "brave-search",
    name: "Brave Search",
    description: "Web search via the Brave Search API.",
    icon: "🦁",
    transport: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server"],
      env: { BRAVE_API_KEY: "" },
    },
    fields: [
      {
        key: "BRAVE_API_KEY",
        label: "Brave API key",
        placement: "env",
        secret: true,
        description: "Get one free at api-dashboard.search.brave.com/app/keys.",
      },
    ],
    docsUrl: "https://github.com/brave/brave-search-mcp-server",
    tags: ["search"],
  },
  {
    // Replaces the deprecated @modelcontextprotocol/server-puppeteer.
    id: "playwright",
    name: "Playwright",
    description: "Browse, click, and scrape the web with a real browser.",
    icon: "🎭",
    transport: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
    },
    fields: [],
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    tags: ["web"],
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Fetch URLs and convert HTML to clean Markdown.",
    icon: "🔗",
    transport: "stdio",
    config: {
      command: "uvx",
      args: ["mcp-server-fetch"],
    },
    fields: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    tags: ["web"],
  },
  {
    id: "memory",
    name: "Memory",
    description: "Persistent knowledge graph across conversations.",
    icon: "🧠",
    transport: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
    fields: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    tags: ["state"],
  },
  {
    id: "sqlite",
    name: "SQLite",
    description: "Query an SQLite database file.",
    icon: "💾",
    transport: "stdio",
    config: {
      command: "uvx",
      args: ["mcp-server-sqlite", "--db-path", "<DB_PATH>"],
    },
    fields: [
      {
        key: "DB_PATH",
        label: "Database file",
        placement: "arg-replace",
        token: "<DB_PATH>",
        placeholder: "/Users/me/data.db",
      },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
    tags: ["data"],
  },
  {
    // Replaces the deprecated @modelcontextprotocol/server-postgres.
    // `restricted` keeps the connection read-only + transaction-scoped.
    id: "postgres",
    name: "Postgres",
    description: "Read-only access to a Postgres database, plus index/health analysis.",
    icon: "🐘",
    transport: "stdio",
    config: {
      command: "uvx",
      args: ["postgres-mcp", "--access-mode=restricted"],
      env: { DATABASE_URI: "" },
    },
    fields: [
      {
        key: "DATABASE_URI",
        label: "Database URL",
        placement: "env",
        placeholder: "postgresql://user:pass@localhost:5432/db",
        secret: true,
      },
    ],
    docsUrl: "https://github.com/crystaldba/postgres-mcp",
    tags: ["data"],
  },
  {
    // Replaces the deprecated @modelcontextprotocol/server-slack. Community-
    // maintained (not an official Slack product); xoxb bot token is the
    // supported path that matches the old preset's auth model.
    id: "slack",
    name: "Slack",
    description: "Read channels, search messages, post replies.",
    icon: "💬",
    transport: "stdio",
    config: {
      command: "npx",
      args: ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
      env: { SLACK_MCP_XOXB_TOKEN: "" },
    },
    fields: [
      {
        key: "SLACK_MCP_XOXB_TOKEN",
        label: "Bot token",
        placement: "env",
        secret: true,
        placeholder: "xoxb-…",
        description: "Slack bot token from your app's OAuth & Permissions page.",
      },
    ],
    docsUrl: "https://github.com/korotovsky/slack-mcp-server",
    tags: ["chat"],
  },
  {
    id: "time",
    name: "Time",
    description: "Time/date utilities and timezone conversions.",
    icon: "🕐",
    transport: "stdio",
    config: {
      command: "uvx",
      args: ["mcp-server-time"],
    },
    fields: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    tags: ["util"],
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    description:
      "Q&A over public GitHub repos (architecture, code paths, Why-this-decision). No auth needed.",
    icon: "📘",
    transport: "http",
    config: {
      url: "https://mcp.deepwiki.com/mcp",
    },
    fields: [],
    docsUrl: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    tags: ["docs", "search"],
  },
  {
    id: "http-generic",
    name: "Streamable HTTP server",
    description: "Connect to any HTTP MCP endpoint. Optional Bearer token under Authorization.",
    icon: "🌐",
    transport: "http",
    config: {
      url: "",
      headers: {} as Record<string, string>,
    },
    fields: [
      {
        key: "url",
        label: "Endpoint URL",
        placement: "url",
        placeholder: "https://example.com/mcp",
        description: "The streamable-HTTP MCP endpoint exposed by your service.",
      },
      {
        key: "Authorization",
        label: "Authorization header",
        placement: "header",
        placeholder: "Bearer …",
        secret: true,
        description: "Optional. Leave empty for unauthenticated servers.",
      },
    ],
    tags: ["custom", "http"],
  },
  {
    id: "sse-generic",
    name: "SSE server",
    description: "Connect to a server-sent-events MCP endpoint. Streams responses over SSE.",
    icon: "📡",
    transport: "sse",
    config: {
      url: "",
      headers: {} as Record<string, string>,
    },
    fields: [
      {
        key: "url",
        label: "Endpoint URL",
        placement: "url",
        placeholder: "https://example.com/sse",
      },
      {
        key: "Authorization",
        label: "Authorization header",
        placement: "header",
        placeholder: "Bearer …",
        secret: true,
        description: "Optional. Leave empty for unauthenticated servers.",
      },
    ],
    tags: ["custom", "sse"],
  },
  {
    id: "custom",
    name: "Custom server",
    description: "Configure any MCP server by hand. Skips the form.",
    icon: "⚙️",
    transport: "stdio",
    config: { command: "", args: [] },
    fields: [],
    tags: ["custom"],
  },
]

/**
 * Apply the user's field values to a preset's config. Replaces arg tokens,
 * fills env vars, and writes URL / header fields for http/sse presets.
 * Returns a fresh config object — does NOT mutate the preset.
 *
 * Empty values for `header` and `env` fields are skipped so we don't
 * persist stray `Authorization: ""` headers that some servers reject.
 */
export function applyPresetFields(
  preset: McpPreset,
  values: Record<string, string>
): Record<string, unknown> {
  // Deep-clone the config since we'll be mutating arrays and env maps.
  const config = JSON.parse(JSON.stringify(preset.config)) as Record<string, unknown>
  for (const field of preset.fields) {
    const value = values[field.key] ?? ""
    if (field.placement === "env") {
      const env = (config.env as Record<string, string>) ?? {}
      env[field.key] = value
      config.env = env
    } else if (field.placement === "arg-replace" && field.token) {
      const args = (config.args as unknown[]) ?? []
      config.args = args.map((a) => (typeof a === "string" ? a.replaceAll(field.token!, value) : a))
    } else if (field.placement === "url") {
      config.url = value
    } else if (field.placement === "header") {
      if (!value) continue
      const headers = (config.headers as Record<string, string>) ?? {}
      headers[field.key] = value
      config.headers = headers
    }
  }
  // Drop the empty `headers` map for cleanliness when the user filled none.
  if (config.headers && Object.keys(config.headers as Record<string, string>).length === 0) {
    delete config.headers
  }
  return config
}

/** Find a preset by id. Returns undefined for unknown ids. */
export function getPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id)
}
