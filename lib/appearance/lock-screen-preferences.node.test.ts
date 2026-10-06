/** @jest-environment node */

import {
  clearLockScreenPreferences,
  DEFAULT_MIRRORED_PREFERENCES,
  readLockScreenPreferences,
  writeLockScreenPreferences,
} from "./lock-screen-preferences"

it("does not access Node's process-wide Web Storage during server rendering", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const getStorage = jest.fn(() => {
    throw new Error("Node Web Storage must not be accessed")
  })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: getStorage })
  try {
    expect(readLockScreenPreferences()).toEqual(DEFAULT_MIRRORED_PREFERENCES)
    writeLockScreenPreferences(DEFAULT_MIRRORED_PREFERENCES)
    clearLockScreenPreferences()
    expect(getStorage).not.toHaveBeenCalled()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor)
    else Reflect.deleteProperty(globalThis, "localStorage")
  }
})
