/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import {
  DEFAULT_ADD_AGENT_FORM_DATA,
  addAgentFormForPreset,
} from "@/lib/ai/agent/external/config/add-agent-form"
import { getPresetConfig } from "@/lib/ai/agent/external/config/presets"

import { useAddAgentForm } from "./use-add-agent-form"

describe("useAddAgentForm", () => {
  it("starts blank without a preset", () => {
    const { result } = renderHook(() => useAddAgentForm())
    expect(result.current.presetId).toBe("")
    expect(result.current.data).toEqual(DEFAULT_ADD_AGENT_FORM_DATA)
    expect(result.current.processEnvRows).toEqual([])
    expect(result.current.shape.isStdio).toBe(true)
  })

  it("seeds the fields and environment rows a preset implies", () => {
    const expected = addAgentFormForPreset(DEFAULT_ADD_AGENT_FORM_DATA, "claude-code")!
    const { result } = renderHook(() => useAddAgentForm("claude-code"))
    expect(result.current.presetId).toBe("claude-code")
    expect(result.current.data).toEqual(expected.data)
    expect(result.current.data.name).toBe(getPresetConfig("claude-code")!.name)
    expect(result.current.processEnvRows).toEqual(
      Object.entries(expected.processEnv ?? {}).map(([key, value]) => ({
        key,
        value: String(value),
      }))
    )
  })

  it("updates one field without touching the rest", () => {
    const { result } = renderHook(() => useAddAgentForm("claude-code"))
    const before = result.current.data
    act(() => result.current.setField("name", "Mine"))
    expect(result.current.data).toEqual({ ...before, name: "Mine" })
  })

  it("applies a preset on top of what the user already changed elsewhere", () => {
    const { result } = renderHook(() => useAddAgentForm())
    act(() => result.current.setField("retryMaxRetries", "9"))
    act(() => result.current.applyPreset("claude-code"))
    expect(result.current.presetId).toBe("claude-code")
    expect(result.current.data.command).toBe(getPresetConfig("claude-code")!.process?.command)
    expect(result.current.data.retryMaxRetries).toBe("9")
  })

  it("switching to custom records the choice and keeps the fields as they are", () => {
    const { result } = renderHook(() => useAddAgentForm("claude-code"))
    const before = result.current.data
    act(() => result.current.applyPreset("custom"))
    expect(result.current.presetId).toBe("custom")
    expect(result.current.data).toEqual(before)
  })

  it("prepares a trimmed submission with the environment folded in and the preset recorded", () => {
    const { result } = renderHook(() => useAddAgentForm("claude-code"))
    act(() => {
      result.current.setField("name", "  Claude  ")
      result.current.setField("command", "  npx  ")
      result.current.setProcessEnvRows([
        { key: " TOKEN ", value: "abc" },
        { key: "", value: "ignored" },
      ])
    })
    const prepared = result.current.prepare()
    expect(prepared).toEqual({
      ok: true,
      data: expect.objectContaining({
        name: "Claude",
        command: "npx",
        preset: "claude-code",
        processEnv: { TOKEN: "abc" },
      }),
    })
  })

  it("reports the problem instead of a submission when the form is invalid", () => {
    const { result } = renderHook(() => useAddAgentForm())
    expect(result.current.prepare()).toEqual({ ok: false, problem: "nameRequired" })
    act(() => result.current.setField("name", "A"))
    expect(result.current.prepare()).toEqual({ ok: false, problem: "commandRequired" })
    act(() => {
      result.current.setField("command", "npx")
      result.current.setProcessEnvRows([
        { key: "K", value: "1" },
        { key: "K", value: "2" },
      ])
    })
    expect(result.current.prepare()).toEqual({ ok: false, problem: "environmentInvalid" })
  })

  it("does not record a blank preset id", () => {
    const { result } = renderHook(() => useAddAgentForm())
    act(() => {
      result.current.setField("name", "A")
      result.current.setField("command", "npx")
    })
    const prepared = result.current.prepare()
    expect(prepared.ok && prepared.data.preset).toBeUndefined()
  })

  it("resets to a blank form", () => {
    const { result } = renderHook(() => useAddAgentForm("claude-code"))
    act(() => result.current.reset())
    expect(result.current.presetId).toBe("")
    expect(result.current.data).toEqual(DEFAULT_ADD_AGENT_FORM_DATA)
    expect(result.current.processEnvRows).toEqual([])
  })
})
