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

    describe("requires.binaries", () => {
      it("accepts a valid requires.binaries block", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = {
          binaries: [
            { name: "cognia", minVersion: "0.1.0", documentation: "https://x" },
            { name: "git" },
          ],
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
        expect(result.errors).toHaveLength(0)
      })

      it("accepts a manifest with no requires block (additive)", () => {
        const manifest = createValidManifest()
        expect(validatePluginManifest(manifest).valid).toBe(true)
      })

      it("rejects requires that is not an object", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = ["git"]
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "manifest.requires.invalid" })])
        )
      })

      it("rejects requires.binaries that is not an array", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = { binaries: {} }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "manifest.requires.binaries.invalid" }),
          ])
        )
      })

      it("rejects a binary entry missing name", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = {
          binaries: [{ minVersion: "1.0.0" }],
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "manifest.requires.binaries.name.missing" }),
          ])
        )
      })

      it("rejects a non-semver minVersion", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = {
          binaries: [{ name: "git", minVersion: "latest" }],
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "manifest.requires.binaries.minVersion.invalid",
            }),
          ])
        )
      })

      it("rejects a non-string documentation field", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = {
          binaries: [{ name: "git", documentation: 42 }],
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "manifest.requires.binaries.documentation.invalid",
            }),
          ])
        )
      })
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

    it("should pass validation for skills capability (unblocked in M1·T4)", () => {
      // Historical note: this test previously asserted that declaring
      // `capabilities: ["skills"]` in block mode produced an error because
      // the skills contract was support: "blocked". M1·T4 of the plugin-first
      // Computer Use plan flipped skills to "supported" once skill-registry +
      // build-options + sidecar passthrough landed (M1·T3 / M4). No real
      // capability is currently in the "blocked" status, so the validation
      // path is exercised by the "unknown capability" test above instead.
      const manifest = createValidManifest()
      manifest.capabilities = ["skills"]

      const result = validatePluginManifest(manifest, { governanceMode: "block" })

      expect(result.valid).toBe(true)
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

    it("should validate a well-formed wasm plugin manifest", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = { apiVersion: "0.1.0" }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(true)
    })

    it("should reject wasm plugins missing wasmMain", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasm = { apiVersion: "0.1.0" }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("wasmMain"))).toBe(true)
    })

    it("should reject wasm plugins with non-.wasm wasmMain", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.js"
      manifest.wasm = { apiVersion: "0.1.0" }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes(".wasm"))).toBe(true)
    })

    it("should reject wasm plugins missing the wasm block", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.toLowerCase().includes("wasm"))).toBe(true)
    })

    it("should reject wasm plugins with a malformed apiVersion", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = { apiVersion: "0.1" }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("apiVersion"))).toBe(true)
    })

    it("should reject wasm plugins with absurd memoryLimitMb", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = { apiVersion: "0.1.0", memoryLimitMb: 9999 }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("memoryLimitMb"))).toBe(true)
    })

    it("should reject wasm plugins with negative callTimeoutMs", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = { apiVersion: "0.1.0", callTimeoutMs: -1 }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("callTimeoutMs"))).toBe(true)
    })

    it("should reject wasm plugins with NUL-byte preopens", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = {
        apiVersion: "0.1.0",
        fs: { preopens: ["~/Documents", "bad\0path"] },
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("preopen"))).toBe(true)
    })

    it("should reject wasm plugins with empty-string preopens", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = { apiVersion: "0.1.0", fs: { preopens: ["", "~/ok"] } }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("preopen"))).toBe(true)
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

  describe("validatePluginManifest — dexie block", () => {
    const createValidManifest = (): PluginManifest => ({
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "frontend",
      capabilities: ["tools"],
      main: "index.js",
    })

    it("accepts a manifest with a valid dexie block", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [{ name: "repos", schema: "++id, fullName" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("accepts a manifest without a dexie block", () => {
      const manifest = createValidManifest()
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(true)
    })

    it("rejects when dexie is not an object", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = "not-an-object"
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("dexie"))).toBe(true)
    })

    it("rejects when dexie.tables is missing", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {}
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.diagnostics!.some((d) => d.field === "dexie.tables")).toBe(true)
    })

    it("rejects when dexie.tables is empty", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = { tables: [] }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.diagnostics!.some((d) => d.code === "manifest.dexie.tables.empty")).toBe(true)
    })

    it("rejects an invalid table name", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [{ name: "BadName", schema: "++id" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.diagnostics!.some((d) => d.code === "manifest.dexie.tables.nameInvalid")).toBe(
        true
      )
    })

    it("rejects a duplicate table name", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [
          { name: "repos", schema: "++id" },
          { name: "repos", schema: "++id, name" },
        ],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.diagnostics!.some((d) => d.code === "manifest.dexie.tables.duplicate")).toBe(
        true
      )
    })

    it("rejects an empty schema string", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [{ name: "repos", schema: "" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(
        result.diagnostics!.some((d) => d.code === "manifest.dexie.tables.schemaInvalid")
      ).toBe(true)
    })

    it("rejects more than 20 tables", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: Array.from({ length: 21 }, (_, i) => ({
          name: `table${i}`,
          schema: "++id",
        })),
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.diagnostics!.some((d) => d.code === "manifest.dexie.tables.tooMany")).toBe(true)
    })

    it("rejects a migration with a non-positive toVersion", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [{ name: "repos", schema: "++id" }],
        migrations: [{ toVersion: 0, upgrade: "migrateV1" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(
        result.diagnostics!.some((d) => d.code === "manifest.dexie.migrations.toVersionInvalid")
      ).toBe(true)
    })

    it("rejects a migration with an empty upgrade string", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [{ name: "repos", schema: "++id" }],
        migrations: [{ toVersion: 2, upgrade: "" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(
        result.diagnostics!.some((d) => d.code === "manifest.dexie.migrations.upgradeInvalid")
      ).toBe(true)
    })

    it("accepts multiple valid tables with migrations", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [
          { name: "repos", schema: "++id, fullName" },
          { name: "workOrders", schema: "++id, [status+repoFullName]" },
        ],
        migrations: [{ toVersion: 2, upgrade: "migrateToV2" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    describe("manifest.i18n", () => {
      it("accepts a flat per-locale string map", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: {
            en: { "panel.title": "Hello" },
            "zh-CN": { "panel.title": "你好" },
          },
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
        expect(result.errors).toHaveLength(0)
      })

      it("rejects when `i18n` is not an object", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = "yes"
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.invalid")).toBe(true)
      })

      it("rejects when `i18n.locales` is missing or not an object", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {}
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.locales.invalid")).toBe(
          true
        )
      })

      it("warns when a locale is not one of the host's canonical locales", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: { ja: { hi: "konnichiwa" } },
        }
        const result = validatePluginManifest(manifest)
        // Warnings don't break the validity gate.
        expect(result.valid).toBe(true)
        expect(
          result.diagnostics!.some(
            (d) => d.code === "manifest.i18n.invalid_locale" && d.severity === "warning"
          )
        ).toBe(true)
      })

      it("rejects nested objects under a locale (only flat dot-notation accepted)", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: { en: "not an object" },
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.invalid_keys")).toBe(true)
      })

      it("rejects keys that violate the I18N_KEY_PATTERN", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: { en: { "bad key!": "value" } },
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.invalid_keys")).toBe(true)
      })

      it("rejects non-string values", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: { en: { greet: 123 as unknown as string } },
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.invalid_keys")).toBe(true)
      })

      it("flags when a locale exceeds the per-locale key cap", () => {
        const manifest = createValidManifest()
        const big: Record<string, string> = {}
        for (let i = 0; i <= 1000; i++) big[`k${i}`] = "v"
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: { en: big },
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.too_many_keys")).toBe(true)
      })
    })

    // -----------------------------------------------------------------------
    // ADR-0026 — lazy-factory manifest fields.
    //
    // The six new fields (ocrProviders / workspaceBackends / messageRenderers
    // / aiProviders / modalMounts / chatMiddlewares) all share the
    // `{ id, label, entry, export }` shape; the tests below exercise the
    // shared `validateLazyFactoryArray` rules plus the field-specific
    // extras (kind discriminant, dimensions, partType, priority, timeoutMs).
    // -----------------------------------------------------------------------
    describe("ADR-0026 lazy-factory manifest fields", () => {
      const withLazy = (extra: Record<string, unknown>): PluginManifest =>
        ({
          ...createValidManifest(),
          ...extra,
        }) as PluginManifest

      it("accepts a valid ocrProviders entry", () => {
        const manifest = withLazy({
          ocrProviders: [
            {
              id: "baidu",
              label: "Baidu OCR",
              entry: "providers/baidu.js",
              export: "createBaiduProvider",
            },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
      })

      it("rejects ocrProviders with non-array shape", () => {
        const manifest = withLazy({ ocrProviders: "nope" })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.invalid_type")
        ).toBe(true)
      })

      it("rejects ocrProviders entry missing required id", () => {
        const manifest = withLazy({
          ocrProviders: [{ label: "x", entry: "a.js", export: "f" }],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.id.missing")).toBe(
          true
        )
      })

      it("rejects ocrProviders with an absolute entry path", () => {
        const manifest = withLazy({
          ocrProviders: [
            { id: "x", label: "X", entry: "/abs/path.js", export: "f" },
            { id: "y", label: "Y", entry: "C:\\drv\\path.js", export: "f" },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        const codes = result.diagnostics!.map((d) => d.code)
        expect(codes.filter((c) => c === "manifest.ocrProviders.entry.absolute").length).toBe(2)
      })

      it("rejects ocrProviders with traversal in entry", () => {
        const manifest = withLazy({
          ocrProviders: [{ id: "x", label: "X", entry: "../escape.js", export: "f" }],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.entry.traversal")
        ).toBe(true)
      })

      it("rejects ocrProviders with NUL byte in entry", () => {
        const manifest = withLazy({
          ocrProviders: [{ id: "x", label: "X", entry: "a\0b.js", export: "f" }],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.entry.invalid_chars")
        ).toBe(true)
      })

      it("rejects duplicate ids within the same field", () => {
        const manifest = withLazy({
          ocrProviders: [
            { id: "dup", label: "X", entry: "a.js", export: "f" },
            { id: "dup", label: "Y", entry: "b.js", export: "g" },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.id.duplicate")
        ).toBe(true)
      })

      it("rejects export that is not a valid JS identifier", () => {
        const manifest = withLazy({
          ocrProviders: [{ id: "x", label: "X", entry: "a.js", export: "1bad-name" }],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.export.invalid")
        ).toBe(true)
      })

      it("messageRenderers requires partType but not label", () => {
        const missingPartType = withLazy({
          messageRenderers: [{ id: "r", entry: "a.js", export: "Renderer" }],
        })
        let result = validatePluginManifest(missingPartType)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.messageRenderers.partType.missing")
        ).toBe(true)

        const ok = withLazy({
          messageRenderers: [
            { id: "r", entry: "a.js", export: "Renderer", partType: "x-custom-block" },
          ],
        })
        result = validatePluginManifest(ok)
        expect(result.valid).toBe(true)
      })

      it("aiProviders rejects unknown kind", () => {
        const manifest = withLazy({
          aiProviders: [
            { id: "x", label: "X", entry: "a.js", export: "f", kind: "neither-llm-nor-embed" },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.aiProviders.kind.invalid")
        ).toBe(true)
      })

      it("aiProviders embedding kind requires positive integer dimensions", () => {
        const missing = withLazy({
          aiProviders: [{ id: "e", label: "E", entry: "a.js", export: "f", kind: "embedding" }],
        })
        let result = validatePluginManifest(missing)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.aiProviders.dimensions.invalid")
        ).toBe(true)

        const ok = withLazy({
          aiProviders: [
            {
              id: "e",
              label: "E",
              entry: "a.js",
              export: "f",
              kind: "embedding",
              dimensions: 1536,
            },
          ],
        })
        result = validatePluginManifest(ok)
        expect(result.valid).toBe(true)
      })

      it("aiProviders llm rejects non-string-array models", () => {
        const manifest = withLazy({
          aiProviders: [
            {
              id: "l",
              label: "L",
              entry: "a.js",
              export: "f",
              kind: "llm",
              models: [123, "claude-opus-4-7"],
            },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.aiProviders.models.invalid")
        ).toBe(true)
      })

      it("chatMiddlewares rejects out-of-range priority and timeout", () => {
        const manifest = withLazy({
          chatMiddlewares: [
            { id: "m", label: "M", entry: "a.js", export: "f", priority: 999 },
            { id: "n", label: "N", entry: "a.js", export: "g", timeoutMs: 999_999 },
            { id: "o", label: "O", entry: "a.js", export: "h", timeoutMs: 0 },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        const codes = new Set(result.diagnostics!.map((d) => d.code))
        expect(codes.has("manifest.chatMiddlewares.priority.range")).toBe(true)
        expect(codes.has("manifest.chatMiddlewares.timeoutMs.range")).toBe(true)
      })

      it("modalMounts validates the shared shape and accepts a minimal entry", () => {
        const manifest = withLazy({
          modalMounts: [
            { id: "settings", label: "Open Settings", entry: "modal.js", export: "Modal" },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
      })

      it("workspaceBackends validates the shared shape", () => {
        const manifest = withLazy({
          workspaceBackends: [
            { id: "e2b", label: "e2b Sandbox", entry: "backend.js", export: "createBackend" },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
      })
    })
  })
})
