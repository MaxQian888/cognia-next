import {
  __resetPackWarningRefreshWiringForTesting,
  installPackWarningRefreshWiring,
} from "./warning-refresh-wiring"
import { subscribeThemePackRegistry } from "@/lib/theme/theme-pack-registry"
import { refreshAllPackWarnings } from "@/lib/plugin/registries/character-pack-registry"

jest.mock("@/lib/theme/theme-pack-registry", () => ({
  subscribeThemePackRegistry: jest.fn(),
}))

jest.mock("@/lib/plugin/registries/character-pack-registry", () => ({
  refreshAllPackWarnings: jest.fn(),
}))

const mockSubscribe = subscribeThemePackRegistry as jest.MockedFunction<
  typeof subscribeThemePackRegistry
>
const mockRefresh = refreshAllPackWarnings as jest.MockedFunction<typeof refreshAllPackWarnings>

describe("pack warning refresh wiring", () => {
  const unsubscribe = jest.fn()
  let listener: (() => void) | undefined

  beforeEach(() => {
    jest.clearAllMocks()
    listener = undefined
    mockSubscribe.mockImplementation((next) => {
      listener = next
      return unsubscribe
    })
    __resetPackWarningRefreshWiringForTesting()
    unsubscribe.mockClear()
  })

  afterEach(() => {
    __resetPackWarningRefreshWiringForTesting()
  })

  it("refreshes all character-pack warnings after a theme-pack change", () => {
    installPackWarningRefreshWiring()

    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    listener?.()
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it("is idempotent and shares one teardown", () => {
    const first = installPackWarningRefreshWiring()
    const second = installPackWarningRefreshWiring()

    expect(second).toBe(first)
    expect(mockSubscribe).toHaveBeenCalledTimes(1)

    first()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("allows a fresh subscription after teardown", () => {
    installPackWarningRefreshWiring()()
    installPackWarningRefreshWiring()

    expect(mockSubscribe).toHaveBeenCalledTimes(2)
  })

  it("reset tears down an installed subscription", () => {
    installPackWarningRefreshWiring()
    __resetPackWarningRefreshWiringForTesting()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
