// Smoke test: the barrel export is the public surface for the appearance
// section. If any of these names disappear, downstream consumers (settings
// shell, storybook, tests) break loudly.

import * as appearance from "./index"

describe("components/settings/appearance barrel", () => {
  it("re-exports the section + every tab", () => {
    expect(appearance.AppearanceSection).toBeDefined()
    expect(appearance.ThemeTab).toBeDefined()
    expect(appearance.TypographyTab).toBeDefined()
    expect(appearance.WallpaperTab).toBeDefined()
    expect(appearance.CustomThemeTab).toBeDefined()
    expect(appearance.VscodeImportTab).toBeDefined()
    expect(appearance.AdvancedTab).toBeDefined()
  })
})
