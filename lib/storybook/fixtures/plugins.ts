// Storybook-only fixtures for the plugin subsystem. A single `makePluginRow`
// builder produces a full `PluginRow` (the Dexie shape the plugin manager
// treats as authoritative), with a rich `manifest` blob so detail surfaces
// that read manifest fields (permissions, capabilities, config schema,
// contributions, signature, dependencies) all have something to paint.
//
// Stories that read plugins via Dexie live queries seed rows with
// `seedDb(async (db) => { await db.plugins.bulkPut(samplePluginRows()) })`.
import type { PluginRow } from "@/lib/db/plugin-types"
import type {
  MarketplaceSourceItem,
  MarketplaceSourcePreview,
  RecommendedMarketplaceSource,
} from "@/components/plugins/marketplace/sources/types"

/** A full, realistic installed-plugin row. Override any field per story. */
export function makePluginRow(over: Partial<PluginRow> = {}): PluginRow {
  return {
    id: "com.acme.web-tools",
    name: "Web Tools",
    version: "2.1.0",
    status: "enabled",
    source: "marketplace",
    type: "frontend",
    enabled: true,
    capabilities: ["tools", "commands", "mcp"],
    path: "/plugins/web-tools",
    manifest: {
      id: "com.acme.web-tools",
      name: "Web Tools",
      version: "2.1.0",
      icon: "🌐",
      description:
        "Fetch pages, extract readable content, and run lightweight scrapes straight from chat.",
      author: { name: "Acme Labs" },
      homepage: "https://example.com/web-tools",
      repository: "https://github.com/acme/web-tools",
      license: "MIT",
      permissions: ["network:fetch", "clipboard:read"],
      optionalPermissions: ["filesystem:write"],
      permissionJustifications: {
        "network:fetch": "Fetch the pages you ask about.",
      },
      capabilities: ["tools", "commands", "mcp"],
      contributes: { tools: {}, commands: {} },
      activationEvents: ["onCommand:web.fetch"],
      configSchema: {
        type: "object",
        properties: {
          apiBase: { type: "string", title: "API base URL", default: "https://api.example.com" },
          maxResults: { type: "number", title: "Max results", default: 10 },
          verbose: { type: "boolean", title: "Verbose logging", default: false },
        },
      },
      dependencies: { "com.cognia.core": "^1.0.0" },
      signature: { verified: true },
    },
    createdAt: Date.parse("2025-01-10T08:00:00.000Z"),
    updatedAt: Date.parse("2025-06-01T12:30:00.000Z"),
    lastUsedAt: Date.parse("2025-06-20T09:15:00.000Z"),
    readme:
      "## Web Tools\n\nFetch and parse pages directly from chat.\n\n- Readable extraction\n- Lightweight scrapes",
    licenseText: undefined,
    ...over,
  }
}

/** A small mixed set covering enabled / disabled / errored states. */
export function samplePluginRows(): PluginRow[] {
  return [
    makePluginRow(),
    makePluginRow({
      id: "com.acme.screenshot",
      name: "Screenshot",
      version: "1.0.3",
      enabled: false,
      status: "disabled",
      capabilities: ["tools"],
      source: "builtin",
      manifest: {
        id: "com.acme.screenshot",
        name: "Screenshot",
        icon: "📸",
        description: "Capture the screen and attach it to chat.",
        permissions: ["automation:screenshot"],
        signature: { verified: true },
      },
    }),
    makePluginRow({
      id: "com.acme.ocr",
      name: "OCR Engine",
      version: "0.9.1",
      status: "error",
      type: "python",
      enabled: true,
      error: "Failed to load runtime: python interpreter not found",
      capabilities: ["tools", "modes"],
      manifest: {
        id: "com.acme.ocr",
        name: "OCR Engine",
        description: "On-device OCR over images and PDFs.",
        permissions: ["filesystem:read", "python:execute"],
        pythonDependencies: ["pillow", "pytesseract"],
        requires: { binaries: [{ name: "tesseract", minVersion: "5.0" }] },
      },
    }),
  ]
}

/**
 * A previewed marketplace catalog — what the add-source dialog shows before
 * anything is persisted. Twelve entries so the "…and N more" expander has
 * something to expand.
 */
export function sampleSourcePreview(
  over: Partial<MarketplaceSourcePreview> = {}
): MarketplaceSourcePreview {
  const names: Array<[string, string, string]> = [
    ["web-tools", "1.2.0", "Fetch pages and extract readable content."],
    ["ocr-pro", "0.4.1", "On-device OCR over images and PDFs."],
    ["clipboard-x", "2.0.0", "Searchable clipboard history with pinning."],
    ["shell-runner", "1.1.4", "Run shell commands from chat with approval."],
    ["gh-triage", "0.7.2", "Triage GitHub issues and draft replies."],
    ["notion-sync", "3.0.1", "Two-way sync between notes and Notion."],
    ["figma-peek", "0.2.0", "Inspect Figma frames without leaving chat."],
    ["sql-lens", "1.5.0", "Explain and lint SQL against a live schema."],
    ["pdf-split", "0.9.0", "Split, merge, and reorder PDF pages."],
    ["translate-kit", "2.2.3", "Batch translation with a glossary."],
    ["mermaid-fix", "0.3.1", "Repair malformed mermaid diagrams."],
    ["cron-buddy", "1.0.0", "Explain and build cron expressions."],
  ]
  return {
    id: "acme/plugins",
    name: "Acme Plugins",
    owner: "Acme Labs",
    catalogPath: ".claude-plugin/marketplace.json",
    repoUrl: "https://github.com/acme/plugins",
    alreadyAdded: false,
    entries: names.map(([name, version, description]) => ({
      id: `acme/plugins:${name}`,
      name,
      version,
      description,
    })),
    ...over,
  }
}

/** Saved sources covering every sync state the row can render. */
export function sampleMarketplaceSources(): MarketplaceSourceItem[] {
  const now = Date.now()
  return [
    {
      id: "cognia/community-plugins",
      name: "Cognia Community",
      repoRef: "cognia/community-plugins",
      repoUrl: "https://github.com/cognia/community-plugins",
      sync: { kind: "ok", pluginCount: 8, lastSyncedAt: now - 2 * 60_000 },
    },
    {
      id: "acme/plugins",
      name: "Acme Plugins",
      repoRef: "github.com/acme/plugins",
      repoUrl: "https://github.com/acme/plugins",
      sync: { kind: "syncing" },
    },
    {
      id: "beta/labs@next",
      name: "Beta Labs",
      repoRef: "beta/labs@next",
      repoUrl: "https://github.com/beta/labs/tree/next",
      sync: {
        kind: "error",
        message: "GitHub API 403 for marketplace.json (rate limit)",
        lastSyncedAt: now - 26 * 60 * 60_000,
      },
    },
    {
      id: "solo/first-marketplace",
      name: "solo/first-marketplace",
      repoRef: "solo/first-marketplace",
      repoUrl: "https://github.com/solo/first-marketplace",
      sync: { kind: "never" },
    },
  ]
}

/**
 * Placeholder curated marketplaces for the empty state. These repo references
 * are illustrative — the shipped list lives in
 * `lib/plugin/package/recommended-marketplace-sources.ts` and is empty until
 * real repositories exist.
 */
export function sampleRecommendedSources(): RecommendedMarketplaceSource[] {
  return [
    {
      repoRef: "cognia/plugins",
      name: "Cognia official plugins",
      description: "First-party plugins maintained alongside the app.",
    },
    {
      repoRef: "cognia/community-plugins",
      name: "Community picks",
      description: "Community-built plugins reviewed for basic quality.",
    },
  ]
}
