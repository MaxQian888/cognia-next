"use client"

import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { useSkillAnalytics } from "@/hooks/skills"
import { getCategoryMeta, getSourceMeta } from "@/lib/skills/categories"
import { useSkillsStore } from "@/stores/skills"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { SkillUsageTrend } from "./skill-usage-trend"

export function SkillAnalytics() {
  const t = useTranslations("skills.analytics")
  const tCat = useTranslations("skills.category")
  const tSrc = useTranslations("skills.source")
  const data = useSkillAnalytics()
  const openDetail = useSkillsStore((s) => s.openDetail)
  const reduce = useReducedMotion()

  if (data.loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-12 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        {t("loading")}
      </div>
    )
  }

  const categoryRows = data.byCategory.map((row) => {
    const meta = getCategoryMeta(row.category)
    return {
      key: row.category,
      label: tCat(meta.labelKey as never),
      count: row.count,
      usage: row.usage,
    }
  })

  return (
    <ScrollArea className="flex-1">
      <div className="space-y-4 p-3 sm:p-4">
        <motion.div
          className="grid grid-cols-2 gap-3 md:grid-cols-4"
          initial={reduce ? false : "initial"}
          animate="animate"
          variants={STAGGER_CONTAINER}
        >
          <motion.div variants={STAGGER_CHILD}>
            <SummaryCard label={t("totalSkills")} value={data.totalSkills} />
          </motion.div>
          <motion.div variants={STAGGER_CHILD}>
            <SummaryCard label={t("totalEnabled")} value={data.totalEnabled} />
          </motion.div>
          <motion.div variants={STAGGER_CHILD}>
            <SummaryCard label={t("totalUsage")} value={data.totalUsage} />
          </motion.div>
          <motion.div variants={STAGGER_CHILD}>
            <SummaryCard
              label={t("tokensEstimated")}
              value={data.estimatedTokens.toLocaleString()}
            />
          </motion.div>
        </motion.div>

        <SkillUsageTrend />

        <Card className="border-border/50 bg-card/80 p-4 backdrop-blur">
          <p className="mb-2 text-xs font-medium">{t("categoryUsageTitle")}</p>
          {categoryRows.length > 0 ? (
            <div className="h-56">
              {/* Seed a positive initial size (height matches the h-56 = 224px
                  box) so the chart never renders at recharts' default {-1,-1}
                  on mount — which logs "width(-1)/height(-1)" and flashes empty
                  for a frame on every skills-tab remount (tab-switch jitter). */}
              <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={1}
                minHeight={1}
                initialDimension={{ width: 320, height: 224 }}
              >
                <BarChart data={categoryRows}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11 }}
                    interval={0}
                    angle={-15}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      fontSize: "11px",
                      borderRadius: "6px",
                    }}
                  />
                  <Bar dataKey="usage" fill="hsl(var(--primary))" radius={4} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("neverUsedEmpty")}</p>
          )}
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="border-border/50 bg-card/80 p-4 backdrop-blur">
            <p className="mb-2 text-xs font-medium">{t("mostUsedTitle")}</p>
            {data.mostUsed.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("neverUsedEmpty")}</p>
            ) : (
              <ul className="space-y-1.5">
                {data.mostUsed.map((skill) => {
                  const cat = getCategoryMeta(skill.category)
                  const Icon = cat.icon
                  return (
                    <li key={skill.id}>
                      <button
                        type="button"
                        onClick={() => openDetail(skill.id)}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                      >
                        <span
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded ${cat.color}`}
                        >
                          <Icon className="size-3" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                        <Badge variant="outline" className="h-5 text-[10px]">
                          {skill.usageCount ?? 0}
                        </Badge>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          <Card className="border-border/50 bg-card/80 p-4 backdrop-blur">
            <p className="mb-2 text-xs font-medium">{t("recentUsageTitle")}</p>
            {data.recentlyUsed.length === 0 ? (
              <p className="text-xs text-muted-foreground">—</p>
            ) : (
              <ul className="space-y-1.5">
                {data.recentlyUsed.map((skill) => (
                  <li key={skill.id}>
                    <button
                      type="button"
                      onClick={() => openDetail(skill.id)}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                    >
                      <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {skill.lastUsedAt ? new Date(skill.lastUsedAt).toLocaleString() : "—"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {data.neverUsed.length > 0 && (
          <Card className="border-border/50 bg-card/80 p-4 backdrop-blur">
            <p className="mb-2 text-xs font-medium">{t("neverUsedTitle")}</p>
            <ul className="grid gap-1 sm:grid-cols-2">
              {data.neverUsed.map((skill) => {
                const src = getSourceMeta(skill.source)
                return (
                  <li key={skill.id}>
                    <button
                      type="button"
                      onClick={() => openDetail(skill.id)}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent"
                    >
                      <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                      <Badge variant={src.badgeVariant} className="h-5 text-[10px]">
                        {tSrc(src.labelKey as never)}
                      </Badge>
                    </button>
                  </li>
                )
              })}
            </ul>
          </Card>
        )}
      </div>
    </ScrollArea>
  )
}

function SummaryCard({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="border-border/50 bg-card/80 p-3 backdrop-blur">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </Card>
  )
}
