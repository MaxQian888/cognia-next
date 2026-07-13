// Skill categories — icon + color + i18n key for each. Mirrors Cognia's
// `components/skills/skill-constants.tsx` so skills roundtrip 1:1 between
// the two apps. The label keys live under the i18n `skills.*` namespace.

import {
  Brain,
  Briefcase,
  Code2,
  Database,
  MessageCircle,
  Package,
  Palette,
  Sparkles,
  type LucideIcon,
} from "lucide-react"
import type { SkillCategory, SkillSource } from "@cognia/agent-config-types"

export interface CategoryMeta {
  id: SkillCategory
  /** i18n key under `skills.category.<key>` */
  labelKey: string
  /** Tailwind classname snippet for chip / icon background. */
  color: string
  icon: LucideIcon
}

export const SKILL_CATEGORIES: CategoryMeta[] = [
  {
    id: "creative-design",
    labelKey: "creativeDesign",
    color: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
    icon: Palette,
  },
  {
    id: "development",
    labelKey: "development",
    color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    icon: Code2,
  },
  {
    id: "enterprise",
    labelKey: "enterprise",
    color: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    icon: Briefcase,
  },
  {
    id: "productivity",
    labelKey: "productivity",
    color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    icon: Package,
  },
  {
    id: "data-analysis",
    labelKey: "dataAnalysis",
    color: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    icon: Database,
  },
  {
    id: "communication",
    labelKey: "communication",
    color: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    icon: MessageCircle,
  },
  {
    id: "meta",
    labelKey: "meta",
    color: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
    icon: Brain,
  },
  {
    id: "custom",
    labelKey: "custom",
    color: "bg-muted text-muted-foreground",
    icon: Sparkles,
  },
]

const CATEGORY_BY_ID = new Map<SkillCategory, CategoryMeta>(SKILL_CATEGORIES.map((c) => [c.id, c]))

export function getCategoryMeta(id: SkillCategory | undefined): CategoryMeta {
  return CATEGORY_BY_ID.get(id ?? "custom") ?? SKILL_CATEGORIES[7]
}

export interface SourceMeta {
  id: SkillSource
  labelKey: string
  badgeVariant: "default" | "secondary" | "outline" | "destructive"
}

export const SKILL_SOURCES: SourceMeta[] = [
  { id: "builtin", labelKey: "builtin", badgeVariant: "secondary" },
  { id: "custom", labelKey: "custom", badgeVariant: "outline" },
  { id: "imported", labelKey: "imported", badgeVariant: "outline" },
  { id: "generated", labelKey: "generated", badgeVariant: "default" },
  { id: "marketplace", labelKey: "marketplace", badgeVariant: "default" },
]

const SOURCE_BY_ID = new Map<SkillSource, SourceMeta>(SKILL_SOURCES.map((s) => [s.id, s]))

export function getSourceMeta(id: SkillSource | undefined): SourceMeta {
  return SOURCE_BY_ID.get(id ?? "custom") ?? SKILL_SOURCES[1]
}
