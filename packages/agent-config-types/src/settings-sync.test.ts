/**
 * The classification table is the source both sync lists are derived from, and
 * the generator's `--check` gate only proves the Rust and OpenAPI copies match
 * this file. What that gate cannot see is whether the derivation itself is
 * right — which direction each category travels, and whether an asymmetry
 * carries the reason it is required to carry. That is what this pins.
 */

import {
  CROSS_PLATFORM_SETTING_KEYS,
  MOBILE_WRITABLE_SETTING_KEYS,
  NON_SYNCED_SETTING_REASONS,
  SETTINGS_SYNC,
  type SettingsSyncCategory,
} from "./settings-sync"

type Key = keyof typeof SETTINGS_SYNC

function keysOf(category: SettingsSyncCategory): Key[] {
  return (Object.keys(SETTINGS_SYNC) as Key[]).filter(
    (key) => SETTINGS_SYNC[key].category === category
  )
}

describe("SETTINGS_SYNC", () => {
  it("classifies every field with a known category", () => {
    const allowed: SettingsSyncCategory[] = [
      "shared",
      "server-authoritative",
      "device-local",
      "desktop-only",
    ]
    for (const key of Object.keys(SETTINGS_SYNC) as Key[]) {
      expect(allowed).toContain(SETTINGS_SYNC[key].category)
    }
  })

  it("requires a rationale on every deliberate asymmetry", () => {
    // Both categories are exceptions to "a setting is the same on every
    // device". An unexplained exception is indistinguishable from a bug six
    // months later, which is why the type demands the field — this asserts the
    // string is actually written rather than left blank to satisfy the type.
    for (const key of [...keysOf("server-authoritative"), ...keysOf("device-local")]) {
      const entry = SETTINGS_SYNC[key] as { rationale?: string }
      expect(typeof entry.rationale).toBe("string")
      expect(entry.rationale?.trim().length ?? 0).toBeGreaterThan(20)
    }
  })

  it("never attaches a rationale to a category that has no asymmetry to explain", () => {
    for (const key of [...keysOf("shared"), ...keysOf("desktop-only")]) {
      expect(SETTINGS_SYNC[key]).not.toHaveProperty("rationale")
    }
  })
})

describe("derived key lists", () => {
  it("lets a client write exactly the shared fields", () => {
    expect([...MOBILE_WRITABLE_SETTING_KEYS].sort()).toEqual(keysOf("shared").sort())
    expect(SETTINGS_SYNC.messageDisplay.category).toBe("shared")
  })

  it("mirrors down the shared fields plus the server-authoritative ones", () => {
    expect([...CROSS_PLATFORM_SETTING_KEYS].sort()).toEqual(
      [...keysOf("shared"), ...keysOf("server-authoritative")].sort()
    )
  })

  it("keeps the writable list a strict subset of the mirrored list", () => {
    // A field a client may write but never receives back is the ~51-field
    // divergence this table replaced: the phone's value and the desktop's
    // could never reconcile, and no amount of syncing would fix it.
    const mirrored = new Set<string>(CROSS_PLATFORM_SETTING_KEYS)
    for (const key of MOBILE_WRITABLE_SETTING_KEYS) {
      expect(mirrored.has(key)).toBe(true)
    }
  })

  it("keeps server-authoritative fields off the writable list", () => {
    const writable = new Set<string>(MOBILE_WRITABLE_SETTING_KEYS)
    for (const key of keysOf("server-authoritative")) {
      expect(writable.has(key)).toBe(false)
    }
  })

  it("keeps device-local and desktop-only fields off both lists", () => {
    const writable = new Set<string>(MOBILE_WRITABLE_SETTING_KEYS)
    const mirrored = new Set<string>(CROSS_PLATFORM_SETTING_KEYS)
    for (const key of [...keysOf("device-local"), ...keysOf("desktop-only")]) {
      expect(writable.has(key)).toBe(false)
      expect(mirrored.has(key)).toBe(false)
    }
  })

  it("emits sorted, duplicate-free lists", () => {
    for (const list of [MOBILE_WRITABLE_SETTING_KEYS, CROSS_PLATFORM_SETTING_KEYS]) {
      expect([...list]).toEqual([...list].sort())
      expect(new Set(list).size).toBe(list.length)
    }
  })

  it("classifies the WebRTC endpoints as flowing down, not up", () => {
    // These were classified backwards: the phone read the signaling address,
    // STUN list and TURN relays from its own copy but only ever received the
    // built-in defaults, so a self-hosted signaling server or TURN relay on the
    // desktop never reached it and strict-NAT connections simply failed.
    const mirrored = new Set<string>(CROSS_PLATFORM_SETTING_KEYS)
    const writable = new Set<string>(MOBILE_WRITABLE_SETTING_KEYS)
    for (const key of ["signalingUrl", "iceServers", "turnServers"] as Key[]) {
      expect(SETTINGS_SYNC[key].category).toBe("server-authoritative")
      expect(mirrored.has(key)).toBe(true)
      expect(writable.has(key)).toBe(false)
    }
    expect(SETTINGS_SYNC.turnProvider.category).toBe("desktop-only")
    expect(mirrored.has("turnProvider")).toBe(false)
    expect(writable.has("turnProvider")).toBe(false)
  })

  it("keeps local OpenAI speech endpoint preferences on the desktop host", () => {
    for (const key of [
      "localOpenaiBaseUrl",
      "localOpenaiModel",
      "localOpenaiVoice",
      "localOpenaiSpeed",
      "localOpenaiResponseFormat",
      "localOpenaiTimeoutMs",
    ] as Key[]) {
      expect(SETTINGS_SYNC[key].category).toBe("desktop-only")
      expect(CROSS_PLATFORM_SETTING_KEYS).not.toContain(key)
      expect(MOBILE_WRITABLE_SETTING_KEYS).not.toContain(key)
    }
  })

  it("keeps the wallpaper library on the device that holds its bytes", () => {
    // `wallpapers` is an array of *references into one machine's storage*, not
    // of values: `disk` is a path under that Tauri host's own appData and
    // `indexeddb` is a key in that browser's blob store. `saveImage()` picks
    // between them by `isTauri()`, so a desktop only ever writes `disk` and a
    // phone only ever writes `indexeddb` — mirroring the array handed each side
    // exactly the kind it cannot resolve. Both galleries filled with unopenable
    // rows, and activating one made the background applier switch the wallpaper
    // off entirely.
    //
    // `background` was already withheld for the same reason (its `activeId`
    // names a row that need not exist on the other device), and
    // `lib/appearance/appearance-config-io.ts` excludes both keys from an
    // exported look. This is the third place that agreement is now pinned.
    const mirrored = new Set<string>(CROSS_PLATFORM_SETTING_KEYS)
    const writable = new Set<string>(MOBILE_WRITABLE_SETTING_KEYS)
    expect(SETTINGS_SYNC.wallpapers.category).toBe("device-local")
    expect(mirrored.has("wallpapers")).toBe(false)
    expect(writable.has("wallpapers")).toBe(false)
    expect(SETTINGS_SYNC.background.category).toBe("desktop-only")
    expect(mirrored.has("background")).toBe(false)
  })

  it("lets the fields a /me page edits travel in both directions", () => {
    // A field a mobile page writes is part of the mobile contract by
    // definition, which is exactly what `desktop-only` denies. `evalSettings`
    // was `desktop-only` while `/me/eval` rendered the desktop eval section
    // whole: the phone showed built-in defaults instead of the host's real
    // config, and every edit stayed on the handset — while the eval runs those
    // defaults govern execute on the desktop.
    const mirrored = new Set<string>(CROSS_PLATFORM_SETTING_KEYS)
    const writable = new Set<string>(MOBILE_WRITABLE_SETTING_KEYS)
    expect(SETTINGS_SYNC.evalSettings.category).toBe("shared")
    expect(mirrored.has("evalSettings")).toBe(true)
    expect(writable.has("evalSettings")).toBe(true)
  })
})

describe("NON_SYNCED_SETTING_REASONS", () => {
  it("covers every device-local field and nothing else", () => {
    expect(Object.keys(NON_SYNCED_SETTING_REASONS).sort()).toEqual(keysOf("device-local").sort())
  })

  it("names the three settings that deliberately stopped travelling", () => {
    // Pushing a phone's biometric policy onto a laptop with no Touch ID could
    // lock it out; the editor perf tier is chosen for one device's GPU; a
    // microphone id means nothing on another machine.
    for (const key of [
      "biometricRequiredFor",
      "workflowEditorPerformanceTier",
      "selectedMicId",
    ] as Key[]) {
      expect(SETTINGS_SYNC[key].category).toBe("device-local")
      expect(NON_SYNCED_SETTING_REASONS[key]).toBeTruthy()
    }
  })
})
