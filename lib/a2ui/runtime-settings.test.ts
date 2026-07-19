import {
  DEFAULT_A2UI_PERSISTENCE_LIMIT,
  MAX_A2UI_PERSISTENCE_LIMIT,
  MIN_A2UI_PERSISTENCE_LIMIT,
  getA2UIPersistenceLimit,
  getA2UIWidgetSettingDefaults,
  resolveA2UICatalogId,
} from "./runtime-settings"
import { DEFAULT_CATALOG_ID, clearRegistry, registerComponent } from "./catalog"
import type { A2UIComponent, A2UIComponentProps } from "@/types/a2ui/schema"

describe("A2UI runtime settings", () => {
  beforeEach(() => {
    clearRegistry()
  })

  describe("getA2UIPersistenceLimit", () => {
    it("uses the default when the setting is missing or non-finite", () => {
      expect(getA2UIPersistenceLimit()).toBe(DEFAULT_A2UI_PERSISTENCE_LIMIT)
      expect(getA2UIPersistenceLimit({ a2uiPersistenceLimit: Number.NaN })).toBe(
        DEFAULT_A2UI_PERSISTENCE_LIMIT
      )
    })

    it("clamps and truncates persisted values to the supported range", () => {
      expect(getA2UIPersistenceLimit({ a2uiPersistenceLimit: 1 })).toBe(MIN_A2UI_PERSISTENCE_LIMIT)
      expect(getA2UIPersistenceLimit({ a2uiPersistenceLimit: 120 })).toBe(
        MAX_A2UI_PERSISTENCE_LIMIT
      )
      expect(getA2UIPersistenceLimit({ a2uiPersistenceLimit: 21.9 })).toBe(21)
    })
  })

  describe("resolveA2UICatalogId", () => {
    it("keeps an explicit surface catalog id even before it is registered", () => {
      expect(resolveA2UICatalogId("late-plugin", "stale-setting")).toBe("late-plugin")
    })

    it("uses a registered configured default when the surface omits catalogId", () => {
      const MockComponent: React.FC<A2UIComponentProps<A2UIComponent>> = () => null
      registerComponent("Text", MockComponent, { catalogId: "plugin-catalog" })

      expect(resolveA2UICatalogId(undefined, "plugin-catalog")).toBe("plugin-catalog")
    })

    it("falls back from legacy template-category values to the standard catalog", () => {
      expect(resolveA2UICatalogId(undefined, "productivity")).toBe(DEFAULT_CATALOG_ID)
    })
  })

  describe("getA2UIWidgetSettingDefaults", () => {
    it("projects only configured host and theme defaults", () => {
      expect(
        getA2UIWidgetSettingDefaults({
          a2uiDefaultHostStrategy: "lazy-runtime",
          a2uiDefaultTheme: "dark",
        })
      ).toEqual({ hostStrategy: "lazy-runtime", theme: "dark" })
      expect(getA2UIWidgetSettingDefaults()).toEqual({})
    })
  })
})
