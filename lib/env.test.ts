import { getPublicEnv } from "./env"

describe("getPublicEnv", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("returns appName when NEXT_PUBLIC_APP_NAME is set", () => {
    process.env.NEXT_PUBLIC_APP_NAME = "My App"
    delete process.env.NEXT_PUBLIC_API_URL
    expect(getPublicEnv()).toEqual({ appName: "My App", apiUrl: undefined })
  })

  it("includes apiUrl when NEXT_PUBLIC_API_URL is set", () => {
    process.env.NEXT_PUBLIC_APP_NAME = "My App"
    process.env.NEXT_PUBLIC_API_URL = "https://api.test"
    expect(getPublicEnv()).toEqual({ appName: "My App", apiUrl: "https://api.test" })
  })

  it("throws when NEXT_PUBLIC_APP_NAME is missing", () => {
    delete process.env.NEXT_PUBLIC_APP_NAME
    expect(() => getPublicEnv()).toThrow(/NEXT_PUBLIC_APP_NAME/)
  })
})
