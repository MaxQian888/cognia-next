"use client"

import { useEffect } from "react"

import { markBootCapabilityReady } from "@/lib/boot/capabilities"
import { ProjectKnowledgeWorkerInitializer } from "@/components/shell/project-kb-worker-initializer"
import { TwinWorkerInitializer } from "@/components/twin/twin-worker-initializer"
import { AgentTeamRuntimeInitializer } from "./agent-team-runtime-initializer"
import { ExternalAgentInitializer } from "./external-agent-initializer"
import { MemoryJobWorkerInitializer } from "./memory-job-worker-initializer"
import { OcrRuntimeInitializer } from "./ocr-runtime-initializer"
import { AgentTeamBridgeInitializer } from "./agent-team-bridge-initializer"
import { CloudIdentityInitializer } from "./cloud-identity-initializer"
import { SftpTransferInitializer } from "./sftp-transfer-initializer"
import { TemplatePlatformInitializer } from "./template-platform-initializer"
import { VectorCredentialMigrationInitializer } from "./vector-credential-migration-initializer"

export function KnowledgeAgentBootInitializers() {
  useEffect(() => markBootCapabilityReady("knowledge-agents"), [])
  return (
    <>
      <CloudIdentityInitializer />
      <ExternalAgentInitializer />
      <AgentTeamRuntimeInitializer />
      <MemoryJobWorkerInitializer />
      <OcrRuntimeInitializer />
      <TwinWorkerInitializer />
      <ProjectKnowledgeWorkerInitializer />
      <VectorCredentialMigrationInitializer />
      <TemplatePlatformInitializer />
      <AgentTeamBridgeInitializer />
      <SftpTransferInitializer />
    </>
  )
}

export default KnowledgeAgentBootInitializers
