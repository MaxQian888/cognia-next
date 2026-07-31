/**
 * web-clone library entry (cognia sidecar vendored build)
 *
 * Provides two APIs:
 * 1. snapshot()            - basic snapshot (HTTP direct pull)
 * 2. convertLocalSnapshot() - component extraction + codegen on an existing local output
 *
 * The upstream Playwright-backed APIs (snapshotWithPlaywright /
 * snapshotWithBrowserContext) are intentionally dropped in this vendored build:
 * the sidecar has no Playwright dependency. See VENDOR.md.
 */

// Core Snapshot API
export { snapshot, convertLocalSnapshot } from "./assembler.js"

// Core type
export type {
  SnapshotOptions,
  SnapshotResult,
  SnapshotMode,
  AssetType,
  AssetStatus,
  Asset,
  AssetRef,
  ComponentSpec,
  ComponentManifest,
  StateVariable,
  EventBinding,
  MethodSpec,
  MigrationTodo,
  ConvertResult,
  FrameworkCodeGenOptions,
  GeneratedComponent,
  GeneratedFramework,
} from "./types.js"

// Optional tool function export
export { parseHtml } from "./parser/html-parser.js"

// Canonical configuration surface consumed by the outer sidecar runner.
export {
  DEFAULTS,
  parseBool,
  parseCodegenFramework,
  parseFileSize,
  parseFrameworkHint,
  safeInt,
  validateOptions,
} from "./config/index.js"
export type { CodegenFramework, FrameworkHint } from "./config/index.js"

// SSRF guard (exported so the runner / tests can pre-validate the entry URL)
export {
  assertFetchTargetAllowed,
  evaluateFetchTarget,
  FetchTargetBlockedError,
} from "./ssrf-guard.js"
