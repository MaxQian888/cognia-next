/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { EndpointsSection, type EndpointsSectionProps } from "./endpoints-section"
import type { ProviderEndpointCandidate, ProviderEndpointChange } from "@cognia/provider-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const candidate = (
  overrides: Partial<ProviderEndpointCandidate> = {}
): ProviderEndpointCandidate => ({
  id: "c1",
  providerId: "openai",
  url: "https://api.openai.com/v1",
  source: "current",
  ...overrides,
})

const comparison = (url: string, probe: Record<string, unknown>) =>
  ({
    targetId: `t-${url}`,
    endpoint: url,
    recommended: false,
    probe,
  }) as unknown as EndpointsSectionProps["comparisons"][number]

const props: EndpointsSectionProps = {
  candidates: [
    candidate(),
    candidate({ id: "c2", url: "https://mirror.example/v1", source: "user" }),
  ],
  comparisons: [],
  currentEndpoint: "https://api.openai.com/v1",
  customEndpoint: "",
  onCustomEndpointChange: jest.fn(),
  onAddCustomEndpoint: jest.fn(),
  onCompareFree: jest.fn(),
  onComparePaid: jest.fn(),
  comparing: false,
  comparePaidDisabled: false,
  error: null,
  onRequestApply: jest.fn(),
  rollbacks: [],
  onRollback: jest.fn(),
}

describe("EndpointsSection", () => {
  beforeEach(() => jest.clearAllMocks())

  it("marks the endpoint currently in effect and offers Apply only for the others", () => {
    render(<EndpointsSection {...props} />)
    expect(screen.getByText("endpoints.current")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "endpoints.apply" })).toHaveLength(1)
  })

  it("asks the parent to confirm before switching, rather than switching directly", () => {
    render(<EndpointsSection {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "endpoints.apply" }))
    expect(props.onRequestApply).toHaveBeenCalledWith("https://mirror.example/v1")
  })

  it("blocks Apply for a candidate a comparison proved unusable", () => {
    render(
      <EndpointsSection
        {...props}
        comparisons={[
          comparison("https://mirror.example/v1", {
            durationMs: 90,
            capabilityVerified: false,
            authenticated: true,
          }),
        ]}
      />
    )
    expect(screen.getByRole("button", { name: "endpoints.apply" })).toBeDisabled()
  })

  it("blocks Apply for a candidate that rejected the credentials", () => {
    render(
      <EndpointsSection
        {...props}
        comparisons={[
          comparison("https://mirror.example/v1", {
            durationMs: 90,
            capabilityVerified: true,
            authenticated: false,
          }),
        ]}
      />
    )
    expect(screen.getByRole("button", { name: "endpoints.apply" })).toBeDisabled()
  })

  it("keeps Apply live for a candidate that passed the comparison", () => {
    render(
      <EndpointsSection
        {...props}
        comparisons={[
          comparison("https://mirror.example/v1", {
            durationMs: 90,
            capabilityVerified: true,
            authenticated: true,
          }),
        ]}
      />
    )
    expect(screen.getByRole("button", { name: "endpoints.apply" })).toBeEnabled()
    expect(screen.getByText(/90 ms/)).toBeInTheDocument()
  })

  it("badges the recommended endpoint", () => {
    render(
      <EndpointsSection
        {...props}
        comparisons={[
          {
            ...comparison("https://mirror.example/v1", {
              durationMs: 10,
              capabilityVerified: true,
            }),
            recommended: true,
          } as EndpointsSectionProps["comparisons"][number],
        ]}
      />
    )
    expect(screen.getByText("endpoints.recommended")).toBeInTheDocument()
  })

  it("disables both comparisons when there is nothing to compare", () => {
    render(<EndpointsSection {...props} candidates={[]} />)
    expect(screen.getByRole("button", { name: /endpoints\.compareFree/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: "endpoints.comparePaid" })).toBeDisabled()
  })

  it("disables the paid comparison until a model is selected", () => {
    render(<EndpointsSection {...props} comparePaidDisabled />)
    expect(screen.getByRole("button", { name: "endpoints.comparePaid" })).toBeDisabled()
    expect(screen.getByRole("button", { name: /endpoints\.compareFree/ })).toBeEnabled()
  })

  it("shows the endpoint error", () => {
    render(<EndpointsSection {...props} error="unreachable" />)
    expect(screen.getByText("unreachable")).toBeInTheDocument()
  })

  it("offers at most three undo entries", () => {
    const rollbacks = Array.from(
      { length: 5 },
      (_, i) => ({ id: `r${i}`, previousEndpoint: `https://old${i}` }) as ProviderEndpointChange
    )
    render(<EndpointsSection {...props} rollbacks={rollbacks} />)
    const undos = screen.getAllByRole("button", { name: /endpoints\.rollback/ })
    expect(undos).toHaveLength(3)
    fireEvent.click(undos[0])
    expect(props.onRollback).toHaveBeenCalledWith("r0")
  })

  it("locks every mutation for a paired client", () => {
    render(<EndpointsSection {...props} readOnly />)
    expect(screen.getByRole("button", { name: "endpoints.add" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "endpoints.apply" })).toBeDisabled()
    expect(screen.getByRole("button", { name: /endpoints\.compareFree/ })).toBeDisabled()
  })
})
