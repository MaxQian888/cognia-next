"use client"

import { useEffect } from "react"

import { markBootCapabilityReady } from "@/lib/boot/capabilities"
import { ProjectKnowledgeWorkerInitializer } from "@/components/shell/project-kb-worker-initializer"
import { TwinWorkerInitializer } from "@/components/twin/twin-worker-initializer"
import { AgentTeamRuntimeInitializer } from "./agent-team-runtime-initializer"
import { ExternalAgentInitializer } from "./external-agent-initializer"
import { MemoryJobWorkerInitializer } from "./memory-job-worker-initializer"
import { OcrRuntimeInitializer } from "./ocr-runtime-initializer"
import { TemplatePlatformInitializer } from "./template-platform-initializer"

export function KnowledgeAgentBootInitializers() {
  useEffect(() => markBootCapabilityReady("knowledge-agents"), [])
  return (
    <>
      <ExternalAgentInitializer />
      <AgentTeamRuntimeInitializer />
      <MemoryJobWorkerInitializer />
      <OcrRuntimeInitializer />
      <TwinWorkerInitializer />
      <ProjectKnowledgeWorkerInitializer />
      <TemplatePlatformInitializer />
    </>
  )
}

export default KnowledgeAgentBootInitializers
