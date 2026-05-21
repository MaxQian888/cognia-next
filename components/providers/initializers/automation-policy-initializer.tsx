"use client"

// ADR-0028 / T5 — fires once on app boot. Pushes the persisted policy
// from `AppSettings.automationPolicy` into the Rust `AutomationState`'s
// `PolicyState` via `automation_policy_set`. Rust starts the policy
// empty, so without this hydration any constraints the user saved
// would silently lapse after each restart.

import { useEffect, useRef } from "react"

import { hydrateAutomationPolicy } from "@/lib/automation/policy"

export function AutomationPolicyInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    void hydrateAutomationPolicy().catch(() => {
      // Hydration failures are non-fatal — the empty default in Rust
      // is the safe behaviour. The Settings → Sandbox editor card will
      // re-attempt the set whenever the user edits the policy.
    })
  }, [])

  return null
}

export default AutomationPolicyInitializer
