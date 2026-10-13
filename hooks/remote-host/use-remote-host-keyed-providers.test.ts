/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import {
  clearRemoteHostKeyedProviders,
  resetRemoteHostKeysForTests,
  setRemoteHostKeyedProviders,
} from "@/lib/host-secrets/remote-host-keys"

import { useRemoteHostKeyedProviders } from "./use-remote-host-keyed-providers"

afterEach(() => resetRemoteHostKeysForTests())

it("follows the providers the driven Host keys", () => {
  const { result } = renderHook(() => useRemoteHostKeyedProviders())
  expect(result.current.size).toBe(0)

  act(() => setRemoteHostKeyedProviders("host-1", ["deepseek"]))
  expect([...result.current]).toEqual(["deepseek"])

  act(() => clearRemoteHostKeyedProviders())
  expect(result.current.size).toBe(0)
})
