/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TemplateOriginCard } from "./template-origin-card"
import type { TemplateDerivation } from "@/lib/templates/repository"

const messages = {
  templateStudio: {
    origin: {
      title: "Forked from",
      localOnly: "Recorded by this library, not claimed by the template.",
      updateAvailable: "Upstream updated to {version}",
      upToDate: "Up to date with upstream",
      review: "Review update",
      detach: "Detach",
    },
  },
}

function derivation(over: Partial<TemplateDerivation> = {}): TemplateDerivation {
  return {
    definitionId: "builtin.skill.notes",
    version: "1.0.0",
    revision: 1,
    contentHash: "abc",
    forkedAt: 1,
    baseSnapshot: {} as never,
    ...over,
  }
}

function renderCard(props: Partial<Parameters<typeof TemplateOriginCard>[0]> = {}) {
  const onReviewUpdate = jest.fn()
  const onDetach = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TemplateOriginCard
        derivation={derivation()}
        upstream={undefined}
        onReviewUpdate={onReviewUpdate}
        onDetach={onDetach}
        {...props}
      />
    </NextIntlClientProvider>
  )
  return { onReviewUpdate, onDetach }
}

describe("TemplateOriginCard", () => {
  /** A template nobody forked has no origin to report, so it shows nothing. */
  it("renders nothing for a definition that was not forked", () => {
    renderCard({ derivation: undefined })
    expect(screen.queryByTestId("template-origin")).toBeNull()
  })

  it("names the release it was forked from", () => {
    renderCard()
    expect(screen.getByTestId("template-origin-source")).toHaveTextContent(
      "builtin.skill.notes@1.0.0"
    )
  })

  /**
   * Lineage is a local record, not signed provenance. Saying so on the card is
   * what keeps it from reading as a trust claim about the upstream publisher.
   */
  it("says the record is local rather than claimed by the template", () => {
    renderCard()
    expect(screen.getByTestId("template-origin")).toHaveTextContent(
      "Recorded by this library, not claimed by the template."
    )
  })

  it("offers no update while upstream has not moved", () => {
    renderCard()
    expect(screen.getByTestId("template-origin-current")).toBeInTheDocument()
    expect(screen.queryByTestId("template-origin-review")).toBeNull()
  })

  it("announces a newer upstream release and offers to review it", () => {
    const { onReviewUpdate } = renderCard({ upstream: { version: "1.2.0" } as never })
    expect(screen.getByTestId("template-origin-update")).toHaveTextContent("1.2.0")
    fireEvent.click(screen.getByTestId("template-origin-review"))
    expect(onReviewUpdate).toHaveBeenCalled()
  })

  it("detaches, which is how a fork says it has become its own thing", () => {
    const { onDetach } = renderCard()
    fireEvent.click(screen.getByTestId("template-origin-detach"))
    expect(onDetach).toHaveBeenCalled()
  })

  /**
   * A phone still gets to SEE where a template came from. It just cannot act,
   * because the merge lands in a draft editor that only exists on desktop.
   */
  it("shows the origin without actions when authoring is unavailable", () => {
    renderCard({ readOnly: true, upstream: { version: "1.2.0" } as never })
    expect(screen.getByTestId("template-origin-source")).toBeInTheDocument()
    expect(screen.queryByTestId("template-origin-review")).toBeNull()
    expect(screen.queryByTestId("template-origin-detach")).toBeNull()
  })
})
