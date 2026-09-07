/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }))

import { WebhookUrlCard } from "./webhook-url-card"
import type { ConnectorIngress } from "@/hooks/use-connector-ingress"

const READY: ConnectorIngress = {
  base: "https://demo.example",
  loading: false,
  reason: "ready",
  desktopShape: true,
}

function renderCard(overrides: Partial<React.ComponentProps<typeof WebhookUrlCard>> = {}) {
  return render(
    <WebhookUrlCard
      ingress={READY}
      webhookPath="/webhook/lark/adp_1"
      namespace="settings.connections.lark"
      testIdPrefix="lark"
      onCopy={jest.fn()}
      {...overrides}
    />
  )
}

beforeEach(() => mockPush.mockClear())

describe("WebhookUrlCard", () => {
  it("joins the ingress base and the route path into one absolute URL", () => {
    renderCard()
    expect(screen.getByTestId("lark-webhook-url-input")).toHaveValue(
      "https://demo.example/webhook/lark/adp_1"
    )
  })

  it("hands the copy callback the exact string it rendered", () => {
    const onCopy = jest.fn()
    renderCard({ onCopy })
    fireEvent.click(screen.getByTestId("lark-webhook-url-copy"))
    expect(onCopy).toHaveBeenCalledWith("https://demo.example/webhook/lark/adp_1")
  })

  it("shows no field before the adapter has an id", () => {
    // A URL built from an id that does not exist yet is a URL that will never
    // work, so the card says why instead of rendering something copyable.
    renderCard({ webhookPath: null })
    expect(screen.queryByTestId("lark-webhook-url-input")).not.toBeInTheDocument()
    expect(screen.getByText(/save the adapter first/i)).toBeInTheDocument()
  })

  it("holds during the probe rather than flashing an empty state", () => {
    renderCard({ ingress: { base: null, loading: true, reason: "loading", desktopShape: true } })
    expect(screen.queryByTestId("lark-webhook-url-tunnel-off")).not.toBeInTheDocument()
    expect(screen.getByText(/checking tunnel status/i)).toBeInTheDocument()
  })

  describe("the empty states stay distinguishable", () => {
    it("offers the tunnel remedy only on the shape that has a tunnel", () => {
      renderCard({
        ingress: { base: null, loading: false, reason: "tunnel-off", desktopShape: true },
      })
      expect(screen.getByTestId("lark-webhook-url-tunnel-off")).toBeInTheDocument()
      fireEvent.click(screen.getByTestId("lark-open-companion"))
      expect(mockPush).toHaveBeenCalledWith("/settings?section=connections&connectionsTab=tunnel")
    })

    it("does not send a cloud host to the tunnel settings", () => {
      // The bug this card was extracted to fix: every form gated the URL on
      // the tunnel being up, so a correctly configured cloud install was told
      // to go start something it neither has nor needs.
      renderCard({
        ingress: { base: null, loading: false, reason: "origin-missing", desktopShape: false },
      })
      expect(screen.getByTestId("lark-webhook-url-origin-missing")).toBeInTheDocument()
      expect(screen.queryByTestId("lark-open-companion")).not.toBeInTheDocument()
      expect(screen.queryByTestId("lark-webhook-url-tunnel-off")).not.toBeInTheDocument()
    })

    it("offers no remedy at all when there is no host to fix", () => {
      renderCard({
        ingress: { base: null, loading: false, reason: "unsupported", desktopShape: false },
      })
      expect(screen.getByTestId("lark-webhook-url-unsupported")).toBeInTheDocument()
      expect(screen.queryByTestId("lark-open-companion")).not.toBeInTheDocument()
    })
  })

  describe("the console link", () => {
    it("is absent for a platform that has no console page", () => {
      renderCard()
      expect(screen.queryByTestId("lark-open-console")).not.toBeInTheDocument()
    })

    it("keeps its visible text as the accessible name", () => {
      // WCAG 2.5.3 Label in Name. An aria-label naming the destination would
      // replace the visible words, so a screen reader user and a sighted user
      // could no longer refer to the same button the same way.
      renderCard({ consoleUrl: "https://open.feishu.cn/app" })
      const button = screen.getByTestId("lark-open-console")
      expect(button).toHaveAccessibleName(/open lark console/i)
      expect(button).toHaveAttribute("title")
    })
  })
})
