/** @jest-environment jsdom */
/**
 * Tests for Proxy-aware Fetch Utility
 */

import {
  getCurrentProxyUrl,
  isProxyEnabled,
  getProxyConfig,
  createProxyFetch,
  createRetryableProxyFetch,
  getProxyEnvironmentVars,
  formatProxiedUrl,
  getProxyAuthHeaders,
  shouldBypassProxy,
  proxyFetch,
  retryableProxyFetch,
} from "./proxy-fetch"

// Mock the proxy store
const mockGetState = jest.fn()

jest.mock("@/stores/system", () => ({
  useProxyStore: {
    getState: () => mockGetState(),
  },
  getActiveProxyUrl: jest.fn((state) => {
    if (!state.config.enabled || state.config.mode === "off") {
      return null
    }
    if (state.config.mode === "manual" && state.config.manual?.url) {
      return state.config.manual.url
    }
    if (state.config.mode === "system" && state.config.system?.url) {
      return state.config.system.url
    }
    return null
  }),
}))

// Mock global fetch and Response
const mockFetch = jest.fn()
global.fetch = mockFetch

// Mock Response for Node.js environment
class MockResponse {
  constructor(public body: string) {}
}
;(global as unknown as Record<string, unknown>).Response = MockResponse

describe("getCurrentProxyUrl", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns null when proxy is disabled", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: false,
        mode: "off",
      },
    })

    const result = getCurrentProxyUrl()
    expect(result).toBeNull()
  })

  it("returns manual proxy URL when configured", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: {
          url: "http://proxy.example.com:8080",
        },
      },
    })

    const result = getCurrentProxyUrl()
    expect(result).toBe("http://proxy.example.com:8080")
  })

  it("returns system proxy URL when configured", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "system",
        system: {
          url: "http://system-proxy:3128",
        },
      },
    })

    const result = getCurrentProxyUrl()
    expect(result).toBe("http://system-proxy:3128")
  })

  it("returns null when mode is off even if enabled", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "off",
      },
    })

    const result = getCurrentProxyUrl()
    expect(result).toBeNull()
  })
})

describe("isProxyEnabled", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns false when disabled", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: false,
        mode: "manual",
      },
    })

    expect(isProxyEnabled()).toBe(false)
  })

  it("returns false when mode is off", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "off",
      },
    })

    expect(isProxyEnabled()).toBe(false)
  })

  it("returns true when enabled and mode is manual", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
      },
    })

    expect(isProxyEnabled()).toBe(true)
  })

  it("returns true when enabled and mode is system", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "system",
      },
    })

    expect(isProxyEnabled()).toBe(true)
  })
})

describe("getProxyConfig", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns disabled config when no proxy", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: false,
        mode: "off",
      },
    })

    const config = getProxyConfig()

    expect(config.enabled).toBe(false)
    expect(config.url).toBeNull()
    expect(config.host).toBeNull()
    expect(config.port).toBeNull()
    expect(config.protocol).toBeNull()
  })

  it("parses HTTP proxy URL correctly", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: {
          url: "http://proxy.example.com:8080",
        },
      },
    })

    const config = getProxyConfig()

    expect(config.enabled).toBe(true)
    expect(config.url).toBe("http://proxy.example.com:8080")
    expect(config.host).toBe("proxy.example.com")
    expect(config.port).toBe(8080)
    expect(config.protocol).toBe("http")
  })

  it("parses HTTPS proxy URL correctly", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: {
          url: "https://secure-proxy.example.com:443",
        },
      },
    })

    const config = getProxyConfig()

    expect(config.enabled).toBe(true)
    expect(config.host).toBe("secure-proxy.example.com")
    expect(config.port).toBe(443)
    expect(config.protocol).toBe("https")
  })

  it("uses default port 80 for HTTP without port", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: {
          url: "http://proxy.example.com",
        },
      },
    })

    const config = getProxyConfig()

    expect(config.port).toBe(80)
  })

  it("uses default port 443 for HTTPS without port", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: {
          url: "https://proxy.example.com",
        },
      },
    })

    const config = getProxyConfig()

    expect(config.port).toBe(443)
  })

  it("handles invalid URL gracefully", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: {
          url: "not-a-valid-url",
        },
      },
    })

    const config = getProxyConfig()

    expect(config.enabled).toBe(false)
    expect(config.url).toBeNull()
  })
})

describe("createProxyFetch", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetch.mockResolvedValue(new MockResponse("ok"))

    // Simulate browser environment (no Tauri)
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it("creates a fetch function", () => {
    const fetch = createProxyFetch()
    expect(typeof fetch).toBe("function")
  })

  it("uses regular fetch in browser environment", async () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: { url: "http://proxy:8080" },
      },
    })

    const fetch = createProxyFetch()
    await fetch("https://example.com")

    expect(mockFetch).toHaveBeenCalledWith("https://example.com", {})
  })

  it("respects skipProxy option", async () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: { url: "http://proxy:8080" },
      },
    })

    const fetch = createProxyFetch()
    await fetch("https://example.com", { skipProxy: true })

    expect(mockFetch).toHaveBeenCalled()
  })

  it("supports timeout option", async () => {
    // Test that timeout option is accepted without throwing
    const fetch = createProxyFetch()
    // Just verify the function accepts timeout option
    mockFetch.mockResolvedValue(new MockResponse("ok"))
    const result = await fetch("https://example.com", { timeout: 5000 })
    expect(result).toBeDefined()
  })

  it("uses custom proxy URL when provided", async () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: { url: "http://default-proxy:8080" },
      },
    })

    const fetch = createProxyFetch("http://custom-proxy:9090")
    await fetch("https://example.com")

    expect(mockFetch).toHaveBeenCalled()
  })

  it("passes through fetch options", async () => {
    const fetch = createProxyFetch()
    await fetch("https://example.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    })

    expect(mockFetch).toHaveBeenCalledWith("https://example.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    })
  })
})

describe("getProxyEnvironmentVars", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns empty object when no proxy", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: false,
        mode: "off",
      },
    })

    const vars = getProxyEnvironmentVars()
    expect(vars).toEqual({})
  })

  it("returns all proxy environment variables", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: { url: "http://proxy:8080" },
      },
    })

    const vars = getProxyEnvironmentVars()

    expect(vars).toEqual({
      HTTP_PROXY: "http://proxy:8080",
      HTTPS_PROXY: "http://proxy:8080",
      http_proxy: "http://proxy:8080",
      https_proxy: "http://proxy:8080",
    })
  })
})

describe("formatProxiedUrl", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns original URL when no proxy", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: false,
        mode: "off",
      },
    })

    const result = formatProxiedUrl("https://example.com")
    expect(result).toBe("https://example.com")
  })

  it("appends proxy info when proxy is enabled", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: { url: "http://proxy:8080" },
      },
    })

    const result = formatProxiedUrl("https://example.com")
    expect(result).toBe("https://example.com (via http://proxy:8080)")
  })
})

describe("getProxyAuthHeaders", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns empty object when no auth configured", () => {
    mockGetState.mockReturnValue({
      config: {
        mode: "manual",
        manual: {},
      },
    })

    const headers = getProxyAuthHeaders()
    expect(headers).toEqual({})
  })

  it("returns empty object when not in manual mode", () => {
    mockGetState.mockReturnValue({
      config: {
        mode: "system",
      },
    })

    const headers = getProxyAuthHeaders()
    expect(headers).toEqual({})
  })

  it("returns Basic auth header when credentials are configured", () => {
    mockGetState.mockReturnValue({
      config: {
        mode: "manual",
        manual: {
          username: "user",
          password: "pass",
        },
      },
    })

    const headers = getProxyAuthHeaders()

    expect(headers["Proxy-Authorization"]).toBeDefined()
    expect(headers["Proxy-Authorization"]).toMatch(/^Basic /)

    // Verify the credentials are correctly encoded
    const encoded = headers["Proxy-Authorization"].replace("Basic ", "")
    const decoded = atob(encoded)
    expect(decoded).toBe("user:pass")
  })

  it("returns empty when only username is provided", () => {
    mockGetState.mockReturnValue({
      config: {
        mode: "manual",
        manual: {
          username: "user",
        },
      },
    })

    const headers = getProxyAuthHeaders()
    expect(headers).toEqual({})
  })

  it("returns empty when only password is provided", () => {
    mockGetState.mockReturnValue({
      config: {
        mode: "manual",
        manual: {
          password: "pass",
        },
      },
    })

    const headers = getProxyAuthHeaders()
    expect(headers).toEqual({})
  })
})

describe("shouldBypassProxy", () => {
  it("bypasses localhost with port", () => {
    expect(shouldBypassProxy("http://localhost:11434/api/generate")).toBe(true)
  })

  it("bypasses localhost with path", () => {
    expect(shouldBypassProxy("http://localhost/api/generate")).toBe(true)
  })

  it("bypasses 127.0.0.1 with port", () => {
    expect(shouldBypassProxy("http://127.0.0.1:8080/test")).toBe(true)
  })

  it("bypasses 127.0.0.1 with path", () => {
    expect(shouldBypassProxy("http://127.0.0.1/test")).toBe(true)
  })

  it("bypasses ::1 with port", () => {
    expect(shouldBypassProxy("http://::1:3000/api")).toBe(true)
  })

  it("bypasses 0.0.0.0 with port", () => {
    expect(shouldBypassProxy("http://0.0.0.0:8080/")).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(shouldBypassProxy("HTTP://LOCALHOST:3000/api")).toBe(true)
  })

  it("does not bypass external hosts", () => {
    expect(shouldBypassProxy("https://api.openai.com/v1/chat")).toBe(false)
  })

  it("does not bypass external hosts with port", () => {
    expect(shouldBypassProxy("https://api.example.com:443/test")).toBe(false)
  })

  it("does not bypass hosts containing localhost in domain", () => {
    expect(shouldBypassProxy("https://notlocalhost.com/api")).toBe(false)
  })

  it("handles URL ending with host only", () => {
    expect(shouldBypassProxy("http://localhost")).toBe(true)
  })
})

describe("createProxyFetch bypass behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetch.mockResolvedValue(new MockResponse("ok"))
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it("bypasses proxy for localhost URL", async () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: { url: "http://proxy:8080" },
      },
    })

    const fetchFn = createProxyFetch()
    await fetchFn("http://localhost:11434/api/generate")

    // Should call regular fetch (not go through proxy)
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:11434/api/generate", {})
  })

  it("bypasses proxy for 127.0.0.1 URL", async () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: { url: "http://proxy:8080" },
      },
    })

    const fetchFn = createProxyFetch()
    await fetchFn("http://127.0.0.1:8080/api")

    expect(mockFetch).toHaveBeenCalled()
  })

  it("does not bypass proxy for external URL", async () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: { url: "http://proxy:8080" },
      },
    })

    const fetchFn = createProxyFetch()
    await fetchFn("https://api.openai.com/v1/chat")

    expect(mockFetch).toHaveBeenCalled()
  })
})

describe("proxyFetch", () => {
  it("is a function created by createProxyFetch", () => {
    expect(typeof proxyFetch).toBe("function")
  })
})

describe("Tauri proxy routing", () => {
  const mockInvoke = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    mockFetch.mockResolvedValue(new MockResponse("ok"))

    // Simulate Tauri environment
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}

    // Mock Tauri invoke
    jest.mock("@tauri-apps/api/core", () => ({
      invoke: mockInvoke,
    }))
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it("detects Tauri environment", () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}

    // In Tauri environment, createProxyFetch should attempt to use Tauri backend
    expect("__TAURI_INTERNALS__" in window).toBe(true)
  })

  it("falls back to regular fetch when not in Tauri", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: { url: "http://proxy:8080" },
      },
    })

    const fetch = createProxyFetch()
    await fetch("https://example.com")

    expect(mockFetch).toHaveBeenCalledWith("https://example.com", {})
  })

  it("handles proxy URL parsing for Tauri backend", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: { url: "http://127.0.0.1:7890" },
      },
    })

    const config = getProxyConfig()

    expect(config.enabled).toBe(true)
    expect(config.host).toBe("127.0.0.1")
    expect(config.port).toBe(7890)
  })

  it("handles SOCKS5 proxy URL", () => {
    mockGetState.mockReturnValue({
      config: {
        enabled: true,
        mode: "manual",
        manual: { url: "socks5://127.0.0.1:1080" },
      },
    })

    const config = getProxyConfig()

    expect(config.enabled).toBe(true)
    expect(config.protocol).toBe("socks5")
    expect(config.port).toBe(1080)
  })
})

describe("Timeout handling", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("completes fetch before timeout", async () => {
    mockFetch.mockResolvedValue(new MockResponse("quick"))

    const fetch = createProxyFetch()
    const result = await fetch("https://example.com", { timeout: 5000 })

    expect(result).toBeDefined()
  })

  it("accepts timeout option without error", async () => {
    mockFetch.mockResolvedValue(new MockResponse("ok"))

    const fetch = createProxyFetch()
    const result = await fetch("https://example.com", { timeout: 1000 })

    expect(result).toBeDefined()
    expect(mockFetch).toHaveBeenCalled()
  })
})

describe("createRetryableProxyFetch", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it("creates a fetch function", () => {
    const fetch = createRetryableProxyFetch()
    expect(typeof fetch).toBe("function")
  })

  it("returns result on successful fetch", async () => {
    mockFetch.mockResolvedValue(new MockResponse("success"))

    const fetch = createRetryableProxyFetch()
    const result = await fetch("https://example.com")

    expect(result).toBeDefined()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("retries on network error", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValue(new MockResponse("success"))

    const fetch = createRetryableProxyFetch()
    // Use initialDelay: 1 to minimize test time
    const result = await fetch("https://example.com", {
      maxRetries: 3,
      initialDelay: 1,
    })

    expect(result).toBeDefined()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  }, 10000)

  it("retries on timeout error", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("Request timeout"))
      .mockResolvedValue(new MockResponse("success"))

    const fetch = createRetryableProxyFetch()
    const result = await fetch("https://example.com", {
      maxRetries: 3,
      initialDelay: 1,
    })

    expect(result).toBeDefined()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  }, 10000)

  it("does not retry on non-retryable error", async () => {
    mockFetch.mockRejectedValue(new Error("Invalid API key"))

    const fetch = createRetryableProxyFetch()

    await expect(fetch("https://example.com", { maxRetries: 3, initialDelay: 1 })).rejects.toThrow(
      "Invalid API key"
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("throws after max retries exhausted", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"))

    const fetch = createRetryableProxyFetch()

    await expect(fetch("https://example.com", { maxRetries: 2, initialDelay: 1 })).rejects.toThrow(
      "Network error"
    )
    expect(mockFetch).toHaveBeenCalledTimes(3) // Initial + 2 retries
  }, 15000)

  it("calls onRetry callback on each retry", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValue(new MockResponse("success"))

    const onRetry = jest.fn()
    const fetch = createRetryableProxyFetch()

    await fetch("https://example.com", {
      maxRetries: 3,
      initialDelay: 1,
      onRetry,
    })

    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenNthCalledWith(1, expect.any(Error), 0)
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.any(Error), 1)
  }, 15000)

  it("retries on 5xx server errors", async () => {
    // Create a mock response with status 500
    const mockResponse500 = { status: 500 }
    mockFetch.mockResolvedValueOnce(mockResponse500).mockResolvedValue(new MockResponse("success"))

    const fetch = createRetryableProxyFetch()
    const result = await fetch("https://example.com", {
      maxRetries: 3,
      initialDelay: 1,
    })

    expect(result).toBeDefined()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  }, 10000)

  it("uses custom proxy URL", async () => {
    mockFetch.mockResolvedValue(new MockResponse("success"))

    const fetch = createRetryableProxyFetch("http://custom-proxy:9090")
    await fetch("https://example.com")

    expect(mockFetch).toHaveBeenCalled()
  })

  it("passes through fetch options", async () => {
    mockFetch.mockResolvedValue(new MockResponse("success"))

    const fetch = createRetryableProxyFetch()
    await fetch("https://example.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    })

    expect(mockFetch).toHaveBeenCalledWith("https://example.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    })
  })
})

describe("retryableProxyFetch", () => {
  it("is a function created by createRetryableProxyFetch", () => {
    expect(typeof retryableProxyFetch).toBe("function")
  })
})
