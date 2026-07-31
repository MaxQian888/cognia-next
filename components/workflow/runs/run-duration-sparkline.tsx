"use client"

/**
 * Tiny sparkline chart showing the duration trend across the most recent
 * runs of a workflow. Surfaces in the run detail header so users notice
 * a creeping regression at a glance. Hidden when the workflow has fewer
 * than 2 runs (a sparkline of a single point is meaningless).
 *
 * Implementation note: we hit the `workflowId+startedAt` index and pull
 * the last 20 rows in descending order, then reverse for left-to-right
 * time progression. `recharts` is loaded lazily because it pulls a
 * non-trivial amount of code and the editor doesn't need it.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from "recharts"
import { getDb } from "@/lib/db/schema"
import { formatDurationMs } from "./format"

const MAX_RUNS = 20

export function RunDurationSparkline({ workflowId }: { workflowId: string }) {
  const t = useTranslations("workflows.runs.detail.sparkline")

  const data = useLiveQuery(
    async () => {
      const db = getDb()
      const runs = await db.workflowRuns
        .where("workflowId")
        .equals(workflowId)
        .reverse()
        .limit(MAX_RUNS)
        .toArray()
      // Drop runs without a completedAt — we have no duration to plot.
      // Reverse so time flows left-to-right.
      return runs
        .filter((r) => r.completedAt !== undefined)
        .map((r) => ({
          startedAt: r.startedAt,
          duration: (r.completedAt ?? r.startedAt) - r.startedAt,
          status: r.status,
        }))
        .reverse()
    },
    [workflowId],
    [] as Array<{ startedAt: number; duration: number; status: string }>
  )

  if (!data || data.length < 2) return null

  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("title")}</p>
      <div className="h-8 w-32">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={1}
          minHeight={1}
          initialDimension={{ width: 128, height: 32 }}
        >
          <LineChart data={data}>
            <YAxis hide domain={["auto", "auto"]} />
            <Tooltip
              cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
              contentStyle={{
                fontSize: 11,
                padding: "4px 6px",
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 4,
              }}
              labelFormatter={(v) => (typeof v === "number" ? new Date(v).toLocaleString() : "")}
              formatter={(value) => [
                typeof value === "number" ? formatDurationMs(value) : String(value ?? ""),
                "",
              ]}
            />
            <Line
              type="monotone"
              dataKey="duration"
              stroke="var(--wf-action)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
