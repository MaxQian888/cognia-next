/**
 * @jest-environment jsdom
 */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import type {
  LiveVoiceDeployment,
  LiveVoiceProviderId,
  LiveVoiceRegion,
  LiveVoiceSettings,
} from "@cognia/agent-config-types"

const saveMock = jest.fn()
let currentLiveVoice: Partial<LiveVoiceSettings> | undefined

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (
    selector: (state: { settings: Record<string, unknown>; save: jest.Mock }) => unknown
  ) => selector({ settings: { liveVoice: currentLiveVoice }, save: saveMock }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => false),
}))

jest.mock("./api-key-input", () => ({
  ApiKeyInput: ({ provider }: { provider: string }) => (
    <div data-testid="api-key-provider">{provider}</div>
  ),
}))

import { LiveVoiceCard } from "./live-voice-card"
import { isTauri } from "@/lib/platform/detect"

const mockIsTauri = jest.mocked(isTauri)

/** The last `liveVoice` block handed to the settings store. */
function savedLiveVoice(): LiveVoiceSettings {
  return saveMock.mock.calls.at(-1)?.[0]?.liveVoice
}

function enabledDeployment(
  provider: LiveVoiceProviderId = "openai",
  region: LiveVoiceRegion = "global"
): LiveVoiceDeployment {
  return { id: `${provider}-${region}`, provider, region, enabled: true }
}

beforeEach(() => {
  jest.clearAllMocks()
  currentLiveVoice = undefined
  mockIsTauri.mockReturnValue(false)
})

describe("LiveVoiceCard — top-level controls", () => {
  it("renders defaults for an install that has never configured live voice", () => {
    render(<LiveVoiceCard />)

    expect(screen.getByLabelText("enabled")).not.toBeChecked()
    // Fallback defaults on, so a misbehaving primary does not end the session.
    expect(screen.getByLabelText("fallback")).toBeChecked()
  })

  it("writes a complete block when the master switch is flipped", () => {
    render(<LiveVoiceCard />)

    fireEvent.click(screen.getByLabelText("enabled"))

    // A partial write would strip the defaults the resolver depends on.
    expect(savedLiveVoice()).toMatchObject({
      enabled: true,
      region: "global",
      maxCandidates: 3,
      connectTimeoutMs: 10_000,
      historyTurnLimit: 12,
      historyCharacterLimit: 16_000,
    })
  })

  it("persists the instructions used as the session persona", () => {
    render(<LiveVoiceCard />)

    fireEvent.change(screen.getByLabelText("instructions"), { target: { value: "be brief" } })

    expect(savedLiveVoice().instructions).toBe("be brief")
  })

  it("toggles cross-provider fallback", () => {
    currentLiveVoice = { enabled: true, fallbackEnabled: true }
    render(<LiveVoiceCard />)

    fireEvent.click(screen.getByLabelText("fallback"))

    expect(savedLiveVoice().fallbackEnabled).toBe(false)
  })
})

describe("LiveVoiceCard — providers", () => {
  it("offers the providers that ship an adapter for the global region", () => {
    render(<LiveVoiceCard />)

    expect(screen.getByLabelText("providers.openai")).toBeInTheDocument()
    expect(screen.getByLabelText("providers.google")).toBeInTheDocument()
    expect(screen.getByLabelText("providers.xai")).toBeInTheDocument()
  })

  it("keeps native-only China providers out of static web settings", () => {
    render(<LiveVoiceCard />)

    fireEvent.click(screen.getByLabelText("region"))

    expect(screen.queryByText("regionCn")).not.toBeInTheDocument()
  })

  it("offers every implemented China provider in Tauri", () => {
    mockIsTauri.mockReturnValue(true)
    currentLiveVoice = { enabled: true, region: "cn" }
    render(<LiveVoiceCard />)

    expect(screen.getByLabelText("providers.qwen")).toBeInTheDocument()
    expect(screen.getByLabelText("providers.doubao")).toBeInTheDocument()
    expect(screen.getByLabelText("providers.baidu")).toBeInTheDocument()
    expect(screen.queryByLabelText("providers.openai")).not.toBeInTheDocument()
  })

  it("creates a deployment with a region-derived id when a provider is switched on", () => {
    render(<LiveVoiceCard />)

    fireEvent.click(screen.getByLabelText("providers.google"))

    expect(savedLiveVoice().deployments).toEqual([
      { id: "google-global", provider: "google", region: "global", enabled: true },
    ])
  })

  it("keeps a provider's settings when it is switched off and on again", () => {
    currentLiveVoice = {
      enabled: true,
      deployments: [{ ...enabledDeployment(), model: "gpt-realtime-custom" }],
    }
    render(<LiveVoiceCard />)

    fireEvent.click(screen.getByLabelText("providers.openai"))

    // Disabling must not orphan the row — the derived id makes it recoverable.
    expect(savedLiveVoice().deployments).toEqual([
      {
        id: "openai-global",
        provider: "openai",
        region: "global",
        enabled: false,
        model: "gpt-realtime-custom",
      },
    ])
  })

  it("leaves other providers untouched when one is toggled", () => {
    currentLiveVoice = {
      enabled: true,
      deployments: [enabledDeployment(), enabledDeployment("xai")],
    }
    render(<LiveVoiceCard />)

    fireEvent.click(screen.getByLabelText("providers.xai"))

    expect(savedLiveVoice().deployments).toHaveLength(2)
    expect(savedLiveVoice().deployments[0]).toEqual(enabledDeployment())
  })

  it("shows model, voice and key fields only for an enabled provider", () => {
    currentLiveVoice = { enabled: true, deployments: [enabledDeployment()] }
    render(<LiveVoiceCard />)

    expect(screen.getByLabelText("model")).toBeInTheDocument()
    expect(screen.getByTestId("api-key-provider")).toHaveTextContent("openai")
    // Google is off, so it contributes no second set of fields.
    expect(screen.getAllByLabelText("model")).toHaveLength(1)
  })

  it("suggests the provider's default model rather than pre-filling it", () => {
    // An empty value means "use the default"; pre-filling would freeze today's
    // model id into the user's settings forever.
    currentLiveVoice = { enabled: true, deployments: [enabledDeployment()] }
    render(<LiveVoiceCard />)

    const model = screen.getByLabelText("model")
    expect(model).toHaveValue("")
    expect(model).toHaveAttribute("placeholder", "gpt-realtime-2.1")
  })

  it("records a model override against the right deployment", () => {
    currentLiveVoice = { enabled: true, deployments: [enabledDeployment()] }
    render(<LiveVoiceCard />)

    fireEvent.change(screen.getByLabelText("model"), { target: { value: "gpt-realtime-next" } })

    expect(savedLiveVoice().deployments[0].model).toBe("gpt-realtime-next")
  })

  it("records a voice override", () => {
    currentLiveVoice = { enabled: true, deployments: [enabledDeployment()] }
    render(<LiveVoiceCard />)

    fireEvent.change(screen.getByLabelText("voice"), { target: { value: "cedar" } })

    expect(savedLiveVoice().deployments[0].voice).toBe("cedar")
  })

  it("drives China-provider fields from the shared descriptor registry", () => {
    mockIsTauri.mockReturnValue(true)
    currentLiveVoice = {
      enabled: true,
      region: "cn",
      deployments: [enabledDeployment("qwen", "cn")],
    }
    render(<LiveVoiceCard />)

    expect(screen.getByLabelText("workspaceId")).toBeInTheDocument()
    expect(screen.getByLabelText("model")).toHaveAttribute(
      "placeholder",
      "qwen-audio-3.0-realtime-plus"
    )
    expect(screen.queryByLabelText("appId")).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("workspaceId"), { target: { value: "ws-beijing" } })
    expect(savedLiveVoice().deployments[0].workspaceId).toBe("ws-beijing")
  })

  it("stores Doubao App ID without exposing model controls", () => {
    mockIsTauri.mockReturnValue(true)
    currentLiveVoice = {
      enabled: true,
      region: "cn",
      deployments: [enabledDeployment("doubao", "cn")],
    }
    render(<LiveVoiceCard />)

    expect(screen.getByLabelText("appId")).toBeInTheDocument()
    expect(screen.queryByLabelText("model")).not.toBeInTheDocument()
    expect(screen.getByLabelText("voice")).toHaveAttribute(
      "placeholder",
      "zh_female_vv_jupiter_bigtts"
    )
  })
})

describe("LiveVoiceCard — primary provider", () => {
  it("cannot be chosen before a provider is enabled", () => {
    render(<LiveVoiceCard />)

    expect(screen.getByLabelText("preferred")).toBeDisabled()
  })

  it("becomes selectable once a provider is on", () => {
    currentLiveVoice = { enabled: true, deployments: [enabledDeployment()] }
    render(<LiveVoiceCard />)

    expect(screen.getByLabelText("preferred")).not.toBeDisabled()
  })
})
