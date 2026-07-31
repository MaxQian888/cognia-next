/**
 * A2UI Catalog Tests
 */

import {
  DEFAULT_CATALOG_ID,
  registerComponent,
  getComponent,
  hasComponent,
  getRegisteredTypes,
  getRegisteredCatalogIds,
  createCatalog,
  registerCatalog,
  unregisterComponent,
  clearRegistry,
  getStandardComponentTypes,
  componentCategories,
  getComponentCategory,
  validateComponent,
  resolveWidgetMetadata,
} from "./catalog"
import type { A2UIComponent, A2UIComponentProps } from "@/types/a2ui/schema"

describe("A2UI Catalog", () => {
  beforeEach(() => {
    clearRegistry()
  })

  describe("DEFAULT_CATALOG_ID", () => {
    it("should be defined", () => {
      expect(DEFAULT_CATALOG_ID).toBeDefined()
      expect(typeof DEFAULT_CATALOG_ID).toBe("string")
    })
  })

  describe("createCatalog", () => {
    it("should create a new catalog", () => {
      const catalog = createCatalog("test-catalog")
      expect(catalog.id).toBe("test-catalog")
      expect(catalog.name).toBe("Custom Catalog: test-catalog")
    })

    it("should create default catalog with correct name", () => {
      const catalog = createCatalog()
      expect(catalog.id).toBe(DEFAULT_CATALOG_ID)
      expect(catalog.name).toBe("Cognia Standard Catalog")
    })
  })

  describe("registerComponent and getComponent", () => {
    it("should register and retrieve component", () => {
      const MockComponent: React.FC<A2UIComponentProps<A2UIComponent>> = () => null
      registerComponent("Text", MockComponent)

      const entry = getComponent("Text")
      expect(entry).toBeDefined()
      expect(entry?.type).toBe("Text")
    })
  })

  describe("hasComponent", () => {
    it("should return true for existing component", () => {
      const MockComponent: React.FC<A2UIComponentProps<A2UIComponent>> = () => null
      registerComponent("Button", MockComponent)
      expect(hasComponent("Button")).toBe(true)
    })

    it("should return false for non-existing component", () => {
      expect(hasComponent("NonExistingComponent")).toBe(false)
    })
  })

  describe("unregisterComponent", () => {
    it("should remove registered component", () => {
      const MockComponent: React.FC<A2UIComponentProps<A2UIComponent>> = () => null
      registerComponent("TextField", MockComponent)
      expect(hasComponent("TextField")).toBe(true)

      unregisterComponent("TextField")
      expect(hasComponent("TextField")).toBe(false)
    })
  })

  describe("getRegisteredTypes", () => {
    it("should list all registered component types", () => {
      const MockComponent: React.FC<A2UIComponentProps<A2UIComponent>> = () => null
      registerComponent("Text", MockComponent)
      registerComponent("Button", MockComponent)

      const types = getRegisteredTypes()
      expect(types).toContain("Text")
      expect(types).toContain("Button")
    })
  })

  describe("getRegisteredCatalogIds", () => {
    it("always includes the standard catalog and every component-backed catalog", () => {
      const MockComponent: React.FC<A2UIComponentProps<A2UIComponent>> = () => null
      registerComponent("Text", MockComponent, { catalogId: "zeta-catalog" })
      registerComponent("Button", MockComponent, { catalogId: "alpha-catalog" })

      expect(getRegisteredCatalogIds()).toEqual([
        DEFAULT_CATALOG_ID,
        "alpha-catalog",
        "zeta-catalog",
      ])
    })

    it("includes explicitly registered catalogs without duplicating ids", () => {
      const MockComponent: React.FC<A2UIComponentProps<A2UIComponent>> = () => null
      registerCatalog({
        id: "plugin-catalog",
        name: "Plugin catalog",
        version: "1.0.0",
        components: {
          Text: { type: "Text", component: MockComponent },
        },
      })

      expect(getRegisteredCatalogIds()).toEqual([DEFAULT_CATALOG_ID, "plugin-catalog"])
    })
  })

  describe("getStandardComponentTypes", () => {
    it("should return array of standard component types", () => {
      const types = getStandardComponentTypes()
      expect(Array.isArray(types)).toBe(true)
      expect(types).toContain("Text")
      expect(types).toContain("Button")
      expect(types).toContain("TextField")
      expect(types).toContain("ComparisonCards")
      expect(types).toContain("StepperShell")
      expect(types).toContain("MockupFrame")
      expect(types).toContain("WidgetStatus")
    })
  })

  describe("componentCategories", () => {
    it("should define component categories", () => {
      expect(componentCategories).toBeDefined()
      expect(typeof componentCategories).toBe("object")
    })

    it("assigns every standard catalog type to exactly one editor category", () => {
      const categorizedTypes = Object.values(componentCategories).flat()
      const standardTypes = getStandardComponentTypes()
      expect(standardTypes.filter((type) => !categorizedTypes.includes(type))).toEqual([])
      expect(new Set(categorizedTypes).size).toBe(categorizedTypes.length)
    })
  })

  describe("getComponentCategory", () => {
    it("should return category for known component types", () => {
      expect(getComponentCategory("Text")).toBe("display")
      expect(getComponentCategory("Button")).toBe("action")
      expect(getComponentCategory("Row")).toBe("layout")
      expect(getComponentCategory("TextField")).toBe("input")
      expect(getComponentCategory("Chart")).toBe("data")
    })
  })

  describe("validateComponent", () => {
    it("should validate component structure", () => {
      // Register a component first so validation can pass
      const MockComponent: React.FC<A2UIComponentProps<A2UIComponent>> = () => null
      registerComponent("Text", MockComponent)

      const component = { id: "text-1", component: "Text" as const, text: "Hello" }
      const result = validateComponent(component)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("should fail for component without id", () => {
      const component = { component: "Text" as const, text: "Hello" }
      const result = validateComponent(component as A2UIComponent)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain("Component must have an id")
    })

    it("should fail for unregistered component type", () => {
      const component = { id: "custom-1", component: "CustomWidget" as const }
      const result = validateComponent(component as A2UIComponent)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Unknown component type"))).toBe(true)
    })
  })

  describe("resolveWidgetMetadata", () => {
    it("applies configured defaults when component metadata omits the fields", () => {
      const metadata = resolveWidgetMetadata(
        { id: "text-1", component: "Text", text: "Hello" },
        { hostStrategy: "lazy-runtime", theme: "dark" }
      )

      expect(metadata.hostStrategy).toBe("lazy-runtime")
      expect(metadata.theme).toBe("dark")
    })

    it("keeps a rich-output profile's safe host while applying other configured defaults", () => {
      const metadata = resolveWidgetMetadata(
        {
          id: "rich-1",
          component: "RichOutput",
          profileId: "how-it-works-physical",
        },
        { hostStrategy: "native", theme: "dark" }
      )

      expect(metadata.hostStrategy).toBe("artifact-preview")
      expect(metadata.theme).toBe("dark")
    })

    it("returns deterministic defaults for standard native components", () => {
      const metadata = resolveWidgetMetadata({ id: "text-1", component: "Text", text: "Hello" })

      expect(metadata.hostStrategy).toBe("native")
      expect(metadata.sizing).toBe("auto")
      expect(metadata.theme).toBe("inherit")
      expect(metadata.showChrome).toBe(true)
    })

    it("prefers explicit widget metadata over inferred defaults", () => {
      const metadata = resolveWidgetMetadata({
        id: "rich-1",
        component: "RichOutput",
        profileId: "how-it-works-physical",
        widget: {
          hostStrategy: "sandboxed-html",
          sizing: "content-height",
          theme: "dark",
          showChrome: false,
        },
      })

      expect(metadata.hostStrategy).toBe("sandboxed-html")
      expect(metadata.sizing).toBe("content-height")
      expect(metadata.theme).toBe("dark")
      expect(metadata.showChrome).toBe(false)
    })
  })
})
