import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { cloneLibraryJson, validateLibrarySchema, validateLibraryValue } from "./schema"

describe("library JSON boundary", () => {
  it("copies nested values without sharing references or invoking prototype setters", () => {
    const value = JSON.parse('{"__proto__":{"safe":true},"items":[{"a":1}]}')
    const copy = cloneLibraryJson(value, 1024)
    expect(copy).toEqual(value)
    expect(copy.items[0]).not.toBe(value.items[0])
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
    expect(Object.hasOwn(copy, "__proto__")).toBe(true)
  })

  it.each([undefined, NaN, Infinity, BigInt(1), () => 1, Symbol("x"), new Date(), /x/])(
    "rejects non-JSON values: %p",
    (value) => {
      expect(() => cloneLibraryJson({ value }, 1024)).toThrow()
    }
  )

  it("rejects hidden fields, accessors and custom or sparse arrays without invoking getters", () => {
    const getter = jest.fn(() => 1)
    const accessor = Object.defineProperty({}, "a", { get: getter, enumerable: true })
    for (const value of [
      accessor,
      Object.defineProperty({}, "hidden", { value: 1 }),
      { [Symbol("s")]: 1 },
      new Array(1),
      Object.assign([1], { extra: 2 }),
    ]) {
      expect(() => cloneLibraryJson(value, 1024)).toThrow()
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it("rejects cycles and bounds nesting while allowing shared, non-cyclic objects", () => {
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(() => cloneLibraryJson(cyclic, 1024)).toThrow("cycle")
    const shared = { a: 1 }
    expect(cloneLibraryJson([shared, shared], 1024)).toEqual([shared, shared])
    let deep: unknown = 1
    for (let i = 0; i < 130; i++) deep = [deep]
    expect(() => cloneLibraryJson(deep, 1024)).toThrow("nesting")
  })

  it("charges exact UTF-8 JSON bytes, including escaping, keys and separators", () => {
    const value = { 中: ["😀", "\n", null, false, 12] }
    const size = new TextEncoder().encode(JSON.stringify(value)).byteLength
    expect(cloneLibraryJson(value, size)).toEqual(value)
    expect(() => cloneLibraryJson(value, size - 1)).toThrow("byte limit")
  })
})

describe("library draft-07 validation", () => {
  it("validates schemas and values through the production Node ESM bundle", () => {
    const root = path.resolve(__dirname, "../../..")
    fs.mkdirSync(path.join(root, ".cache"), { recursive: true })
    const output = fs.mkdtempSync(path.join(root, ".cache/library-schema-esm-"))
    try {
      // Jest's CJS transform cannot catch a missing JSON import attribute.
      // Exercise the actual source through the CLI bundler and native Node ESM.
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import path from 'node:path';
        import { pathToFileURL } from 'node:url';
        import { cliEsbuildOptions, loadEsbuild } from './scripts/build/esbuild-shared.mjs';
        const root = process.cwd();
        const outdir = process.argv[1];
        const esbuild = await loadEsbuild();
        await esbuild.build(cliEsbuildOptions({ root,
          entry: path.join(root, 'lib/plugin/library/schema.ts'),
          outdir, entryNames: 'schema' }));
        const { validateLibrarySchema, validateLibraryValue } = await import(
          pathToFileURL(path.join(outdir, 'schema.mjs')).href);
        const schema = {type: 'object', properties: {count: {type: 'integer'}}, required: ['count']};
        console.log(JSON.stringify([
          validateLibrarySchema(schema) === null,
          validateLibrarySchema({type: 'unknown'}) !== null,
          validateLibraryValue(schema, {count: 2}) === null,
          validateLibraryValue(schema, {count: '2'}) !== null,
        ]));
      `,
          output,
        ],
        { cwd: root, encoding: "utf8", timeout: 30_000 }
      )
      expect({
        status: result.status,
        error: result.error?.message,
        stderr: result.status ? result.stderr : "",
      }).toEqual({ status: 0, error: undefined, stderr: "" })
      expect(JSON.parse(result.stdout.trim())).toEqual([true, true, true, true])
    } finally {
      fs.rmSync(output, { recursive: true, force: true })
    }
  })

  it.each([
    true,
    false,
    {},
    { type: "array", items: [{ type: "string" }], additionalItems: false },
  ])("admits valid draft-07 schemas: %p", (schema) => {
    expect(validateLibrarySchema(schema)).toBeNull()
  })

  it.each([
    undefined,
    null,
    [],
    { type: "unknown" },
    { minimum: "1" },
    { required: ["a", "a"] },
    { $schema: "https://json-schema.org/draft/2020-12/schema" },
    { typo: true },
    { pattern: "[" },
    { patternProperties: { "[": true } },
    { definitions: { unused: { type: "unknown" } } },
    { definitions: { unused: { typo: true } } },
    { $ref: "https://example.org/missing" },
    { $ref: "#/definitions/missing" },
    { definitions: { unused: { $ref: "https://example.org/missing" } } },
    { default: { type: "not-a-schema" }, $ref: "#/default" },
  ])("rejects malformed, unsupported and unresolved schemas: %p", (schema) => {
    expect(validateLibrarySchema(schema)).not.toBeNull()
  })

  it("validates local references, including escaped pointer segments and boolean schemas", () => {
    const schema = {
      definitions: { "a/b~c": { type: "integer", minimum: 1 }, never: false },
      type: "array",
      items: [{ $ref: "#/definitions/a~1b~0c" }],
      additionalItems: false,
    }
    expect(validateLibrarySchema(schema)).toBeNull()
    expect(validateLibraryValue(schema, [2])).toBeNull()
    expect(validateLibraryValue(schema, [0])).toContain("minimum")
    expect(
      validateLibraryValue({ definitions: { never: false }, $ref: "#/definitions/never" }, 1)
    ).not.toBeNull()
  })

  it("supports explicit local resource IDs but rejects duplicate resource definitions", () => {
    const schema = { definitions: { value: { $id: "value", type: "integer" } }, $ref: "value" }
    expect(validateLibrarySchema(schema)).toBeNull()
    expect(validateLibraryValue(schema, 1)).toBeNull()
    expect(validateLibraryValue(schema, "1")).not.toBeNull()
    expect(
      validateLibrarySchema({ definitions: { a: { $id: "same" }, b: { $id: "same" } } })
    ).toContain("Duplicate")
  })

  it("checks conditionals, contains, propertyNames and dependencies", () => {
    const schema = {
      type: "object",
      propertyNames: { pattern: "^[a-z]+$" },
      properties: {
        mode: { enum: ["read", "write"] },
        entries: { type: "array", contains: { const: 1 } },
      },
      dependencies: { mode: ["entries"] },
      if: { properties: { mode: { const: "write" } }, required: ["mode"] },
      then: { required: ["approval"] },
      else: { not: { required: ["approval"] } },
    }
    expect(validateLibraryValue(schema, { mode: "read", entries: [1] })).toBeNull()
    for (const value of [
      { mode: "read" },
      { mode: "write", entries: [1] },
      { mode: "read", entries: [2] },
      { mode: "read", entries: [1], approval: true },
      { BAD: 1 },
    ]) {
      expect(validateLibraryValue(schema, value)).not.toBeNull()
    }
  })

  it("does not treat inherited prototype keys as declared schema properties", () => {
    const schema = { type: "object", properties: {}, additionalProperties: false }
    expect(validateLibraryValue(schema, { constructor: "must reject" })).not.toBeNull()
    expect(validateLibraryValue(schema, JSON.parse('{"__proto__":"must reject"}'))).not.toBeNull()
  })

  it("does not compile code, coerce values, insert defaults, mutate data or leak values", () => {
    const schema = { type: "object", properties: { count: { type: "integer", default: 1 } } }
    const value = Object.freeze({ count: "private-value" })
    const compiler = jest.spyOn(globalThis, "Function").mockImplementation(() => {
      throw new Error("CSP")
    })
    try {
      expect(validateLibrarySchema(schema)).toBeNull()
      const error = validateLibraryValue(schema, value)
      expect(error).toContain("type")
      expect(error).not.toContain("private-value")
      expect(validateLibraryValue(schema, {})).toBeNull()
      expect(value).toEqual({ count: "private-value" })
      expect(compiler).not.toHaveBeenCalled()
    } finally {
      compiler.mockRestore()
    }
  })

  it("bounds schema size and rejects non-JSON data even for permissive schemas", () => {
    expect(validateLibrarySchema({ description: "x".repeat(256 * 1024) })).toContain("byte limit")
    expect(validateLibraryValue(true, undefined)).not.toBeNull()
    expect(validateLibraryValue(false, null)).not.toBeNull()
  })
})
