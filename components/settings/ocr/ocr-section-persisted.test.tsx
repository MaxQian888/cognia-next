import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { OcrSectionPersisted } from "./ocr-section-persisted"
import { DEFAULT_OCR_SETTINGS } from "@/types/ocr"

// --- mocks ---------------------------------------------------------------

let liveSettings: unknown = DEFAULT_OCR_SETTINGS
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveSettings,
}))

const getSettings = jest.fn()
const saveSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettings(),
  saveSettings: (p: unknown) => saveSettings(p),
}))

jest.mock("@/lib/db/ocr-results", () => ({
  clearOcrCache: jest.fn(async () => 0),
  clearOcrCacheForProvider: jest.fn(async () => 0),
}))

const buildOcrDeps = jest.fn<unknown, [unknown?]>(() => ({ marker: "deps" }))
jest.mock("@/lib/ocr/deps", () => ({
  buildOcrDeps: (o: unknown) => buildOcrDeps(o),
}))

const getOcrSecret = jest.fn()
const setOcrSecret = jest.fn()
jest.mock("@/lib/ocr/credentials", () => ({
  getOcrSecret: (...a: unknown[]) => getOcrSecret(...a),
  setOcrSecret: (...a: unknown[]) => setOcrSecret(...a),
}))

// Stub the heavy presentational section + the provider registry it exports.
jest.mock("./ocr-section", () => ({
  OCR_PROVIDER_REGISTRY: [
    { id: "mistral-ocr", credentialKeys: ["apiKey"] },
    { id: "tesseract-wasm", credentialKeys: [] },
  ],
  OcrSection: (props: {
    credentials: Record<string, Record<string, string>>
    onCredentialChange: (p: string, k: string, v: string) => void
    ocrDepsFactory: () => unknown
  }) => (
    <div>
      <div data-testid="creds">{JSON.stringify(props.credentials)}</div>
      <button onClick={() => props.onCredentialChange("mistral-ocr", "apiKey", "sk-new")}>
        set
      </button>
      <button onClick={() => void props.ocrDepsFactory()}>deps</button>
    </div>
  ),
}))

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}))

beforeEach(() => {
  liveSettings = DEFAULT_OCR_SETTINGS
  getSettings.mockReset().mockResolvedValue({ ocrSettings: DEFAULT_OCR_SETTINGS })
  saveSettings.mockReset().mockResolvedValue(undefined)
  buildOcrDeps.mockClear()
  getOcrSecret.mockReset().mockResolvedValue(null)
  setOcrSecret.mockReset().mockResolvedValue(undefined)
})

describe("OcrSectionPersisted", () => {
  it("loads stored cloud secrets and passes them down", async () => {
    getOcrSecret.mockImplementation(async (provider: string, key: string) =>
      provider === "mistral-ocr" && key === "apiKey" ? "sk-stored" : null
    )
    render(<OcrSectionPersisted />)
    await waitFor(() => expect(screen.getByTestId("creds")).toBeInTheDocument())
    expect(JSON.parse(screen.getByTestId("creds").textContent!)).toEqual({
      "mistral-ocr": { apiKey: "sk-stored" },
    })
    // tesseract-wasm has no credentialKeys → never queried.
    expect(getOcrSecret).toHaveBeenCalledWith("mistral-ocr", "apiKey")
    expect(getOcrSecret).toHaveBeenCalledTimes(1)
  })

  it("persists a credential edit to the keyring", async () => {
    render(<OcrSectionPersisted />)
    await waitFor(() => screen.getByText("set"))
    fireEvent.click(screen.getByText("set"))
    expect(setOcrSecret).toHaveBeenCalledWith("mistral-ocr", "apiKey", "sk-new")
  })

  it("builds real deps from the effective settings", async () => {
    render(<OcrSectionPersisted />)
    await waitFor(() => screen.getByText("deps"))
    fireEvent.click(screen.getByText("deps"))
    expect(buildOcrDeps).toHaveBeenCalledWith({ settings: DEFAULT_OCR_SETTINGS })
  })

  it("migrates a legacy local HTTP plaintext key into the OCR keyring", async () => {
    liveSettings = {
      ...DEFAULT_OCR_SETTINGS,
      providerConfig: {
        "local-http": { endpoint: "http://localhost:1224/api/ocr", apiKey: "legacy-key" },
      },
    }
    render(<OcrSectionPersisted />)

    await waitFor(() =>
      expect(setOcrSecret).toHaveBeenCalledWith("local-http", "apiKey", "legacy-key")
    )
    const migrated = saveSettings.mock.calls.at(-1)![0].ocrSettings
    expect(migrated.providerConfig["local-http"].apiKey).toBeUndefined()
    expect(migrated.providerConfig["local-http"].endpoint).toBe("http://localhost:1224/api/ocr")
  })

  it("normalizes an unavailable saved default provider to auto", async () => {
    liveSettings = { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "mistral-ocr" }
    buildOcrDeps.mockReturnValue({
      registry: { list: () => [{ id: "mistral-ocr" }] },
      platform: "tauri",
      runtimeStatus: async () => ({
        providerId: "mistral-ocr",
        shellSupported: true,
        ready: false,
        reason: "missing-credentials",
      }),
    })

    render(<OcrSectionPersisted />)

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({
        ocrSettings: expect.objectContaining({ defaultProviderId: "auto" }),
      })
    )
  })

  it("normalizes a removed saved default provider to auto", async () => {
    liveSettings = { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "removed-provider" }
    buildOcrDeps.mockReturnValue({
      registry: { list: () => [{ id: "mistral-ocr" }] },
      platform: "tauri",
      runtimeStatus: async () => ({
        providerId: "mistral-ocr",
        shellSupported: true,
        credentialsConfigured: true,
        ready: true,
      }),
    })

    render(<OcrSectionPersisted />)

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({
        ocrSettings: expect.objectContaining({ defaultProviderId: "auto" }),
      })
    )
  })
})
