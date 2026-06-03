import {
  createOcrCredentialsResolver,
  getOcrSecret,
  setOcrSecret,
  clearOcrSecret,
  resolveMainProviderKey,
  OCR_KEYRING_NAMESPACE,
} from "./credentials"

const getSecret = jest.fn()
const setSecret = jest.fn()
const clearSecret = jest.fn()
jest.mock("@/lib/keyring", () => ({
  getSecret: (...args: unknown[]) => getSecret(...args),
  setSecret: (...args: unknown[]) => setSecret(...args),
  clearSecret: (...args: unknown[]) => clearSecret(...args),
}))

const getSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettings(),
}))

const resolveFeatureProvider = jest.fn()
jest.mock("@/lib/ai/provider-consumption", () => ({
  createProviderSettingsSnapshot: (x: unknown) => x,
  resolveFeatureProvider: (...args: unknown[]) => resolveFeatureProvider(...args),
}))

beforeEach(() => {
  getSecret.mockReset()
  setSecret.mockReset()
  clearSecret.mockReset()
  getSettings.mockReset()
  resolveFeatureProvider.mockReset()
  getSettings.mockResolvedValue({
    defaultProvider: "anthropic",
    providerSettings: {},
    customProviders: [],
  })
})

describe("OCR secret keyring helpers", () => {
  it("reads a secret under the ocr namespace keyed by provider:key", async () => {
    getSecret.mockResolvedValue("sk-123")
    const v = await getOcrSecret("mistral-ocr", "apiKey")
    expect(v).toBe("sk-123")
    expect(getSecret).toHaveBeenCalledWith({
      namespace: OCR_KEYRING_NAMESPACE,
      key: "mistral-ocr:apiKey",
    })
  })

  it("writes a non-empty secret and clears on empty", async () => {
    await setOcrSecret("mistral-ocr", "apiKey", "sk-9")
    expect(setSecret).toHaveBeenCalledWith(
      { namespace: OCR_KEYRING_NAMESPACE, key: "mistral-ocr:apiKey" },
      "sk-9"
    )
    await setOcrSecret("mistral-ocr", "apiKey", "")
    expect(clearSecret).toHaveBeenCalledWith({
      namespace: OCR_KEYRING_NAMESPACE,
      key: "mistral-ocr:apiKey",
    })
  })

  it("clears a secret explicitly", async () => {
    await clearOcrSecret("ocr-space", "apiKey")
    expect(clearSecret).toHaveBeenCalledWith({
      namespace: OCR_KEYRING_NAMESPACE,
      key: "ocr-space:apiKey",
    })
  })
})

describe("resolveMainProviderKey", () => {
  it("returns the resolved apiKey", async () => {
    resolveFeatureProvider.mockReturnValue({ kind: "resolved", apiKey: "main-key" })
    expect(await resolveMainProviderKey("anthropic")).toBe("main-key")
  })

  it("returns null when unresolved", async () => {
    resolveFeatureProvider.mockReturnValue({
      kind: "unresolved",
      reason: "x",
      attemptedProviderIds: [],
    })
    expect(await resolveMainProviderKey("anthropic")).toBeNull()
  })

  it("returns null when resolved without a key (base-url only)", async () => {
    resolveFeatureProvider.mockReturnValue({ kind: "resolved", apiKey: undefined })
    expect(await resolveMainProviderKey("anthropic")).toBeNull()
  })
})

describe("createOcrCredentialsResolver", () => {
  it("collects only the declared keys that have stored values", async () => {
    const readSecret = jest.fn(async (_p: string, k: string) => (k === "apiKey" ? "v" : null))
    const getMainProviderKey = jest.fn(async () => "main")
    const resolve = createOcrCredentialsResolver({ readSecret, getMainProviderKey })
    const creds = await resolve("aws-textract", ["apiKey", "secretAccessKey"])
    expect(creds.secrets).toEqual({ apiKey: "v" })
    expect(creds.getMainProviderKey).toBe(getMainProviderKey)
    expect(readSecret).toHaveBeenCalledTimes(2)
  })

  it("defaults to the real keyring + main-provider resolver", async () => {
    getSecret.mockResolvedValue("kv")
    const resolve = createOcrCredentialsResolver()
    const creds = await resolve("mistral-ocr", ["apiKey"])
    expect(creds.secrets).toEqual({ apiKey: "kv" })
    expect(typeof creds.getMainProviderKey).toBe("function")
  })
})
