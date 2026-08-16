"use client"

/**
 * React view of `lib/scheduler/scheduler-host-target.ts`: which schedule the
 * scheduler UI manages (this device vs the paired / remote host), whether a
 * paired host is reachable at all, and a setter that flips the preference.
 * Also resolves the target host's platform + capabilities for the task-type
 * picker (`useSchedulerTargetHost`).
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import {
  describeSchedulerTargetHost,
  getEffectiveSchedulerHostTarget,
  isPairedSchedulerHostAvailable,
  setPreferredSchedulerHostTarget,
  subscribeSchedulerHostTarget,
  type SchedulerHostTarget,
} from "@/lib/scheduler/scheduler-host-target"
import { subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { SchedulerHostDescriptor } from "@/lib/scheduler/host-support"
import { describeLocalSchedulerHost } from "@/lib/scheduler/host-support"

function subscribe(listener: () => void): () => void {
  const a = subscribeSchedulerHostTarget(listener)
  const b = subscribeActiveRemoteTransport(() => listener())
  return () => {
    a()
    b()
  }
}

export interface SchedulerHostTargetState {
  target: SchedulerHostTarget
  pairedAvailable: boolean
  setTarget: (target: SchedulerHostTarget) => void
}

export function useSchedulerHostTarget(): SchedulerHostTargetState {
  const target = useSyncExternalStore(
    subscribe,
    getEffectiveSchedulerHostTarget,
    () => "local" as SchedulerHostTarget
  )
  const pairedAvailable = useSyncExternalStore(
    subscribe,
    isPairedSchedulerHostAvailable,
    () => false
  )
  const setTarget = useCallback((next: SchedulerHostTarget) => {
    setPreferredSchedulerHostTarget(next)
  }, [])
  return { target, pairedAvailable, setTarget }
}

/** Platform + capabilities of the host whose schedule is being managed. */
export function useSchedulerTargetHost(target?: SchedulerHostTarget): SchedulerHostDescriptor {
  const { target: effective } = useSchedulerHostTarget()
  const resolvedTarget = target ?? effective
  const [host, setHost] = useState<SchedulerHostDescriptor>(() => describeLocalSchedulerHost())
  useEffect(() => {
    let cancelled = false
    void describeSchedulerTargetHost(resolvedTarget).then((descriptor) => {
      if (!cancelled) setHost(descriptor)
    })
    return () => {
      cancelled = true
    }
  }, [resolvedTarget])
  return host
}
