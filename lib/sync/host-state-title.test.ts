import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"

const mockRunTitleTask = jest.fn()
const mockIsTitleInFlight = jest.fn((_key: string) => false)
jest.mock("@/lib/ai/generation/run-title-task", () => ({
  ...jest.requireActual("@/lib/ai/generation/run-title-task"),
  runTitleTask: (...args: unknown[]) => mockRunTitleTask(...args),
  isTitleInFlight: (key: string) => mockIsTitleInFlight(key),
}))
const mockMint = jest.fn()
jest.mock("@/lib/gateway/person-model-ticket", () => ({
  mintPersonModelTicket: (...args: unknown[]) => mockMint(...args),
}))
const mockCreateLlmClient = jest.fn((_config: unknown) => ({ complete: jest.fn() }))
jest.mock("@/lib/twin/distill/llm", () => ({
  createLlmClient: (config: unknown) => mockCreateLlmClient(config),
}))
const mockSessionGet = jest.fn()
jest.mock("@/lib/db", () => ({ getDb: () => ({ sessions: { get: mockSessionGet } }) }))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(async () => null) }))

import {
  createHostStateTitleGenerator,
  deviceWrittenTitle,
  hostStateTitleSource,
  personTitleClient,
} from "./host-state-title"

const text = (id: string, role: "user" | "assistant", body: string): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text: body }],
})

const session = {
  id: "s1",
  title: "Plan the trip",
  providerOverride: "deepseek",
  model: "ark-deepseek-v4.1-flash",
} as ChatSession

beforeEach(() => {
  mockRunTitleTask.mockReset().mockResolvedValue("A title")
  mockIsTitleInFlight.mockReset().mockReturnValue(false)
  mockMint.mockReset()
  mockCreateLlmClient.mockClear()
  mockSessionGet.mockReset()
})

describe("hostStateTitleSource", () => {
  const first = [
    text("u1", "user", "Plan the trip to Kyoto in spring"),
    text("a1", "assistant", "Here is a plan"),
  ]

  it("titles a first turn whose title is still the placeholder or the preview", () => {
    const source = { sourceText: "Plan the trip to Kyoto in spring", resultText: "Here is a plan" }
    expect(hostStateTitleSource(first, "New conversation")).toEqual(source)
    expect(hostStateTitleSource(first, "Plan the trip to Kyoto")).toEqual(source)
    expect(hostStateTitleSource(first, "")).toEqual(source)
  })

  it("leaves a later turn, a chosen title and an empty first message alone", () => {
    expect(
      hostStateTitleSource(
        [...first, text("u2", "user", "More"), text("a2", "assistant", "Sure")],
        "New conversation"
      )
    ).toBeNull()
    expect(hostStateTitleSource(first, "Kyoto itinerary")).toBeNull()
    expect(hostStateTitleSource([first[0]], "New conversation")).toBeNull()
    expect(
      hostStateTitleSource(
        [text("u1", "user", "  "), text("a1", "assistant", "Hi")],
        "New conversation"
      )
    ).toBeNull()
  })
})

describe("createHostStateTitleGenerator", () => {
  const request = {
    session,
    sourceText: "Plan the trip",
    resultText: "Here is a plan",
    currentTitle: "Plan the trip",
  }

  it("titles an owner's conversation with the Host's own utility model", async () => {
    const settings = { language: "zh-CN", conversationTitle: { enabled: true } }
    const generate = createHostStateTitleGenerator({
      settings: async () => settings as never,
      personPartition: () => false,
    })
    await expect(generate(request)).resolves.toBe("A title")
    const args = mockRunTitleTask.mock.calls[0][0]
    expect(args).toMatchObject({
      session,
      appSettings: settings,
      override: settings.conversationTitle,
      featureId: "conversation-title",
      sourceText: "Plan the trip",
      resultText: "Here is a plan",
      locale: "zh-CN",
      currentTitle: "Plan the trip",
      dedupKey: "s1",
    })
    expect(args.buildClient).toBeUndefined()
  })

  it("titles a member's conversation with the org's model through a ticket", async () => {
    const personClient = jest.fn(async () => ({ complete: jest.fn() }))
    const generate = createHostStateTitleGenerator({
      settings: async () => null,
      personPartition: () => true,
      personClient,
    })
    await generate(request)
    const args = mockRunTitleTask.mock.calls[0][0]
    expect(personClient).not.toHaveBeenCalled()
    await args.buildClient()
    expect(personClient).toHaveBeenCalledWith(session)
  })
})

describe("personTitleClient", () => {
  it("calls the org's model at the ticket's endpoint with the ticket's secret", async () => {
    mockMint.mockResolvedValue({ secret: "tkt", endpoint: "http://127.0.0.1:19384/v1" })
    await personTitleClient(session)
    expect(mockMint).toHaveBeenCalledWith("deepseek", "ark-deepseek-v4.1-flash", "s1")
    expect(mockCreateLlmClient).toHaveBeenCalledWith({
      provider: "openai",
      model: "ark-deepseek-v4.1-flash",
      apiKey: "tkt",
      baseURL: "http://127.0.0.1:19384/v1",
      apiFlavor: "chat",
    })
  })

  it("has no client for a conversation that names no model", async () => {
    await expect(personTitleClient({ ...session, model: undefined } as never)).resolves.toBeNull()
    expect(mockMint).not.toHaveBeenCalled()
  })
})

describe("deviceWrittenTitle", () => {
  it("waits for the chat view's own title call, then takes its title from the row", async () => {
    let calls = 0
    mockIsTitleInFlight.mockImplementation(() => ++calls < 3)
    const wait = jest.fn(async () => undefined)
    mockSessionGet.mockResolvedValue({ id: "s1", title: "Kyoto spring trip", titleAuto: true })
    await expect(
      deviceWrittenTitle("s1", "Plan the trip to Kyoto in spring", "Plan the trip to Kyoto", {
        wait,
      })
    ).resolves.toBe("Kyoto spring trip")
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it("takes nothing the chat view did not write as a model title", async () => {
    const source = "Plan the trip to Kyoto in spring"
    for (const row of [
      undefined,
      { title: "Kyoto spring trip", titleAuto: false },
      { title: "Plan the trip to Kyoto", titleAuto: true },
      { title: "New conversation", titleAuto: true },
      { title: "Same as the channel", titleAuto: true },
    ]) {
      mockSessionGet.mockResolvedValueOnce(row)
      await expect(deviceWrittenTitle("s1", source, "Same as the channel")).resolves.toBeNull()
    }
  })

  it("stops waiting at its bound", async () => {
    mockIsTitleInFlight.mockReturnValue(true)
    const wait = jest.fn(async () => undefined)
    mockSessionGet.mockResolvedValue(undefined)
    await deviceWrittenTitle("s1", "x", "y", { wait, waitMs: 1000 })
    expect(wait).toHaveBeenCalledTimes(4)
  })
})
