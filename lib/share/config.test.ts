// Endpoint/secret resolution. Settings + keyring are mocked so the test is
// independent of the runtime (Tauri vs web) and IndexedDB.

const getSettings = jest.fn()
const getSecret = jest.fn()
const setSecret = jest.fn()
const clearSecret = jest.fn()

jest.mock("@/lib/db/settings", () => ({ getSettings: (...a: unknown[]) => getSettings(...a) }))
jest.mock("@/lib/keyring", () => ({
  getSecret: (...a: unknown[]) => getSecret(...a),
  setSecret: (...a: unknown[]) => setSecret(...a),
  clearSecret: (...a: unknown[]) => clearSecret(...a),
}))

import {
  resolveShareEndpoint,
  setShareUploadSecret,
  hasShareUploadSecret,
  DEFAULT_SHARE_URL,
  SHARE_UPLOAD_SECRET_REF,
} from "./config"

beforeEach(() => {
  jest.clearAllMocks()
})

describe("resolveShareEndpoint", () => {
  it("falls back to DEFAULT_SHARE_URL with an empty secret when unconfigured", async () => {
    getSettings.mockResolvedValue({})
    getSecret.mockResolvedValue(null)
    expect(await resolveShareEndpoint()).toEqual({ baseUrl: DEFAULT_SHARE_URL, uploadSecret: "" })
  })

  it("prefers the settings shareUrl and strips trailing slashes", async () => {
    getSettings.mockResolvedValue({ shareUrl: "https://my.share.host/" })
    getSecret.mockResolvedValue("token")
    expect(await resolveShareEndpoint()).toEqual({
      baseUrl: "https://my.share.host",
      uploadSecret: "token",
    })
  })
})

describe("setShareUploadSecret", () => {
  it("stores a non-empty secret", async () => {
    await setShareUploadSecret("abc")
    expect(setSecret).toHaveBeenCalledWith(SHARE_UPLOAD_SECRET_REF, "abc")
    expect(clearSecret).not.toHaveBeenCalled()
  })

  it("clears when given an empty string", async () => {
    await setShareUploadSecret("")
    expect(clearSecret).toHaveBeenCalledWith(SHARE_UPLOAD_SECRET_REF)
    expect(setSecret).not.toHaveBeenCalled()
  })
})

describe("hasShareUploadSecret", () => {
  it("reflects keyring presence", async () => {
    getSecret.mockResolvedValueOnce("x")
    expect(await hasShareUploadSecret()).toBe(true)
    getSecret.mockResolvedValueOnce(null)
    expect(await hasShareUploadSecret()).toBe(false)
  })
})
