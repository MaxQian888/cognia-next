/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const probe = jest.fn()
jest.mock("@cognia/provider-core/providers/ollama", () => ({
  probeOllamaModelCapabilities: (...args: unknown[]) => probe(...args),
}))

import { useOllamaModelCapabilities } from "./use-ollama-model-capabilities"

const visionCaps = {
  supportsVision: true,
  supportsTools: true,
  supportsEmbedding: false,
  supportsThinking: false,
  contextLength: 131072,
  architecture: "qwen2",
  inferred: false,
}

beforeEach(() => {
  probe.mockReset()
  probe.mockResolvedValue(visionCaps)
})

describe("useOllamaModelCapabilities", () => {
  it("probes each installed model and keys the answers by model id", async () => {
    const { result } = renderHook(() =>
      useOllamaModelCapabilities({
        providerId: "ollama",
        baseUrl: "http://localhost:11434",
        modelIds: ["qwen2.5-vl:7b", "llama3.2"],
      })
    )

    await waitFor(() => expect(result.current.capabilities.size).toBe(2))
    expect(probe).toHaveBeenCalledWith("http://localhost:11434", "qwen2.5-vl:7b")
    expect(probe).toHaveBeenCalledWith("http://localhost:11434", "llama3.2")
    expect(result.current.capabilities.get("qwen2.5-vl:7b")).toEqual(visionCaps)
  })

  /**
   * `/api/show` is Ollama's endpoint. The other nine local providers have no
   * equivalent, so probing them would be a wasted round-trip at best and an
   * invented answer at worst.
   */
  it("does not probe providers that have no /api/show", async () => {
    const { result } = renderHook(() =>
      useOllamaModelCapabilities({
        providerId: "lmstudio",
        baseUrl: "http://localhost:1234",
        modelIds: ["mistral"],
      })
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(probe).not.toHaveBeenCalled()
    expect(result.current.capabilities.size).toBe(0)
  })

  it("does nothing without a baseUrl or without models", async () => {
    renderHook(() => useOllamaModelCapabilities({ providerId: "ollama", modelIds: ["m"] }))
    renderHook(() =>
      useOllamaModelCapabilities({ providerId: "ollama", baseUrl: "http://x", modelIds: [] })
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(probe).not.toHaveBeenCalled()
  })

  /** One round-trip per model is the price of a real answer — pay it once. */
  it("does not re-probe a model it has already asked about", async () => {
    const { result, rerender } = renderHook(
      (props: { modelIds: string[] }) =>
        useOllamaModelCapabilities({
          providerId: "ollama",
          baseUrl: "http://localhost:11434",
          modelIds: props.modelIds,
        }),
      { initialProps: { modelIds: ["a"] } }
    )
    await waitFor(() => expect(result.current.capabilities.size).toBe(1))
    expect(probe).toHaveBeenCalledTimes(1)

    // Same list, fresh array identity — the sort of thing a parent re-render
    // produces constantly.
    rerender({ modelIds: ["a"] })
    await act(async () => {
      await Promise.resolve()
    })
    expect(probe).toHaveBeenCalledTimes(1)

    // A newly pulled model IS probed, and only it.
    rerender({ modelIds: ["a", "b"] })
    await waitFor(() => expect(result.current.capabilities.size).toBe(2))
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenLastCalledWith("http://localhost:11434", "b")
  })

  /**
   * The cache is keyed by baseUrl, so pointing at a different server re-probes
   * rather than serving another machine's answers for a same-named model.
   */
  it("re-probes when the server changes", async () => {
    const { result, rerender } = renderHook(
      (props: { baseUrl: string }) =>
        useOllamaModelCapabilities({
          providerId: "ollama",
          baseUrl: props.baseUrl,
          modelIds: ["a"],
        }),
      { initialProps: { baseUrl: "http://localhost:11434" } }
    )
    await waitFor(() => expect(result.current.capabilities.size).toBe(1))

    rerender({ baseUrl: "http://127.0.0.1:11500" })
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    expect(probe).toHaveBeenLastCalledWith("http://127.0.0.1:11500", "a")
  })

  it("reports probing state around the round-trip", async () => {
    let release: ((v: unknown) => void) | undefined
    probe.mockImplementation(() => new Promise((r) => (release = r)))

    const { result } = renderHook(() =>
      useOllamaModelCapabilities({
        providerId: "ollama",
        baseUrl: "http://localhost:11434",
        modelIds: ["a"],
      })
    )

    await waitFor(() => expect(result.current.isProbing).toBe(true))
    await act(async () => {
      release?.(visionCaps)
    })
    await waitFor(() => expect(result.current.isProbing).toBe(false))
  })
})
