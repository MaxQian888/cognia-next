// Curated catalog of well-known MCP servers, used to populate the "Add server"
// gallery. Each preset pre-fills name/transport/config and lists the env vars
// or args the user must fill in. The catalog stays editable in code, not the
// database — built-in presets shouldn't take up storage space and should
// version with the app.

import type { McpTransport } from "./types"

export interface McpPresetField {
  /** The key under which the user's value lives. For env vars: env name. */
  key: string
  label: string
  /** Where this value plugs into the config: env var or args index. */
  placement: "env" | "arg-replace"
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
    id: "github",
    name: "GitHub",
    description: "Read repos, files, issues, and PRs through the GitHub API.",
    icon: "🐙",
    transport: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    },
    fields: [
      {
        key: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "Personal access token",
        placement: "env",
        secret: true,
        description: "Create at github.com/settings/tokens. Needs at least 'repo' scope.",
      },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
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
      args: ["-y", "@modelcontextprotocol/server-gitlab"],
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
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab",
    tags: ["dev"],
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web search via the Brave Search API.",
    icon: "🦁",
    transport: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-brave-search"],
      env: { BRAVE_API_KEY: "" },
    },
    fields: [
      {
        key: "BRAVE_API_KEY",
        label: "Brave API key",
        placement: "env",
        secret: true,
        description: "Get one free at api.search.brave.com.",
      },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    tags: ["search"],
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Browse and scrape the web with a headless browser.",
    icon: "🎭",
    transport: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    },
    fields: [],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
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
    id: "postgres",
    name: "Postgres",
    description: "Read-only access to a Postgres database.",
    icon: "🐘",
    transport: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", "<DATABASE_URL>"],
    },
    fields: [
      {
        key: "DATABASE_URL",
        label: "Database URL",
        placement: "arg-replace",
        token: "<DATABASE_URL>",
        placeholder: "postgresql://user:pass@localhost:5432/db",
        secret: true,
      },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    tags: ["data"],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Read channels, search messages, post replies.",
    icon: "💬",
    transport: "stdio",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
    },
    fields: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "Bot token",
        placement: "env",
        secret: true,
        placeholder: "xoxb-…",
      },
      {
        key: "SLACK_TEAM_ID",
        label: "Team ID",
        placement: "env",
        placeholder: "T0123ABCD",
      },
    ],
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
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
 * Apply the user's field values to a preset's config. Replaces arg tokens and
 * fills env vars. Returns a fresh config object — does NOT mutate the preset.
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
    }
  }
  return config
}

/** Find a preset by id. Returns undefined for unknown ids. */
export function getPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id)
}
