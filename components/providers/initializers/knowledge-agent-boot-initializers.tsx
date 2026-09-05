"use client"

import { useEffect } from "react"

import { markBootCapabilityReady } from "@/lib/boot/capabilities"
import { ProjectKnowledgeWorkerInitializer } from "@/components/shell/project-kb-worker-initializer"
import { TwinWorkerInitializer } from "@/components/twin/twin-worker-initializer"
import { ExternalAgentInitializer } from "./external-agent-initializer"
import { MemoryJobWorkerInitializer } from "./memory-job-worker-initializer"
import { OcrRuntimeInitializer } from "./ocr-runtime-initializer"
import { CloudIdentityInitializer } from "./cloud-identity-initializer"
import { SftpTransferInitializer } from "./sftp-transfer-initializer"
import { SquadBootstrapInitializer } from "./squad-bootstrap-initializer"
import { TemplatePlatformInitializer } from "./template-platform-initializer"
import { VectorCredentialMigrationInitializer } from "./vector-credential-migration-initializer"

export function KnowledgeAgentBootInitializers() {
  useEffect(() => markBootCapabilityReady("knowledge-agents"), [])
  return (
    <>
      <CloudIdentityInitializer />
      <ExternalAgentInitializer />
      {/* One ordered bootstrap owns the Squad mirror, runtime and recovery
          (ADR-0169). It replaced the runtime + bridge initializer pair. */}
      <SquadBootstrapInitializer />
      <MemoryJobWorkerInitializer />
      <OcrRuntimeInitializer />
      <TwinWorkerInitializer />
      <ProjectKnowledgeWorkerInitializer />
      <VectorCredentialMigrationInitializer />
      <TemplatePlatformInitializer />
      <SftpTransferInitializer />
    </>
  )
}

export default KnowledgeAgentBootInitializers
