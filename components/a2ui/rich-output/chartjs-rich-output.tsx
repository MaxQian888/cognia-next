"use client"

import { memo } from "react"
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
  type ChartData,
  type ChartOptions,
} from "chart.js"
import { Bar, Doughnut, Line } from "react-chartjs-2"
import { cn } from "@/lib/utils"
import type { A2UIRichOutputChartData } from "@/types/a2ui/schema"

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend
)

interface ChartJsRichOutputProps {
  chartType: "line" | "bar" | "doughnut"
  data: A2UIRichOutputChartData
  height?: number
  className?: string
}

function toChartData(data: A2UIRichOutputChartData): ChartData<"line" | "bar" | "doughnut"> {
  return {
    labels: data.labels,
    datasets: data.datasets.map((dataset) => ({
      ...dataset,
      borderWidth: 2,
    })),
  }
}

export const ChartJsRichOutput = memo(function ChartJsRichOutput({
  chartType,
  data,
  height = 260,
  className,
}: ChartJsRichOutputProps) {
  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: "bottom" as const,
      },
    },
  }

  return (
    <div
      className={cn("rounded-lg border border-border/60 bg-background/70 p-4", className)}
      style={{ height }}
    >
      {chartType === "line" ? (
        <Line
          data={toChartData(data) as ChartData<"line">}
          options={baseOptions as ChartOptions<"line">}
        />
      ) : null}
      {chartType === "bar" ? (
        <Bar
          data={toChartData(data) as ChartData<"bar">}
          options={baseOptions as ChartOptions<"bar">}
        />
      ) : null}
      {chartType === "doughnut" ? (
        <Doughnut
          data={toChartData(data) as ChartData<"doughnut">}
          options={baseOptions as ChartOptions<"doughnut">}
        />
      ) : null}
    </div>
  )
})
