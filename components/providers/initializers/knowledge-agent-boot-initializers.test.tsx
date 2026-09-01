import { render } from "@testing-library/react"

jest.mock("./agent-team-runtime-initializer", () => ({
  AgentTeamRuntimeInitializer: () => <span data-boot="agent-team" />,
}))
jest.mock("./external-agent-initializer", () => ({
  ExternalAgentInitializer: () => <span data-boot="external-agent" />,
}))
jest.mock("./ocr-runtime-initializer", () => ({
  OcrRuntimeInitializer: () => <span data-boot="ocr" />,
}))
jest.mock("@/components/twin/twin-worker-initializer", () => ({
  TwinWorkerInitializer: () => <span data-boot="twin" />,
}))
jest.mock("@/components/shell/project-kb-worker-initializer", () => ({
  ProjectKnowledgeWorkerInitializer: () => <span data-boot="project-kb" />,
}))
jest.mock("./memory-job-worker-initializer", () => ({
  MemoryJobWorkerInitializer: () => <span data-boot="memory" />,
}))
jest.mock("./template-platform-initializer", () => ({
  TemplatePlatformInitializer: () => <span data-boot="templates" />,
}))
jest.mock("./vector-credential-migration-initializer", () => ({
  VectorCredentialMigrationInitializer: () => <span data-boot="vector-credentials" />,
}))
// ADR-0162. Stubbed like its siblings, and asserted below, because the real one
// renders null: a transfer pump that was dropped from this group would leave
// every queued transfer sitting at "queued" with nothing to show for it.
jest.mock("./sftp-transfer-initializer", () => ({
  SftpTransferInitializer: () => <span data-boot="sftp-transfers" />,
}))
const mockMarkReady = jest.fn()
jest.mock("@/lib/boot/capabilities", () => ({
  markBootCapabilityReady: (...args: unknown[]) => mockMarkReady(...args),
}))

import { KnowledgeAgentBootInitializers } from "./knowledge-agent-boot-initializers"

it("mounts knowledge and agent workers and reports readiness", () => {
  const { container } = render(<KnowledgeAgentBootInitializers />)
  expect(
    Array.from(container.querySelectorAll("[data-boot]")).map((node) =>
      node.getAttribute("data-boot")
    )
  ).toEqual([
    "external-agent",
    "agent-team",
    "memory",
    "ocr",
    "twin",
    "project-kb",
    "vector-credentials",
    "templates",
    "sftp-transfers",
  ])
  expect(mockMarkReady).toHaveBeenCalledWith("knowledge-agents")
})
