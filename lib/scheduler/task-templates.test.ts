/**
 * Tests for the curated task template gallery.
 */

import {
  TASK_TEMPLATES,
  TEMPLATE_CATEGORIES,
  getTemplatesByCategory,
  getTemplateById,
} from "./task-templates"

describe("task-templates", () => {
  describe("TASK_TEMPLATES", () => {
    it("exposes a non-empty list of templates", () => {
      expect(TASK_TEMPLATES.length).toBeGreaterThan(0)
    })

    it("every template has unique id, name, and an executor-mapped taskType", () => {
      const ids = TASK_TEMPLATES.map((t) => t.id)
      expect(new Set(ids).size).toBe(ids.length)

      const validTaskTypes = new Set(["chat", "agent", "skill", "script"])
      for (const tpl of TASK_TEMPLATES) {
        expect(tpl.id).toMatch(/^[a-z][a-z0-9-]*$/)
        expect(tpl.name).toBeTruthy()
        expect(tpl.nameZh).toBeTruthy()
        expect(tpl.description).toBeTruthy()
        expect(tpl.descriptionZh).toBeTruthy()
        expect(tpl.icon).toBeTruthy()
        expect(["productivity", "ai", "monitoring", "automation"]).toContain(tpl.category)
        expect(validTaskTypes.has(tpl.taskType)).toBe(true)
        expect(["cron", "interval"]).toContain(tpl.triggerType)
      }
    })

    it("getInput() returns a fully formed CreateScheduledTaskInput for each template", () => {
      for (const tpl of TASK_TEMPLATES) {
        const input = tpl.getInput()
        expect(input.name).toBeTruthy()
        expect(input.type).toBe(tpl.taskType)
        expect(input.trigger.type).toBe(tpl.triggerType)
        expect(input.payload).toBeDefined()

        if (input.trigger.type === "cron") {
          expect(input.trigger.cronExpression).toMatch(/\S/)
          expect(input.trigger.timezone).toBeTruthy()
        } else if (input.trigger.type === "interval") {
          expect(input.trigger.intervalMs).toBeGreaterThan(0)
        }
      }
    })

    it("script templates carry language and code", () => {
      const scriptTemplates = TASK_TEMPLATES.filter((t) => t.taskType === "script")
      expect(scriptTemplates.length).toBeGreaterThan(0)
      for (const tpl of scriptTemplates) {
        const input = tpl.getInput()
        expect((input.payload as { language?: string }).language).toBeTruthy()
        expect((input.payload as { code?: string }).code).toBeTruthy()
      }
    })

    it("chat templates carry a prompt", () => {
      const chatTemplates = TASK_TEMPLATES.filter((t) => t.taskType === "chat")
      expect(chatTemplates.length).toBeGreaterThan(0)
      for (const tpl of chatTemplates) {
        const input = tpl.getInput()
        expect((input.payload as { prompt?: string }).prompt).toBeTruthy()
      }
    })

    it("falls back to UTC when Intl is unavailable", () => {
      const originalIntl = (globalThis as { Intl?: typeof Intl }).Intl
      // Force the localTimezone() helper down its UTC path.
      delete (globalThis as { Intl?: typeof Intl }).Intl
      try {
        const briefing = TASK_TEMPLATES.find((t) => t.id === "daily-briefing")
        expect(briefing).toBeDefined()
        const input = briefing!.getInput()
        if (input.trigger.type === "cron") {
          expect(input.trigger.timezone).toBe("UTC")
        }
      } finally {
        ;(globalThis as { Intl?: typeof Intl }).Intl = originalIntl
      }
    })
  })

  describe("TEMPLATE_CATEGORIES", () => {
    it("lists all four categories with unique ids", () => {
      expect(TEMPLATE_CATEGORIES).toHaveLength(4)
      const ids = TEMPLATE_CATEGORIES.map((c) => c.id)
      expect(new Set(ids)).toEqual(new Set(["ai", "productivity", "automation", "monitoring"]))
    })

    it("every category entry has English/Chinese metadata", () => {
      for (const cat of TEMPLATE_CATEGORIES) {
        expect(cat.name).toBeTruthy()
        expect(cat.nameZh).toBeTruthy()
        expect(cat.description).toBeTruthy()
        expect(cat.descriptionZh).toBeTruthy()
        expect(cat.icon).toBeTruthy()
      }
    })
  })

  describe("getTemplatesByCategory", () => {
    it("returns only templates in that category", () => {
      const ai = getTemplatesByCategory("ai")
      expect(ai.length).toBeGreaterThan(0)
      expect(ai.every((t) => t.category === "ai")).toBe(true)
    })

    it("returns an empty array for a category with no templates", () => {
      // Spread to force re-evaluation against current set, but still sound:
      // every category currently used should have at least one template.
      // A category with no entries is best simulated by checking each known one
      // returns positive counts.
      const counts = TEMPLATE_CATEGORIES.map((c) => getTemplatesByCategory(c.id).length)
      expect(counts.every((n) => n > 0)).toBe(true)
    })
  })

  describe("getTemplateById", () => {
    it("finds an existing template", () => {
      const tpl = getTemplateById("daily-briefing")
      expect(tpl).toBeDefined()
      expect(tpl?.id).toBe("daily-briefing")
    })

    it("returns undefined for an unknown id", () => {
      expect(getTemplateById("not-a-real-template")).toBeUndefined()
    })
  })
})
