/** @jest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react"

const mockCodeSandboxStatus = jest.fn(async () => ({ confined: false, backend: "", detail: "" }))
const mockSnapshot = {
  os: { available: false, backend: "", reason: "probe-required", detail: "" },
  microvm: { available: false, reason: "adapter-missing", requiresWorkspace: true },
}
jest.mock("@/lib/ai/code-mode/sandbox-status", () => ({
  codeSandboxStatus: () => mockCodeSandboxStatus(),
}))
jest.mock("@/lib/sandbox/runtime-availability", () => ({
  getSandboxRuntimeAvailability: () => mockSnapshot,
  subscribeSandboxRuntimeAvailability: () => () => undefined,
}))

import { useSandboxRuntimeAvailability } from "./use-sandbox-runtime-availability"

it("starts the shared active probe and returns the common projection", async () => {
  const { result } = renderHook(() => useSandboxRuntimeAvailability())
  expect(result.current).toBe(mockSnapshot)
  await waitFor(() => expect(mockCodeSandboxStatus).toHaveBeenCalledTimes(1))
})
