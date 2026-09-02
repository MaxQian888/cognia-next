/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: { error: (m: unknown) => toastError(m), success: (m: unknown) => toastSuccess(m) },
}))

import { TemplateCatalog } from "@/lib/templates/catalog"
import { createTemplateDefinition } from "@/lib/templates/contracts"
import type { TemplateInstanceRecord } from "@/lib/templates/repository"
import type { TemplateRuntime } from "@/lib/templates/runtime"

import { SquadTemplateProvenance } from "./squad-template-provenance"

async function definitionAt(version: string) {
  return createTemplateDefinition({
    id: "legacy.agentTeam.user-1",
    domain: "agentTeam",
    status: "published",
    revision: 1,
    version,
    metadata: { name: "Parallel review" },
    payload: { team: { name: "Parallel review" } },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
  })
}

async function makeInstance(teamId: string): Promise<TemplateInstanceRecord> {
  const snapshot = await createTemplateDefinition({
    id: "legacy.agentTeam.user-1",
    domain: "agentTeam",
    status: "published",
    revision: 1,
    version: "1.0.0",
    metadata: { name: "Parallel review" },
    payload: { team: { name: "Parallel review" } },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
  })
  return {
    id: "inst-1",
    idempotencyKey: "key",
    source: {
      definitionId: snapshot.id,
      version: "1.0.0",
      revision: 1,
      status: "published",
      contentHash: snapshot.contentHash,
      snapshot,
    },
    bindingFingerprint: "fp",
    resources: [{ domain: "agentTeam", id: teamId }],
    baseline: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeRuntime(instances: TemplateInstanceRecord[], service: Record<string, unknown> = {}) {
  return {
    catalog: new TemplateCatalog(),
    repository: {
      listInstances: jest.fn(async () => instances),
    } as unknown as TemplateRuntime["repository"],
    service: {
      planUpdate: jest.fn(),
      applyUpdate: jest.fn(),
      detachInstance: jest.fn(async () => undefined),
      ...service,
    } as unknown as TemplateRuntime["service"],
  } as TemplateRuntime
}

describe("SquadTemplateProvenance", () => {
  beforeEach(() => {
    toastError.mockReset()
    toastSuccess.mockReset()
  })

  it("says a Squad has no lineage rather than showing an empty card", async () => {
    render(<SquadTemplateProvenance squadId="team-1" runtime={makeRuntime([])} />)
    await waitFor(() => expect(screen.getByTestId("squad-provenance-none")).toBeInTheDocument())
    expect(screen.queryByTestId("template-instance-inst-1")).not.toBeInTheDocument()
  })

  it("names the template and version the Squad came from", async () => {
    const runtime = makeRuntime([await makeInstance("team-1")])
    render(<SquadTemplateProvenance squadId="team-1" runtime={runtime} />)
    await waitFor(() => expect(screen.getByTestId("template-instance-inst-1")).toBeInTheDocument())
    expect(
      screen.getByText('createdFrom:{"name":"Parallel review","version":"1.0.0"}')
    ).toBeInTheDocument()
  })

  it("ignores an instance whose resources name a different Squad", async () => {
    const runtime = makeRuntime([await makeInstance("team-other")])
    render(<SquadTemplateProvenance squadId="team-1" runtime={runtime} />)
    await waitFor(() => expect(screen.getByTestId("squad-provenance-none")).toBeInTheDocument())
  })

  it("detaches through the service and re-reads the record", async () => {
    const instance = await makeInstance("team-1")
    const runtime = makeRuntime([instance])
    render(<SquadTemplateProvenance squadId="team-1" runtime={runtime} />)
    await waitFor(() => expect(screen.getByTestId("template-instance-inst-1")).toBeInTheDocument())

    await userEvent.click(screen.getByTestId("template-instance-detach-inst-1"))

    await waitFor(() => expect(runtime.service.detachInstance).toHaveBeenCalledWith("inst-1"))
    expect(toastSuccess).toHaveBeenCalledWith("detached")
    // The record is re-read so the card reflects the detach.
    await waitFor(() => expect(runtime.repository.listInstances).toHaveBeenCalledTimes(2))
  })

  /**
   * `planUpdate` / `applyUpdate` are two of the four lifecycle calls ADR-0100
   * advertises that had no caller on the Squad side at all.
   */
  it("plans an update to a newer release and applies the conflict answers", async () => {
    const catalog = new TemplateCatalog()
    catalog.replaceSource("user", [await definitionAt("1.0.0"), await definitionAt("1.1.0")])
    const plan = {
      id: "plan-1",
      source: { version: "1.0.0" },
      next: { version: "1.1.0" },
      status: "ready",
      issues: [],
      diff: { changes: [{ path: "team.name" }], conflicts: [] },
    }
    const runtime = makeRuntime([await makeInstance("team-1")], {
      planUpdate: jest.fn(async () => plan),
      applyUpdate: jest.fn(async () => undefined),
    })
    render(<SquadTemplateProvenance squadId="team-1" runtime={runtime} catalog={catalog} />)
    await waitFor(() => expect(screen.getByTestId("template-instance-inst-1")).toBeInTheDocument())

    // The card offers the releases the definition actually has, minus the one
    // the instance is already on.
    const trigger = screen.getByTestId("template-instance-update-inst-1")
    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole("option", { name: "1.1.0" }))

    await waitFor(() => expect(runtime.service.planUpdate).toHaveBeenCalledWith("inst-1", "1.1.0"))
    const dialog = await screen.findByTestId("template-update-dialog")
    await userEvent.click(within(dialog).getByTestId("template-update-confirm"))

    await waitFor(() =>
      expect(runtime.service.applyUpdate).toHaveBeenCalledWith(plan, {
        confirmed: true,
        resolutions: {},
      })
    )
    expect(toastSuccess).toHaveBeenCalledWith('updated:{"version":"1.1.0"}')
  })

  it("reports a refusal from the service instead of failing silently", async () => {
    const runtime = makeRuntime([await makeInstance("team-1")], {
      detachInstance: jest.fn(async () => {
        throw new Error("instance is gone")
      }),
    })
    render(<SquadTemplateProvenance squadId="team-1" runtime={runtime} />)
    await waitFor(() => expect(screen.getByTestId("template-instance-inst-1")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("template-instance-detach-inst-1"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("instance is gone"))
  })
})
