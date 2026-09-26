/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import en from "@/i18n/messages/en.json"
import zhCN from "@/i18n/messages/zh-CN.json"

import type { BiometricBlockReason } from "./use-biometric-guard"
import { useBiometricBlockReason } from "./use-biometric-block-reason"

const REASONS: BiometricBlockReason[] = ["cancelled", "lockout", "unavailable", "error"]

describe("useBiometricBlockReason", () => {
  it.each([
    ["lockout", "Too many attempts. Unlock your phone, then try again."],
    ["unavailable", "Biometric check isn't available on this device."],
    ["error", "The biometric check failed."],
    ["cancelled", "The biometric check was cancelled."],
  ] as const)("renders %s as a sentence, not the code", (reason, sentence) => {
    const { result } = renderHook(() => useBiometricBlockReason())
    const label = result.current(reason)
    expect(label).toBe(sentence)
    expect(label).not.toContain(`common.biometricBlocked`)
  })

  /**
   * The label is the whole point of the hook; a locale that is missing one
   * would fall back to the key path and put a code back in front of the user.
   */
  it.each(REASONS)("has a %s label in both locales", (reason) => {
    const enLabel = en.common.biometricBlocked[reason]
    const zhLabel = zhCN.common.biometricBlocked[reason]
    expect(enLabel).toMatch(/\.$/)
    expect(zhLabel).toMatch(/。$/)
    expect(enLabel.toLowerCase()).not.toBe(reason)
    expect(zhLabel).not.toContain(reason)
  })
})
