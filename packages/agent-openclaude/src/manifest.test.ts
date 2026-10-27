import { AGENT_CAPABILITY_IDS } from "@cognia/agent-contracts/capability-ids"
import {
  OPENCLAUDE_CAPABILITIES,
  OPENCLAUDE_EXECUTION_SEMANTICS,
  openClaudeManifest,
} from "./manifest"

it("declares its native protocol, confined process, and unverified installed version honestly", () => {
  expect(openClaudeManifest.protocols[0].protocol).toBe("openclaude-cli")
  expect(OPENCLAUDE_EXECUTION_SEMANTICS).toMatchObject({
    resume: "relaunch-with-session",
    approvals: "per-tool-call",
    processModel: "per-session",
  })
  expect(openClaudeManifest.runtimes?.[0]).toMatchObject({
    certifiedVersions: [],
    sandbox: { required: true },
  })
})

it("fills every capability with implementation evidence without claiming unimplemented native surfaces", () => {
  const cells = OPENCLAUDE_CAPABILITIES.protocols!["openclaude-cli"].capabilities
  expect(Object.keys(cells).sort()).toEqual([...AGENT_CAPABILITY_IDS].sort())
  expect(cells["output.structured"]?.level).toBe("unsupported")
  expect(cells["tools.permission-policy"]?.level).toBe("equivalent")
  for (const cell of Object.values(cells)) {
    expect(cell?.evidence).toBe("adapter-code")
    if (cell?.level !== "native") expect(cell?.reasonKey).toBeTruthy()
  }
})
