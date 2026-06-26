/**
 * Skills hooks barrel.
 *
 * Skill list / filtering, AI rewrite assistant, analytics dashboard,
 * marketplace browser, and native sync.
 */

export { useSkills, type SkillsView } from "./use-skills"
export { useSkillAi, type UseSkillAi } from "./use-skill-ai"
export { useSkillAnalytics, type SkillAnalytics } from "./use-skill-analytics"
export {
  useSkillMarketplace,
  type AuditEntry,
  type FileTreeEntry,
  type MarketplaceSourceFilter,
  type MarketplaceView,
  type UseSkillMarketplace,
} from "./use-skill-marketplace"
export { useSkillUpdate, type UseSkillUpdate } from "./use-skill-update"
export { URL_INSTALL_INVALID, useUrlInstall, type UseUrlInstall } from "./use-url-install"
export { useSkillSync, type UseSkillSync } from "./use-skill-sync"
export { useSkillValidation } from "./use-skill-validation"
export { useSkillShortcuts } from "./use-skill-shortcuts"
export { useSkillRecording, type UseSkillRecording } from "./use-skill-recording"
export { useSkillGeneration, type UseSkillGeneration } from "./use-skill-generation"
export {
  useEffectiveSkills,
  type EffectiveSkillItem,
  type EffectiveSkillsView,
} from "./use-effective-skills"
