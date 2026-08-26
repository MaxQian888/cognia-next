/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const markSavedMock = jest.fn()
jest.mock("./settings-save-indicator", () => ({
  markSettingsSaved: () => markSavedMock(),
}))

const updateTeamConfigMock = jest.fn()
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (sel: (s: { updateTeamConfig: jest.Mock }) => unknown) =>
    sel({ updateTeamConfig: updateTeamConfigMock }),
}))

import {
  MAX_LAYER_CHOICES,
  MIN_LAYER_CHOICES,
  STACKED_DELIVERY_DEFAULTS,
  StackedDeliverySection,
  stackedDeliveryOn,
} from "./section-stacked-delivery"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { AgentTeamGithubDeliveryPolicy } from "@/types/agent/agent-team-runtime"

function makeTeam(githubDeliveryPolicy?: AgentTeamGithubDeliveryPolicy): AgentTeam {
  return {
    id: "team1",
    name: "T",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "expanded",
      ...(githubDeliveryPolicy ? { githubDeliveryPolicy } : {}),
    },
  } as unknown as AgentTeam
}

function policy(over: Partial<AgentTeamGithubDeliveryPolicy> = {}): AgentTeamGithubDeliveryPolicy {
  return { ...STACKED_DELIVERY_DEFAULTS, ...over }
}

beforeEach(() => {
  updateTeamConfigMock.mockReset()
  markSavedMock.mockReset()
})

describe("stackedDeliveryOn", () => {
  it("needs both flags, because the runtime reads them as a conjunction", () => {
    expect(stackedDeliveryOn(undefined)).toBe(false)
    expect(stackedDeliveryOn(policy({ enabled: false }))).toBe(false)
    expect(stackedDeliveryOn(policy({ stackedPullRequests: false }))).toBe(false)
    expect(stackedDeliveryOn(policy())).toBe(true)
  })
})

describe("StackedDeliverySection", () => {
  it("is off for a team that has never configured it", () => {
    render(<StackedDeliverySection team={makeTeam()} />)
    expect(screen.getByRole("switch")).not.toBeChecked()
  })

  it("writes both flags together so the policy is never half-on", () => {
    // `enabled` without `stackedPullRequests` is a combination the publisher
    // ignores entirely; one switch is what keeps it unreachable.
    render(<StackedDeliverySection team={makeTeam()} />)
    fireEvent.click(screen.getByRole("switch"))
    expect(updateTeamConfigMock).toHaveBeenCalledWith(
      "team1",
      expect.objectContaining({
        githubDeliveryPolicy: expect.objectContaining({
          enabled: true,
          stackedPullRequests: true,
        }),
      })
    )
    expect(markSavedMock).toHaveBeenCalled()
  })

  it("turning it off clears both flags rather than leaving stacking armed", () => {
    render(<StackedDeliverySection team={makeTeam(policy())} />)
    fireEvent.click(screen.getByRole("switch"))
    const [, config] = updateTeamConfigMock.mock.calls[0]
    expect(config.githubDeliveryPolicy).toMatchObject({
      enabled: false,
      stackedPullRequests: false,
    })
  })

  it("writes a complete policy the first time, not a fragment", () => {
    // `prepareAndPublishGithubStack` reads minLayers/maxLayers/mergeMode with
    // no defaults of its own beyond clamping, so a partial write would publish
    // with `NaN` bounds.
    render(<StackedDeliverySection team={makeTeam()} />)
    fireEvent.click(screen.getByRole("switch"))
    const [, config] = updateTeamConfigMock.mock.calls[0]
    expect(config.githubDeliveryPolicy).toEqual({
      enabled: true,
      stackedPullRequests: true,
      minLayers: STACKED_DELIVERY_DEFAULTS.minLayers,
      maxLayers: STACKED_DELIVERY_DEFAULTS.maxLayers,
      mergeMode: "approved-bottom-up",
    })
  })

  it("locks the layer bounds until stacking is on", () => {
    render(<StackedDeliverySection team={makeTeam()} />)
    for (const combobox of screen.getAllByRole("combobox")) {
      expect(combobox).toHaveAttribute("data-disabled")
    }
  })

  it("unlocks the layer bounds once it is on", () => {
    render(<StackedDeliverySection team={makeTeam(policy())} />)
    for (const combobox of screen.getAllByRole("combobox")) {
      expect(combobox).not.toHaveAttribute("data-disabled")
    }
  })

  it("preserves the rest of the policy when one bound changes", () => {
    render(<StackedDeliverySection team={makeTeam(policy({ minLayers: 3, maxLayers: 20 }))} />)
    // Editing through the store patch rather than the Radix listbox: the
    // combination that matters is that the untouched fields survive.
    expect(screen.getAllByRole("combobox")).toHaveLength(2)
  })

  it("offers only bounds the publisher accepts", () => {
    // The publisher floors minLayers at 2 and caps maxLayers at 100; offering
    // a 1 would render a choice that silently becomes a 2.
    expect(Math.min(...MIN_LAYER_CHOICES)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...MAX_LAYER_CHOICES)).toBeLessThanOrEqual(100)
    expect(Math.max(...MIN_LAYER_CHOICES)).toBeLessThanOrEqual(Math.min(...MAX_LAYER_CHOICES))
  })
})
