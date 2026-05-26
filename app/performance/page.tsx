"use client"

import { PerformanceDashboard } from "@/components/performance/performance-dashboard"

/**
 * Dedicated full-page performance panel route. Reached from the guild-rail
 * "Performance" entry. The Task-Manager-style dashboard owns its own chrome
 * (header + toolbar + tabs); this page just hosts it full-height.
 */
export default function PerformancePage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <PerformanceDashboard />
    </div>
  )
}
