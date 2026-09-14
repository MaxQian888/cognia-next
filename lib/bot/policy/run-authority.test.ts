import { resolveOwnedBotAuthority, assertBotPublicationAuthority } from "./run-authority"
import { requireOwnedBotRun } from "@/lib/bot/runtime/owned-run"
import { getBotRunStep } from "@/lib/db/bot-run-steps"
import { getExecutionRun } from "@/lib/db/execution-runs"
import { getBotInstallation } from "@/lib/db/bot-installations"
import { getBotEntry } from "@/lib/plugin/registries/bot-registry"
import type { PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"
import type { ExecutionRunInterrupt } from "@/types/execution/run"
jest.mock("@/lib/bot/runtime/owned-run", () => ({ requireOwnedBotRun: jest.fn() }))
jest.mock("@/lib/db/bot-run-steps", () => ({ getBotRunStep: jest.fn() }))
jest.mock("@/lib/db/execution-runs", () => ({ getExecutionRun: jest.fn() }))
jest.mock("@/lib/db/bot-installations", () => ({ getBotInstallation: jest.fn() }))
jest.mock("@/lib/plugin/registries/bot-registry", () => ({ getBotEntry: jest.fn() }))
const grant: PluginBotPolicyV1 = {
  requireApprovalForWrites: false,
  maxAutonomy: "autopilot",
  maxAuthority: "bypassPermissions",
}
function owned(
  policyGrant: PluginBotPolicyV1 | undefined = grant,
  policy: PluginBotPolicyV1 = grant
) {
  return {
    run: { id: "run" },
    installation: { id: "installation", policyGrant },
    resolved: { policy, problems: [] },
  } as unknown as Awaited<ReturnType<typeof requireOwnedBotRun>>
}
const approval = {
  approvalDecisionMode: "policy",
  approvalPolicy: { kind: "bot-installation", installationId: "installation" },
} as ExecutionRunInterrupt
beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(requireOwnedBotRun).mockResolvedValue(owned())
  jest.mocked(getBotRunStep).mockResolvedValue({ status: "completed", output: grant } as never)
  jest.mocked(getExecutionRun).mockResolvedValue({ sourceId: "installation" } as never)
  jest.mocked(getBotInstallation).mockResolvedValue({ definitionId: "plugin:bot" } as never)
  jest.mocked(getBotEntry).mockReturnValue({ pluginId: "plugin" } as never)
})
it("derives the host caller from the registered owner and requires current owned-run validation", async () => {
  expect((await resolveOwnedBotAuthority(undefined, "run")).automatedPublicationAllowed).toBe(true)
  expect(requireOwnedBotRun).toHaveBeenCalledWith("plugin", "run")
  await expect(assertBotPublicationAuthority("plugin", "run", approval)).resolves.toBeUndefined()
  jest.mocked(requireOwnedBotRun).mockRejectedValueOnce(new Error("cross-plugin or inactive run"))
  await expect(resolveOwnedBotAuthority("other", "run")).rejects.toThrow("cross-plugin")
})
it.each([
  {},
  { maxAutonomy: "autopilot" },
  { requireApprovalForWrites: false },
  { requireApprovalForWrites: true, maxAutonomy: "autopilot" },
  { requireApprovalForWrites: false, maxAutonomy: "confirm" },
])("never treats plugin policy as installation authority (%j)", async (policyGrant) => {
  jest.mocked(requireOwnedBotRun).mockResolvedValue(owned(policyGrant as PluginBotPolicyV1))
  expect((await resolveOwnedBotAuthority("plugin", "run")).automatedPublicationAllowed).toBe(false)
  await expect(assertBotPublicationAuthority("plugin", "run", approval)).rejects.toThrow(
    "no longer authorized"
  )
})
it("handles installations without any grant without inheriting the definition's authority", async () => {
  const current = owned() as unknown as { installation: { policyGrant?: PluginBotPolicyV1 } }
  delete current.installation.policyGrant
  jest.mocked(requireOwnedBotRun).mockResolvedValue(current as never)
  expect((await resolveOwnedBotAuthority("plugin", "run")).automatedPublicationAllowed).toBe(false)
})
it.each([{ requireApprovalForWrites: true }, { maxAutonomy: "confirm" }, { maxAuthority: "plan" }])(
  "preserves the original organization/request ceiling across a grant change (%j)",
  async (ceiling) => {
    jest.mocked(getBotRunStep).mockResolvedValue({ status: "completed", output: ceiling } as never)
    const result = await resolveOwnedBotAuthority("plugin", "run")
    expect(result.effectivePolicy).toMatchObject(ceiling)
    expect(result.automatedPublicationAllowed).toBe(false)
  }
)
it("revalidates a newly tightened definition ceiling", async () => {
  jest
    .mocked(requireOwnedBotRun)
    .mockResolvedValue(owned(grant, { ...grant, requireApprovalForWrites: true }))
  expect((await resolveOwnedBotAuthority("plugin", "run")).automatedPublicationAllowed).toBe(false)
})
it.each([
  undefined,
  { status: "running", output: grant },
  { status: "completed", output: null },
  { status: "completed", output: "bad" },
])("refuses legacy or malformed run policy checkpoints", async (row) => {
  jest.mocked(getBotRunStep).mockResolvedValue(row as never)
  await expect(resolveOwnedBotAuthority("plugin", "run")).rejects.toThrow("host policy checkpoint")
})
it("rejects changed definitions, missing runs, missing installations and unregistered owners", async () => {
  jest
    .mocked(requireOwnedBotRun)
    .mockResolvedValue({ ...owned(), resolved: { problems: [{ kind: "version_drift" }] } } as never)
  await expect(resolveOwnedBotAuthority("plugin", "run")).rejects.toThrow("definition")
  jest.mocked(getExecutionRun).mockResolvedValueOnce(undefined)
  await expect(resolveOwnedBotAuthority(undefined, "run")).rejects.toThrow("owning plugin")
  jest.mocked(getBotInstallation).mockResolvedValueOnce(undefined)
  await expect(resolveOwnedBotAuthority(undefined, "run")).rejects.toThrow("owning plugin")
  jest.mocked(getBotEntry).mockReturnValueOnce(undefined)
  await expect(resolveOwnedBotAuthority(undefined, "run")).rejects.toThrow("owning plugin")
})
it("requires genuine installation provenance for policy decisions while preserving human approvals", async () => {
  await expect(
    assertBotPublicationAuthority("plugin", "run", {} as ExecutionRunInterrupt)
  ).resolves.toBeUndefined()
  for (const policy of [
    undefined,
    { kind: "plugin", installationId: "installation" },
    { kind: "bot-installation", installationId: "other" },
  ])
    await expect(
      assertBotPublicationAuthority("plugin", "run", {
        ...approval,
        approvalPolicy: policy,
      } as ExecutionRunInterrupt)
    ).rejects.toThrow("no longer authorized")
})
