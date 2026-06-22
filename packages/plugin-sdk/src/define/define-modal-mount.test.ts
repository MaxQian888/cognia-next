import { defineModalMount } from "./define-modal-mount"

describe("defineModalMount", () => {
  it("returns the modal mount definition unchanged", () => {
    const def = {
      id: "settings",
      label: "Settings",
      entry: "src/modals/settings.tsx",
      export: "SettingsModal",
    }

    expect(defineModalMount(def)).toBe(def)
  })
})
