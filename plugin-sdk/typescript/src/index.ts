/**
 * `@cognia/plugin-sdk` — root barrel.
 *
 * Convenience surface that re-exports every subpath. Plugin authors who
 * want to pick a single import path can write
 *   import { definePlugin, defineNativeAnthropicTool } from "@cognia/plugin-sdk"
 * but the recommended pattern is to import from the specific subpath
 * (`@cognia/plugin-sdk/manifest`, `/context`, `/api/...`, etc.) so the
 * bundled type surface stays narrow.
 *
 * The SDK contains no original logic — every symbol below is a re-export
 * from `lib/plugin/sdk/`, `lib/plugin/registries/`, `lib/plugin/messaging/`,
 * `lib/plugin/contracts/plugin-points.ts`, or the canonical type tree
 * under `types/plugin/`. See `README.md` for the subpath table.
 */

export * from "./manifest"
export * from "./context"
export * from "./api/native-anthropic-tool"
export * from "./api/skill"
export * from "./api/mcp-server-preset"
export * from "./api/character-pack"
export * from "./api/workflow"
export * from "./events"
export * from "./hooks"
export * from "./permissions"
export * from "./extensions"
