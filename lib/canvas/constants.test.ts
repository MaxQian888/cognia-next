/**
 * Canvas Constants - Unit Tests
 */

import {
  LANGUAGE_OPTIONS,
  TRANSLATE_LANGUAGES,
  CANVAS_ACTIONS,
  FORMAT_ACTION_MAP,
  DESIGNER_SUPPORTED_LANGUAGES,
  REACTION_EMOJIS,
  SUGGESTION_TYPE_COLORS,
  KEYBINDING_CATEGORIES,
} from "./constants"

describe("Canvas Constants", () => {
  describe("LANGUAGE_OPTIONS", () => {
    it("should contain common programming languages", () => {
      const values = LANGUAGE_OPTIONS.map((o) => o.value)
      expect(values).toContain("javascript")
      expect(values).toContain("typescript")
      expect(values).toContain("python")
      expect(values).toContain("html")
    })

    it("should have value and label for each option", () => {
      LANGUAGE_OPTIONS.forEach((option) => {
        expect(option.value).toBeTruthy()
        expect(option.label).toBeTruthy()
      })
    })
  })

  describe("TRANSLATE_LANGUAGES", () => {
    it("should contain common languages", () => {
      const values = TRANSLATE_LANGUAGES.map((l) => l.value)
      expect(values).toContain("english")
      expect(values).toContain("chinese")
      expect(values).toContain("japanese")
    })

    it("should have value and label for each language", () => {
      TRANSLATE_LANGUAGES.forEach((lang) => {
        expect(lang.value).toBeTruthy()
        expect(lang.label).toBeTruthy()
      })
    })
  })

  describe("CANVAS_ACTIONS", () => {
    it("should contain all expected action types", () => {
      const types = CANVAS_ACTIONS.map((a) => a.type)
      expect(types).toContain("review")
      expect(types).toContain("fix")
      expect(types).toContain("improve")
      expect(types).toContain("explain")
      expect(types).toContain("simplify")
      expect(types).toContain("expand")
      expect(types).toContain("translate")
      expect(types).toContain("format")
    })

    it("should have labelKey and icon for each action", () => {
      CANVAS_ACTIONS.forEach((action) => {
        expect(action.labelKey).toBeTruthy()
        expect(action.icon).toBeTruthy()
      })
    })

    it("should have at least 8 actions", () => {
      expect(CANVAS_ACTIONS.length).toBeGreaterThanOrEqual(8)
    })
  })

  describe("FORMAT_ACTION_MAP", () => {
    it("should contain basic markdown format actions", () => {
      expect(FORMAT_ACTION_MAP.bold).toBeDefined()
      expect(FORMAT_ACTION_MAP.italic).toBeDefined()
      expect(FORMAT_ACTION_MAP.codeBlock).toBeDefined()
      expect(FORMAT_ACTION_MAP.heading1).toBeDefined()
      expect(FORMAT_ACTION_MAP.link).toBeDefined()
    })

    it("should have prefix and suffix for each format action", () => {
      Object.values(FORMAT_ACTION_MAP).forEach((mapping) => {
        expect(typeof mapping.prefix).toBe("string")
        expect(typeof mapping.suffix).toBe("string")
      })
    })

    it("bold should wrap with double asterisks", () => {
      expect(FORMAT_ACTION_MAP.bold.prefix).toBe("**")
      expect(FORMAT_ACTION_MAP.bold.suffix).toBe("**")
    })

    it("italic should wrap with underscores", () => {
      expect(FORMAT_ACTION_MAP.italic.prefix).toBe("_")
      expect(FORMAT_ACTION_MAP.italic.suffix).toBe("_")
    })
  })

  describe("DESIGNER_SUPPORTED_LANGUAGES", () => {
    it("should include jsx, tsx, html, javascript, typescript", () => {
      expect(DESIGNER_SUPPORTED_LANGUAGES).toContain("jsx")
      expect(DESIGNER_SUPPORTED_LANGUAGES).toContain("tsx")
      expect(DESIGNER_SUPPORTED_LANGUAGES).toContain("html")
      expect(DESIGNER_SUPPORTED_LANGUAGES).toContain("javascript")
      expect(DESIGNER_SUPPORTED_LANGUAGES).toContain("typescript")
    })

    it("should not include non-designer languages", () => {
      expect(DESIGNER_SUPPORTED_LANGUAGES).not.toContain("python")
      expect(DESIGNER_SUPPORTED_LANGUAGES).not.toContain("css")
    })
  })

  describe("REACTION_EMOJIS", () => {
    it("should contain common reaction emojis", () => {
      expect(REACTION_EMOJIS).toContain("👍")
      expect(REACTION_EMOJIS).toContain("👎")
      expect(REACTION_EMOJIS).toContain("❤️")
    })

    it("should have at least 5 emojis", () => {
      expect(REACTION_EMOJIS.length).toBeGreaterThanOrEqual(5)
    })
  })

  describe("SUGGESTION_TYPE_COLORS", () => {
    it("should have color classes for each suggestion type", () => {
      expect(SUGGESTION_TYPE_COLORS.fix).toBeDefined()
      expect(SUGGESTION_TYPE_COLORS.improve).toBeDefined()
      expect(SUGGESTION_TYPE_COLORS.comment).toBeDefined()
      expect(SUGGESTION_TYPE_COLORS.edit).toBeDefined()
    })

    it("should contain Tailwind CSS class strings", () => {
      Object.values(SUGGESTION_TYPE_COLORS).forEach((colorClass) => {
        expect(colorClass).toContain("text-")
        expect(colorClass).toContain("bg-")
      })
    })
  })

  describe("KEYBINDING_CATEGORIES", () => {
    it("should have all expected categories", () => {
      expect(KEYBINDING_CATEGORIES.canvas).toBeDefined()
      expect(KEYBINDING_CATEGORIES.action).toBeDefined()
      expect(KEYBINDING_CATEGORIES.navigation).toBeDefined()
      expect(KEYBINDING_CATEGORIES.view).toBeDefined()
      expect(KEYBINDING_CATEGORIES.edit).toBeDefined()
      expect(KEYBINDING_CATEGORIES.fold).toBeDefined()
    })

    it("should have canvas bindings prefixed with canvas.", () => {
      KEYBINDING_CATEGORIES.canvas.forEach((binding) => {
        expect(binding.startsWith("canvas.")).toBe(true)
      })
    })

    it("should have action bindings prefixed with action.", () => {
      KEYBINDING_CATEGORIES.action.forEach((binding) => {
        expect(binding.startsWith("action.")).toBe(true)
      })
    })

    it("should have canvas.save in canvas category", () => {
      expect(KEYBINDING_CATEGORIES.canvas).toContain("canvas.save")
    })

    it("should have action.review in action category", () => {
      expect(KEYBINDING_CATEGORIES.action).toContain("action.review")
    })
  })
})
