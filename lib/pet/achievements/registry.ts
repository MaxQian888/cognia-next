// Static achievement catalog. Each entry's `isUnlocked` is a pure predicate over
// a snapshot of the profile, recomputed bones, and ledger counters. New entries
// here automatically flow into the 图鉴/achievements UI and the check pass.

import type { PetAchievement } from "@/types/pet"

export const PET_ACHIEVEMENTS: PetAchievement[] = [
  {
    id: "hatched",
    i18nKey: "hatched",
    icon: "Egg",
    isUnlocked: (ctx) => ctx.profile.soul !== null,
  },
  {
    id: "first-xp",
    i18nKey: "firstXp",
    icon: "Sparkles",
    isUnlocked: (ctx) => ctx.profile.xp > 0,
  },
  {
    id: "juvenile",
    i18nKey: "juvenile",
    icon: "Sprout",
    isUnlocked: (ctx) => ctx.profile.level >= 5,
  },
  {
    id: "adult",
    i18nKey: "adult",
    icon: "TreePine",
    isUnlocked: (ctx) => ctx.profile.level >= 10,
  },
  {
    id: "elder",
    i18nKey: "elder",
    icon: "Crown",
    isUnlocked: (ctx) => ctx.profile.level >= 20,
  },
  {
    id: "well-fed",
    i18nKey: "wellFed",
    icon: "Cookie",
    isUnlocked: (ctx) => (ctx.counters.fed ?? 0) >= 50,
  },
  {
    id: "playful",
    i18nKey: "playful",
    icon: "Gamepad2",
    isUnlocked: (ctx) => (ctx.counters.played ?? 0) >= 50,
  },
  {
    id: "best-friends",
    i18nKey: "bestFriends",
    icon: "Heart",
    isUnlocked: (ctx) => ctx.profile.needs.bond >= 90,
  },
  {
    id: "goal-getter",
    i18nKey: "goalGetter",
    icon: "Target",
    isUnlocked: (ctx) => (ctx.counters.goalComplete ?? 0) >= 10,
  },
  {
    id: "shiny-owner",
    i18nKey: "shinyOwner",
    icon: "Stars",
    isUnlocked: (ctx) => ctx.bones.shiny,
  },
  {
    id: "legendary",
    i18nKey: "legendary",
    icon: "Gem",
    isUnlocked: (ctx) => ctx.bones.rarity === "legendary",
  },
  // ── Earned-growth + care milestones (effective stats / care condition) ──
  {
    id: "master-debugger",
    i18nKey: "masterDebugger",
    icon: "Bug",
    isUnlocked: (ctx) => ctx.effectiveStats.debugging >= 100,
  },
  {
    id: "zen-master",
    i18nKey: "zenMaster",
    icon: "Hourglass",
    isUnlocked: (ctx) => ctx.effectiveStats.patience >= 100,
  },
  {
    id: "chaos-gremlin",
    i18nKey: "chaosGremlin",
    icon: "Zap",
    isUnlocked: (ctx) => ctx.effectiveStats.chaos >= 100,
  },
  {
    id: "nursed-back",
    i18nKey: "nursedBack",
    icon: "HeartPulse",
    isUnlocked: (ctx) => ctx.care.condition === "well" && ctx.care.everUnwell,
  },
  {
    id: "devoted-caretaker",
    i18nKey: "devotedCaretaker",
    icon: "HandHeart",
    isUnlocked: (ctx) => ctx.care.careQuality >= 80,
  },
]

export function getAchievement(id: string): PetAchievement | undefined {
  return PET_ACHIEVEMENTS.find((a) => a.id === id)
}
