// Storybook-only fixtures for the plugin subsystem. A single `makePluginRow`
// builder produces a full `PluginRow` (the Dexie shape the plugin manager
// treats as authoritative), with a rich `manifest` blob so detail surfaces
// that read manifest fields (permissions, capabilities, config schema,
// contributions, signature, dependencies) all have something to paint.
//
// Stories that read plugins via Dexie live queries seed rows with
// `seedDb(async (db) => { await db.plugins.bulkPut(samplePluginRows()) })`.
import type { PluginRow } from "@/lib/db/plugin-types"

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
