"use client"

import { useEffect } from "react"

import { getRendererPerformanceCollector } from "@/lib/perf/renderer-collector"
import { getOperationPerformanceRecorder } from "@/lib/perf/operation-performance"
import { subscribePerformanceSecurityBarrier } from "@/lib/perf/security-generation"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

export function RendererPerfInitializer(): null {
  useEffect(() => {
    const collector = getRendererPerformanceCollector()
    const operations = getOperationPerformanceRecorder()
    const disconnect = operations.connect()
    const syncScope = () => {
      const scope = getActiveRuntimeTargetContext()
      operations.setScope(
        scope ? JSON.stringify([scope.accountId, scope.targetId, scope.routingGeneration]) : null
      )
      if (scope)
        collector.setScope({ targetId: scope.targetId, routingGeneration: scope.routingGeneration })
    }
    syncScope()
    const unsubscribe = subscribeRuntimeTargetContext(syncScope)
    // Lock/switch barriers run synchronously, before async account teardown.
    const unsubscribeSecurity = subscribePerformanceSecurityBarrier(() => operations.clear())
    return () => {
      unsubscribe()
      unsubscribeSecurity()
      disconnect()
      // Preserve early boot measurements across StrictMode effect replay.
    }
  }, [])
  return null
}
