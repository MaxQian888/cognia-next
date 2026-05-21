"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useSkillAnalytics } from "@/hooks/skills"

type WindowSize = "7" | "30"

export function SkillUsageTrend() {
  const t = useTranslations("skills.analytics.trend")
  const [windowSize, setWindowSize] = useState<WindowSize>("7")
  const { usageByDay } = useSkillAnalytics()
  const data = useMemo(() => {
    const slice = windowSize === "7" ? usageByDay.slice(-7) : usageByDay
    return slice.map((d) => ({ name: d.date.slice(5), count: d.count }))
  }, [usageByDay, windowSize])

  return (
    <div
      data-testid="skill-usage-trend"
      className="rounded-md border border-border/50 bg-card/80 p-4 backdrop-blur"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <ToggleGroup
          type="single"
          value={windowSize}
          onValueChange={(v) => v && setWindowSize(v as WindowSize)}
          size="sm"
        >
          <ToggleGroupItem value="7">{t("window7")}</ToggleGroupItem>
          <ToggleGroupItem value="30">{t("window30")}</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="name" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
            <Tooltip />
            <Line
              type="monotone"
              dataKey="count"
              stroke="currentColor"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
