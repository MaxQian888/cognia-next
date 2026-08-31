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
    },
  },
}

function makeInstance(over: Partial<TemplateInstanceRecord> = {}): TemplateInstanceRecord {
  return {
    id: "inst_1",
    idempotencyKey: "k",
    source: { definitionId: "team.review", version: "1.0.0", contentHash: "sha256:a" },
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
  availableVersions: string[] = ["1.0.0", "1.1.0"]
) {
  const onPlanUpdate = jest.fn()
  const onDetach = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TemplateInstanceCard
        instance={instance}
        availableVersions={availableVersions}
        onPlanUpdate={onPlanUpdate}
        onDetach={onDetach}
      />
    </NextIntlClientProvider>
  )
  return { onPlanUpdate, onDetach }
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
})
