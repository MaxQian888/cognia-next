"use client"

import { Component, useEffect, useSyncExternalStore, type ReactNode } from "react"
import { useReportWebVitals } from "next/web-vitals"
import { webVitalsStore } from "@/lib/perf/web-vitals"

function WebVitalsObserver() {
  useReportWebVitals(webVitalsStore.ingest)
  useEffect(() => webVitalsStore.markStarted(), [])
  return null
}

class WebVitalsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    webVitalsStore.markError()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** Mounted outside account/onboarding gates to cover initial document loading. */
export function WebVitalsReporter() {
  const snapshot = useSyncExternalStore(
    webVitalsStore.subscribe,
    webVitalsStore.getSnapshot,
    webVitalsStore.getServerSnapshot
  )
  useEffect(() => webVitalsStore.connect(), [])
  // Next's hook has no cleanup. Keep the subscription mounted after first
  // opt-in; toggling it must not install another set of document observers.
  // The store gates every callback and aborts pending delivery on opt-out.
  return snapshot.started || snapshot.settings.enabled ? (
    <WebVitalsBoundary>
      <WebVitalsObserver />
    </WebVitalsBoundary>
  ) : null
}
