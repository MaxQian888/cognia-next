import {
  LOCAL_PROVIDER_PORTS,
  LOCAL_PROVIDER_NAMES,
  LOCAL_PROVIDER_URLS,
  formatLocalModelSize,
  getOpenAICompatibleURL,
  isLocalProviderName,
} from "./local-provider"

describe("isLocalProviderName", () => {
  it("recognizes supported local provider ids", () => {
    expect(isLocalProviderName("ollama")).toBe(true)
    expect(isLocalProviderName("lmstudio")).toBe(true)
    expect(isLocalProviderName("openai")).toBe(false)
  })

  it("exposes one canonical local-provider id list", () => {
    expect(LOCAL_PROVIDER_NAMES).toEqual([
      "ollama",
      "lmstudio",
      "llamacpp",
      "llamafile",
      "vllm",
      "localai",
      "jan",
      "textgenwebui",
      "koboldcpp",
      "tabbyapi",
    ])
  })
})

describe("local provider defaults", () => {
  it("keeps ports and base URLs aligned", () => {
    expect(LOCAL_PROVIDER_PORTS.ollama).toBe(11434)
    expect(LOCAL_PROVIDER_URLS.ollama).toBe("http://localhost:11434")
    expect(LOCAL_PROVIDER_URLS.lmstudio).toContain(String(LOCAL_PROVIDER_PORTS.lmstudio))
  })
})

describe("formatLocalModelSize", () => {
  it("formats bytes with binary units", () => {
    expect(formatLocalModelSize(0)).toBe("0 B")
    expect(formatLocalModelSize(1024)).toBe("1 KB")
    expect(formatLocalModelSize(1024 * 1024 * 2.5)).toBe("2.5 MB")
  })
})

describe("getOpenAICompatibleURL", () => {
  it("trims trailing slashes and appends /v1 only once", () => {
    expect(getOpenAICompatibleURL(" http://localhost:1234/ ")).toBe("http://localhost:1234/v1")
    expect(getOpenAICompatibleURL("http://localhost:1234/v1")).toBe("http://localhost:1234/v1")
  })
})
