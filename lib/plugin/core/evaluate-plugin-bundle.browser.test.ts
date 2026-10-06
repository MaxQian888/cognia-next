/** @jest-environment jsdom */
import { Blob as NodeBlob } from "node:buffer"
import { evaluatePluginBundleAsync, PluginEvaluationError } from "./evaluate-plugin-bundle"
import { primeSharedModulesFor } from "./shared-modules"
import { definePlugin } from "@cognia/plugin-sdk"

const blobs = new Map<string, NodeBlob>()
let sequence = 0
let append: jest.SpyInstance
const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL
const originalBlob = globalThis.Blob

beforeEach(() => {
  globalThis.Blob = NodeBlob as unknown as typeof Blob
  URL.createObjectURL = jest.fn((blob: Blob) => {
    const url = `blob:test-${++sequence}`
    blobs.set(url, blob as unknown as NodeBlob)
    return url
  })
  URL.revokeObjectURL = jest.fn((url: string) => {
    blobs.delete(url)
  })
  const nativeAppend = document.head.appendChild.bind(document.head)
  append = jest.spyOn(document.head, "appendChild").mockImplementation((node) => {
    nativeAppend(node)
    const script = node as HTMLScriptElement
    void blobs
      .get(script.src)!
      .text()
      .then((source) => {
        try {
          ;(0, eval)(source)
        } catch (error) {
          window.dispatchEvent(new ErrorEvent("error", { error, filename: script.src }))
        }
        script.onload?.(new Event("load"))
      })
    return node
  })
})
afterEach(() => {
  append.mockRestore()
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
  globalThis.Blob = originalBlob
  blobs.clear()
  jest.useRealTimers()
})

it("runs concurrent CJS scripts against the host SDK and cleans up every handoff", async () => {
  await primeSharedModulesFor('require("@cognia/plugin-sdk")')
  const before = Object.getOwnPropertyNames(globalThis)
  const results = await Promise.all([
    evaluatePluginBundleAsync(
      'module.exports = { definePlugin: require("@cognia/plugin-sdk").definePlugin, id: 1 }',
      "/one.js"
    ),
    evaluatePluginBundleAsync("exports.id = 2; // final comment", "/two.js"),
  ])
  expect(results[0].definePlugin).toBe(definePlugin)
  expect(results.map((entry) => entry.id)).toEqual([1, 2])
  expect(document.querySelectorAll('script[src^="blob:"]')).toHaveLength(0)
  expect(Object.getOwnPropertyNames(globalThis).filter((key) => !before.includes(key))).toEqual([])
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
})

it("propagates execution and syntax failures without leaving globals or scripts", async () => {
  await expect(
    evaluatePluginBundleAsync('throw new Error("broken plugin")', "/bad.js")
  ).rejects.toThrow("broken plugin")
  await expect(evaluatePluginBundleAsync("const = ;", "/syntax.js")).rejects.toBeInstanceOf(
    PluginEvaluationError
  )
  expect(document.querySelectorAll('script[src^="blob:"]')).toHaveLength(0)
  expect(blobs.size).toBe(0)
})

it("rejects private imports before creating an executable URL", async () => {
  await expect(
    evaluatePluginBundleAsync('require("@/stores/secret")', "/private.js")
  ).rejects.toThrow("host-private")
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it("cleans up a blocked or stalled script after its deadline", async () => {
  jest.useFakeTimers()
  append.mockImplementation((node) => node)
  const result = evaluatePluginBundleAsync("exports.ready = true", "/stalled.js", { timeoutMs: 20 })
  const rejected = expect(result).rejects.toThrow("timed out")
  jest.advanceTimersByTime(20)
  await rejected
  expect(blobs.size).toBe(0)
  expect(
    Object.getOwnPropertyNames(globalThis).filter((key) =>
      key.startsWith("__cogniaPluginEvaluation_")
    )
  ).toEqual([])
})
