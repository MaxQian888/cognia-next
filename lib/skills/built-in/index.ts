/**
 * Built-in skill tier — public surface (ADR-0026).
 *
 * Importing this module triggers registration of every skill in the
 * tier via the per-family side-effect imports below. The build-options
 * resolver imports this module so the registry is fully populated
 * before the first manifest build.
 *
 * Add new skills under `lib/skills/built-in/<family>/<skill>.ts` and
 * `import "./<family>/<skill>"` here.
 */

// Re-exports — the only entry points consumers should use.
export {
  registerBuiltInSkill,
  getSharedBuiltInSkillRegistry,
  createBuiltInSkillRegistry,
  __resetSharedBuiltInSkillRegistry,
} from "./registry"
export type { BuiltInSkillRegistry } from "./registry"
export type {
  BuiltInSkill,
  BuiltInSkillContext,
  BuiltInSkillImAccess,
  BuiltInSkillMutation,
  BuiltInSkillResult,
  BilingualString,
  PlatformSkillCapability,
} from "./types"
export {
  buildBuiltInSkillManifest,
  summariseSkillCapabilities,
  BUILTIN_SKILLS_PLUGIN_ID,
} from "./manifest"
export type { BuildBuiltInSkillManifestInput, BuiltInSkillManifestEntry } from "./manifest"
export { runBuiltInSkill } from "./dispatcher"

// ---- Module-load registration side-effects --------------------------------
//
// Each per-family module calls `registerBuiltInSkill()` at module load.
// Add new families here as they ship. Order is irrelevant — the registry
// is map-backed.

// Lark family — wired in A3.
import "./lark"
// Platform-neutral im.* chat-management family — W2 multi-bot. Gated by
// adapter capability flags (`chat.create` …) via each skill's `requires`.
import "./im"
// Desktop-only, workspace-confined plugin conversion tools.
import "./plugin-conversion"
