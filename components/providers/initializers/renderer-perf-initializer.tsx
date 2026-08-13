"use client"

import { useEffect } from "react"

import { getRendererPerformanceCollector } from "@/lib/perf/renderer-collector"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

export function RendererPerfInitializer(): null {
  useEffect(() => {
    const collector = getRendererPerformanceCollector()
    const scope = getActiveRuntimeTargetContext()
    if (scope) collector.setScope({ targetId: scope.targetId, routingGeneration: 0 })
  }, [])
  return null
}
