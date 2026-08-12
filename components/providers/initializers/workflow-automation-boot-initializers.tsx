"use client"

import { useEffect } from "react"

import { SchedulerInitializer } from "@/components/scheduler/scheduler-initializer"
import { WorkflowRuntimeProvider } from "@/components/providers/workflow-runtime-provider"
import { markBootCapabilityReady } from "@/lib/boot/capabilities"
import { A2UISurfacePersistenceInitializer } from "./a2ui-surface-persistence-initializer"
import { AutoModeInitializer } from "./auto-mode-initializer"
import { AutomationPolicyInitializer } from "./automation-policy-initializer"
import { BackgroundTaskInitializer } from "./background-task-initializer"
import { CodeAdoptionTrackerInitializer } from "./code-adoption-tracker-initializer"
import { GoalVerificationInitializer } from "./goal-verification-initializer"

export function WorkflowAutomationBootInitializers() {
  useEffect(() => markBootCapabilityReady("workflow-automation"), [])
  return (
    <>
      <BackgroundTaskInitializer />
      <GoalVerificationInitializer />
      <AutomationPolicyInitializer />
      <AutoModeInitializer />
      <CodeAdoptionTrackerInitializer />
      <A2UISurfacePersistenceInitializer />
      <SchedulerInitializer />
      <WorkflowRuntimeProvider />
    </>
  )
}

export default WorkflowAutomationBootInitializers
