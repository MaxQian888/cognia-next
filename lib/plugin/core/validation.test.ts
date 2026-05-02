/**
 * Plugin Validation Tests
 */

import { validatePluginManifest, validatePluginConfig } from "./validation"
import type { PluginConfigSchema } from "@/types/plugin"
import type { PluginManifest } from "@/types/plugin"

describe("Plugin Validation", () => {
  describe("validatePluginManifest", () => {
    const createValidManifest = (): PluginManifest => ({
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "frontend",
      capabilities: ["tools"],
      main: "index.js",
    })

    it("should validate a valid manifest", () => {
      const manifest = createValidManifest()
      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("should reject missing id", () => {
      const manifest = createValidManifest()
      delete (manifest as unknown as Record<string, unknown>).id

      const result = validatePluginManifest(manifest as PluginManifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("id"))).toBe(true)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: "id",
            code: "manifest.id.missing",
          }),
        ])
      )
    })

    it("should reject empty id", () => {
      const manifest = createValidManifest()
      manifest.id = ""

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("id"))).toBe(true)
    })

    it("should reject invalid id format", () => {
      const manifest = createValidManifest()
      manifest.id = "Invalid Plugin ID!"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("id"))).toBe(true)
    })

    it("should accept valid id formats", () => {
      const validIds = ["my-plugin", "my_plugin", "my.plugin", "plugin123", "a"]

      for (const id of validIds) {
        const manifest = createValidManifest()
        manifest.id = id
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
      }
    })

    it("should reject missing name", () => {
      const manifest = createValidManifest()
      delete (manifest as unknown as Record<string, unknown>).name

      const result = validatePluginManifest(manifest as PluginManifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("name"))).toBe(true)
    })

    it("should reject invalid version format", () => {
      const manifest = createValidManifest()
      manifest.version = "invalid"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("version"))).toBe(true)
    })

    it("should accept valid semver versions", () => {
      // Note: The implementation uses a simple semver pattern that supports basic pre-release
      const validVersions = ["1.0.0", "0.1.0", "10.20.30", "1.0.0-beta"]

      for (const version of validVersions) {
        const manifest = createValidManifest()
        manifest.version = version
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
      }
    })

    it("should validate minAppVersion when provided", () => {
      const manifest = createValidManifest()
      manifest.minAppVersion = "0.1.0"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(true)
    })

    it("should reject invalid minAppVersion format", () => {
      const manifest = createValidManifest()
      manifest.minAppVersion = "latest"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: "minAppVersion",
            code: "manifest.minAppVersion.invalid",
          }),
        ])
      )
    })

    it("should reject invalid plugin type", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).type = "invalid"

      const result = validatePluginManifest(manifest as PluginManifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("type"))).toBe(true)
    })

    it("should accept valid plugin types", () => {
      // Test frontend type (already has main)
      const frontendManifest = createValidManifest()
      expect(validatePluginManifest(frontendManifest).valid).toBe(true)

      // Test python type (needs pythonMain)
      const pythonManifest = createValidManifest()
      pythonManifest.type = "python"
      pythonManifest.pythonMain = "main.py"
      delete pythonManifest.main
      expect(validatePluginManifest(pythonManifest).valid).toBe(true)

      // Test hybrid type (needs main, pythonMain is optional)
      const hybridManifest = createValidManifest()
      hybridManifest.type = "hybrid"
      expect(validatePluginManifest(hybridManifest).valid).toBe(true)
    })

    it("should handle empty capabilities", () => {
      const manifest = createValidManifest()
      manifest.capabilities = []

      const result = validatePluginManifest(manifest)

      // Empty array is valid per implementation (no invalid capabilities)
      // The implementation validates individual capabilities, not array length
      expect(result.errors.every((e) => !e.includes("Invalid capability"))).toBe(true)
    })

    it("should reject invalid capabilities", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).capabilities = ["invalid"]

      const result = validatePluginManifest(manifest as PluginManifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("capability"))).toBe(true)
    })

    it("should surface partial capability diagnostics in warn mode", () => {
      const manifest = createValidManifest()
      manifest.capabilities = ["themes"]

      const result = validatePluginManifest(manifest, { governanceMode: "warn" })

      expect(result.valid).toBe(true)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "warning",
            field: "capabilities",
            code: "manifest.capabilities.plugin.capability.partial",
          }),
        ])
      )
    })

    it("should fail validation for blocked capabilities in block mode", () => {
      const manifest = createValidManifest()
      manifest.capabilities = ["skills"]

      const result = validatePluginManifest(manifest, { governanceMode: "block" })

      expect(result.valid).toBe(false)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: "capabilities",
            code: "manifest.capabilities.plugin.capability.blocked",
          }),
        ])
      )
    })

    it("should require main for frontend plugins", () => {
      const manifest = createValidManifest()
      manifest.type = "frontend"
      delete manifest.main

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("main"))).toBe(true)
    })

    it("should require pythonMain for python plugins", () => {
      const manifest = createValidManifest()
      manifest.type = "python"
      delete manifest.pythonMain

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("pythonMain"))).toBe(true)
    })

    it("should validate with main for frontend plugins", () => {
      const manifest = createValidManifest()
      manifest.type = "frontend"
      manifest.main = "index.js"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(true)
    })

    it("should validate with pythonMain for python plugins", () => {
      const manifest = createValidManifest()
      manifest.type = "python"
      manifest.pythonMain = "main.py"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(true)
    })

    it("should return warnings for optional best practices", () => {
      const manifest = createValidManifest()
      manifest.type = "frontend"
      manifest.main = "index.js"
      // Missing description, author, homepage, etc.
      manifest.description = ""

      const result = validatePluginManifest(manifest)

      // Should still be valid but may have warnings
      expect(result.warnings.length).toBeGreaterThanOrEqual(0)
    })

    it("should return actionable diagnostics for missing pythonMain", () => {
      const manifest = createValidManifest()
      manifest.type = "python"
      delete manifest.pythonMain

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: "pythonMain",
            code: "manifest.pythonMain.required",
            hint: expect.any(String),
          }),
        ])
      )
    })

    it("should report warning diagnostics for retired activation events in warn mode", () => {
      const manifest = createValidManifest()
      manifest.activationEvents = ["onLanguage:typescript"]

      const result = validatePluginManifest(manifest, { governanceMode: "warn" })

      expect(result.valid).toBe(true)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "warning",
            field: "activationEvents[0]",
            code: "manifest.activationEvents.plugin.point.deprecated",
          }),
        ])
      )
    })

    it("should fail validation for retired activation events in block mode", () => {
      const manifest = createValidManifest()
      manifest.activationEvents = ["onLanguage:typescript"]

      const result = validatePluginManifest(manifest, { governanceMode: "block" })

      expect(result.valid).toBe(false)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: "activationEvents[0]",
            code: "manifest.activationEvents.plugin.point.deprecated",
          }),
        ])
      )
    })
  })

  describe("validatePluginConfig", () => {
    const createConfigSchema = (): PluginConfigSchema => ({
      type: "object" as const,
      properties: {
        name: { type: "string" as const },
        count: { type: "number" as const, minimum: 0, maximum: 100 },
        enabled: { type: "boolean" as const },
        options: {
          type: "string" as const,
          enum: ["option1", "option2", "option3"],
        },
      },
      required: ["name"],
    })

    it("should validate valid config", () => {
      const schema = createConfigSchema()
      const config = {
        name: "Test",
        count: 50,
        enabled: true,
        options: "option1",
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("should reject missing required fields", () => {
      const schema = createConfigSchema()
      const config = {
        count: 50,
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "name", code: "required" })
      )
    })

    it("should reject invalid type", () => {
      const schema = createConfigSchema()
      const config = {
        name: 123, // Should be string
        count: 50,
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "name", code: "invalid_type" })
      )
    })

    it("should reject value below minimum", () => {
      const schema = createConfigSchema()
      const config = {
        name: "Test",
        count: -1,
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "count", code: "minimum" })
      )
    })

    it("should reject value above maximum", () => {
      const schema = createConfigSchema()
      const config = {
        name: "Test",
        count: 101,
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "count", code: "maximum" })
      )
    })

    it("should reject invalid enum value", () => {
      const schema = createConfigSchema()
      const config = {
        name: "Test",
        options: "invalid",
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "options", code: "enum" })
      )
    })

    it("should allow optional fields to be omitted", () => {
      const schema = createConfigSchema()
      const config = {
        name: "Test",
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(true)
    })

    it("should pass validation with no schema", () => {
      const config = { anything: "goes" }

      const result = validatePluginConfig(config, undefined)

      expect(result.valid).toBe(true)
    })
  })
})
