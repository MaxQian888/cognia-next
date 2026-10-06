import { buildVectorRuntimeAdapters, installVectorRuntimeAdapters } from "./runtime-adapters"
import { getVectorRuntimeAdapters } from "@cognia/vector/runtime-adapters"
import { isTauri } from "@/lib/platform/detect"
import { createBedrockSidecarEmbeddingModel } from "@/lib/claude/feature-call"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"

jest.mock("@/lib/platform/detect", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/claude/feature-call", () => ({
  createBedrockSidecarEmbeddingModel: jest.fn(() => ({ modelId: "sidecar" })),
}))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: jest.fn(() => hooks),
}))
const hooks = { dispatchDocumentsIndexed: jest.fn(), dispatchVectorSearch: jest.fn() }

beforeEach(() => jest.clearAllMocks())

test("installs live host platform detection synchronously", () => {
  installVectorRuntimeAdapters()
  jest.mocked(isTauri).mockReturnValue(false)
  expect(getVectorRuntimeAdapters().isTauri()).toBe(false)
  jest.mocked(isTauri).mockReturnValue(true)
  expect(getVectorRuntimeAdapters().isTauri()).toBe(true)
})

test("keeps default-chain credentials and sidecar model execution", async () => {
  const runtime = buildVectorRuntimeAdapters()
  const model = await runtime.createBedrockEmbeddingModel({
    modelId: "titan",
    bedrock: {
      authMode: "default-chain",
      region: "us-east-1",
      profile: "work",
      roleArn: "role",
      roleSessionName: "session",
      baseURL: "https://bedrock.example",
    },
  })
  expect(model).toEqual({ modelId: "sidecar" })
  expect(createBedrockSidecarEmbeddingModel).toHaveBeenCalledWith({
    modelId: "titan",
    providerId: "bedrock",
    credentials: {
      protocol: "bedrock",
      bedrockAuthMode: "default-chain",
      region: "us-east-1",
      profile: "work",
      roleArn: "role",
      roleSessionName: "session",
      baseURL: "https://bedrock.example",
    },
  })
})

test("dispatches through the current plugin hook instance and surfaces failures", async () => {
  const runtime = buildVectorRuntimeAdapters()
  await runtime.dispatchDocumentsIndexed("docs", 2)
  await runtime.dispatchVectorSearch("docs", "query", 3)
  expect(hooks.dispatchDocumentsIndexed).toHaveBeenCalledWith("docs", 2)
  expect(hooks.dispatchVectorSearch).toHaveBeenCalledWith("docs", "query", 3)
  expect(getPluginEventHooks).toHaveBeenCalledTimes(2)
  hooks.dispatchVectorSearch.mockImplementationOnce(() => {
    throw new Error("hook error")
  })
  await expect(runtime.dispatchVectorSearch("docs", "query", 3)).rejects.toThrow("hook error")
})
