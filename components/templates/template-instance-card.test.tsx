/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TemplateInstanceCard } from "./template-instance-card"
import type { TemplateInstanceRecord } from "@/lib/templates/repository"

const messages = {
  templateStudio: {
    status: { draft: "Draft" },
    instances: {
      resources: "{count} resources",
      detached: "Detached",
      sourceUnavailable: "Source unavailable",
      updateTo: "Update to…",
      upToDate: "On the latest release",
      detach: "Detach",
      rebindTo: "Rebind to…",
    },
  },
}

function makeInstance(over: Partial<TemplateInstanceRecord> = {}): TemplateInstanceRecord {
  return {
    id: "inst_1",
    idempotencyKey: "k",
    source: {
      definitionId: "team.review",
      version: "1.0.0",
      contentHash: "sha256:a",
      snapshot: { domain: "agentTeam" },
    },
    bindingFingerprint: "f",
    bindings: {},
    resources: [{ id: "r1" }],
    baseline: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as unknown as TemplateInstanceRecord
}

function renderCard(
  instance: TemplateInstanceRecord,
  availableVersions: string[] = ["1.0.0", "1.1.0"],
  rebindTargets: React.ComponentProps<typeof TemplateInstanceCard>["rebindTargets"] = []
) {
  const onPlanUpdate = jest.fn()
  const onDetach = jest.fn()
  const onRebind = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TemplateInstanceCard
        instance={instance}
        availableVersions={availableVersions}
        rebindTargets={rebindTargets}
        onPlanUpdate={onPlanUpdate}
        onDetach={onDetach}
        onRebind={onRebind}
      />
    </NextIntlClientProvider>
  )
  return { onPlanUpdate, onDetach, onRebind }
}

describe("TemplateInstanceCard", () => {
  /**
   * ADR-0100 advertises "preflight, instantiate, diff, update, detach" as the
   * full-domain lifecycle. The Instances tab was a read-only card, so four of
   * those five had no caller anywhere in the app.
   */
  it("offers the releases this instance could move to", () => {
    renderCard(makeInstance())
    expect(screen.getByTestId("template-instance-update-inst_1")).toBeInTheDocument()
    expect(screen.getByTestId("template-instance-detach-inst_1")).toBeInTheDocument()
  })

  it("says so rather than offering an empty picker when it is current", () => {
    renderCard(makeInstance(), ["1.0.0"])
    expect(screen.queryByTestId("template-instance-update-inst_1")).toBeNull()
    expect(screen.getByText("On the latest release")).toBeInTheDocument()
  })

  it("offers nothing on a detached instance, which planUpdate refuses anyway", () => {
    renderCard(makeInstance({ detachedAt: "2026-08-02T00:00:00.000Z" } as never))
    expect(screen.getByText("Detached")).toBeInTheDocument()
    expect(screen.queryByTestId("template-instance-detach-inst_1")).toBeNull()
  })

  it("detaches through the service, not by editing the row", () => {
    const { onDetach } = renderCard(makeInstance())
    fireEvent.click(screen.getByTestId("template-instance-detach-inst_1"))
    expect(onDetach).toHaveBeenCalledWith("inst_1")
  })

  it("surfaces a source that is no longer available", () => {
    renderCard(makeInstance({ sourceUnavailableAt: "2026-08-03T00:00:00.000Z" } as never))
    expect(screen.getByText("Source unavailable")).toBeInTheDocument()
  })

  /**
   * `rebindSource` was the one lifecycle method with no caller left, so an
   * instance whose package was uninstalled, or one deliberately detached, had
   * no way back.
   */
  it("offers a rebind only once the instance has lost its source", () => {
    const targets = [
      { id: "team.review.v2", version: "2.0.0", name: "Review v2", domain: "agentTeam" },
    ]
    renderCard(makeInstance(), ["1.0.0", "1.1.0"], targets)
    expect(screen.queryByTestId("template-instance-rebind-inst_1")).toBeNull()

    const { onRebind } = renderCard(
      makeInstance({ sourceUnavailableAt: "2026-08-03T00:00:00.000Z" } as never),
      ["1.0.0"],
      targets
    )
    fireEvent.click(screen.getAllByTestId("template-instance-rebind-inst_1")[0])
    fireEvent.click(screen.getByRole("option", { name: "Review v2 2.0.0" }))
    expect(onRebind).toHaveBeenCalledWith("inst_1", "team.review.v2", "2.0.0")
  })

  it("hides a rebind target from another domain, which the service refuses", () => {
    renderCard(
      makeInstance({ detachedAt: "2026-08-02T00:00:00.000Z" } as never),
      ["1.0.0"],
      [{ id: "skill.notes", version: "1.0.0", name: "Notes", domain: "skill" }]
    )
    expect(screen.queryByTestId("template-instance-rebind-inst_1")).toBeNull()
  })
})
