/**
 * Top-level type barrel — used by upstream-style imports of `@/types`.
 *
 * Keep this slim; only re-export type modules we have definitions for.
 */

export * from "./agent"
export * from "./mcp"
export * from "./artifact"
export * from "./workspace"
export * from "./browser-developer"
export * from "./execution-context"
export * from "./project-environment"
export * from "./review"

// Plugin-facing chat session/message aliases. Plugin code imports these
// from `@/types` (the upstream Cognia surface) — they delegate to cognia-
// next's authoritative shapes so the two stay in lockstep. `Project` /
// `KnowledgeFile` are owned by `_compat.ts` for the same reason: a single
// source of truth shared by plugin runtime, plugin tests, and app code.
export type { Session, UIMessage, Project, KnowledgeFile } from "./plugin/_compat"

// `Skill` is intentionally NOT re-exported here. Always import it from
// `@cognia/agent-config-types` (cognia-next's authoritative shape) so we don't
// fork the model. See `lib/skills/executor.ts` for the bridge to the
// External Agent instruction stack.
