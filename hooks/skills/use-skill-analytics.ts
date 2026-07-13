"use client"

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listSkills } from "@/lib/db/skills"
import { inferCategory, inferSource } from "@/lib/db/skills"
import type { Skill, SkillCategory, SkillSource } from "@cognia/agent-config-types"

export interface SkillAnalytics {
  loading: boolean
  totalSkills: number
  totalEnabled: number
  totalUsage: number
  /** Heuristic: characters → tokens at 4:1. Captures ballpark, not exact. */
  estimatedTokens: number
  mostUsed: Skill[]
  neverUsed: Skill[]
  recentlyUsed: Skill[]
  byCategory: Array<{ category: SkillCategory; count: number; usage: number }>
  bySource: Array<{ source: SkillSource; count: number; usage: number }>
  /** Daily-bucketed usage for the last 30 days, oldest → newest. */
  usageByDay: Array<{ date: string; count: number }>
}

const TOP_LIMIT = 8
const RECENT_LIMIT = 8

export function useSkillAnalytics(): SkillAnalytics {
  const rows = useLiveQuery(() => listSkills(), [])
  return useMemo(() => buildAnalytics(rows), [rows])
}

function buildAnalytics(rows: Skill[] | undefined): SkillAnalytics {
  if (rows === undefined) {
    return {
      loading: true,
      totalSkills: 0,
      totalEnabled: 0,
      totalUsage: 0,
      estimatedTokens: 0,
      mostUsed: [],
      neverUsed: [],
      recentlyUsed: [],
      byCategory: [],
      bySource: [],
      usageByDay: [],
    }
  }
  const totalSkills = rows.length
  let totalEnabled = 0
  let totalUsage = 0
  let estimatedTokens = 0
  const byCategory = new Map<SkillCategory, { count: number; usage: number }>()
  const bySource = new Map<SkillSource, { count: number; usage: number }>()
  for (const r of rows) {
    if ((r.status ?? "enabled") === "enabled") totalEnabled += 1
    totalUsage += r.usageCount ?? 0
    estimatedTokens += Math.ceil((r.content?.length ?? 0) / 4)
    const cat = inferCategory(r)
    const src = inferSource(r)
    const cBucket = byCategory.get(cat) ?? { count: 0, usage: 0 }
    cBucket.count += 1
    cBucket.usage += r.usageCount ?? 0
    byCategory.set(cat, cBucket)
    const sBucket = bySource.get(src) ?? { count: 0, usage: 0 }
    sBucket.count += 1
    sBucket.usage += r.usageCount ?? 0
    bySource.set(src, sBucket)
  }
  const mostUsed = [...rows]
    .filter((r) => (r.usageCount ?? 0) > 0)
    .sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0))
    .slice(0, TOP_LIMIT)
  const neverUsed = rows.filter((r) => (r.usageCount ?? 0) === 0)
  const recentlyUsed = [...rows]
    .filter((r) => r.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, RECENT_LIMIT)

  return {
    loading: false,
    totalSkills,
    totalEnabled,
    totalUsage,
    estimatedTokens,
    mostUsed,
    neverUsed,
    recentlyUsed,
    byCategory: Array.from(byCategory.entries())
      .map(([category, v]) => ({ category, count: v.count, usage: v.usage }))
      .sort((a, b) => b.usage - a.usage),
    bySource: Array.from(bySource.entries())
      .map(([source, v]) => ({ source, count: v.count, usage: v.usage }))
      .sort((a, b) => b.usage - a.usage),
    usageByDay: bucketUsageByDay(rows),
  }
}

/**
 * Project lastUsedAt timestamps onto the last 30 calendar days. Newer days
 * inherit the skill's full usageCount (we lack per-day granularity); older
 * days stay zero. Good enough for a sparkline.
 */
function bucketUsageByDay(rows: Skill[]): Array<{ date: string; count: number }> {
  const days: { date: string; count: number }[] = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    days.push({ date: d.toISOString().slice(0, 10), count: 0 })
  }
  const indexByDate = new Map(days.map((d, i) => [d.date, i]))
  for (const s of rows) {
    if (!s.lastUsedAt) continue
    const d = new Date(s.lastUsedAt)
    d.setHours(0, 0, 0, 0)
    const key = d.toISOString().slice(0, 10)
    const idx = indexByDate.get(key)
    if (idx !== undefined) days[idx].count += s.usageCount ?? 1
  }
  return days
}
