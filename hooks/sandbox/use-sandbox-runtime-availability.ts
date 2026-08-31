"use client"

import { useEffect, useSyncExternalStore } from "react"

import { codeSandboxStatus } from "@/lib/ai/code-mode/sandbox-status"
import {
  getSandboxRuntimeAvailability,
  subscribeSandboxRuntimeAvailability,
} from "@/lib/sandbox/runtime-availability"

export function useSandboxRuntimeAvailability() {
  const availability = useSyncExternalStore(
    subscribeSandboxRuntimeAvailability,
    getSandboxRuntimeAvailability,
    getSandboxRuntimeAvailability
  )
  useEffect(() => {
    void codeSandboxStatus()
  }, [])
  return availability
}
