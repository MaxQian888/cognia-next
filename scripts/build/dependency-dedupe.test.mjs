import assert from "node:assert/strict"
import { realpathSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createCodePlugin } from "@streamdown/code"
import { asSchema } from "ai"
import { codeToTokens } from "shiki"

// Run outside Jest: its Streamdown/Shiki mocks cannot verify installed dependencies.
const root = fileURLToPath(new URL("../..", import.meta.url))
const rootRequire = createRequire(path.join(root, "package.json"))
const schemaPackages = ["eval-core", "provider-core", "provider-types", "rag", "router-fusion"]
const themes = ["one-light", "one-dark-pro"]

function workspaceRequire(name) {
  return createRequire(path.join(root, "packages", name, "package.json"))
}

test("Streamdown and the app resolve one Shiki runtime", () => {
  const pluginRequire = createRequire(
    realpathSync(path.join(root, "node_modules/@streamdown/code/package.json"))
  )
  assert.equal(
    realpathSync(pluginRequire.resolve("shiki")),
    realpathSync(rootRequire.resolve("shiki"))
  )
})

test("workspace schema packages share the host Zod runtime", () => {
  for (const name of schemaPackages) {
    assert.equal(
      realpathSync(workspaceRequire(name).resolve("zod")),
      realpathSync(rootRequire.resolve("zod")),
      name
    )
  }
})

test("provider and RAG SDKs share the host peer context", () => {
  for (const name of ["provider-core", "rag"]) {
    for (const dependency of ["ai", "@ai-sdk/openai"]) {
      assert.equal(
        realpathSync(workspaceRequire(name).resolve(dependency)),
        realpathSync(rootRequire.resolve(dependency)),
        `${name}: ${dependency}`
      )
    }
  }
})

function highlight(plugin, code, language, isIncomplete = false) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Highlight callback missing: ${language}`)),
      10000
    )
    const done = (result) => {
      clearTimeout(timer)
      resolve(result)
    }
    try {
      const result = plugin.highlight({ code, language, themes, isIncomplete }, done)
      if (result) done(result)
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
}

function tokenAppearance(result) {
  return result.tokens.map((line) =>
    line.map(({ content, color, htmlStyle, fontStyle }) => ({
      content,
      color,
      htmlStyle,
      fontStyle,
    }))
  )
}

test("real Streamdown highlighting preserves dual-theme output and language aliases", async () => {
  const plugin = createCodePlugin({ themes })
  assert.deepEqual(plugin.getThemes(), themes)
  for (const [language, code] of [
    ["ts", "const answer: number = 42"],
    ["bash", 'echo "hello"'],
    ["vue", "<template><div>Hello</div></template>"],
    ["elixir", 'defmodule Hello do\n  def greet, do: "hello"\nend'],
  ]) {
    assert.equal(plugin.supportsLanguage(language), true, language)
    const result = await highlight(plugin, code, language)
    const expected = await codeToTokens(code, {
      lang: language,
      themes: { light: themes[0], dark: themes[1] },
    })
    assert.deepEqual(tokenAppearance(result), tokenAppearance(expected), language)
  }
})

test("real Streamdown handles streaming completion and unsupported-language fallback", async () => {
  const plugin = createCodePlugin({ themes })
  await highlight(plugin, 'const value = "hel', "ts", true)
  const code = 'const value = "hello"\nconsole.log(value)'
  const result = await highlight(plugin, code, "ts")
  const expected = await codeToTokens(code, {
    lang: "ts",
    themes: { light: themes[0], dark: themes[1] },
  })
  assert.deepEqual(tokenAppearance(result), tokenAppearance(expected))
  assert.equal(plugin.supportsLanguage("cognia-unknown-language"), false)
  const fallback = await highlight(plugin, code, "cognia-unknown-language")
  assert.equal(
    fallback.tokens.map((line) => line.map((token) => token.content).join("")).join("\n"),
    code
  )
})

test("each workspace's real Zod schemas convert and validate through the host AI SDK", async () => {
  for (const name of schemaPackages) {
    const { z } = workspaceRequire(name)("zod")
    const schema = asSchema(z.object({ query: z.string().min(1), limit: z.number().int().min(1) }))
    const json = await schema.jsonSchema
    assert.equal(json.type, "object", name)
    assert.equal(json.properties.query.type, "string", name)
    assert.deepEqual(json.required, ["query", "limit"], name)
    assert.equal((await schema.validate({ query: "hello", limit: 3 })).success, true, name)
    assert.equal((await schema.validate({ query: "", limit: 0 })).success, false, name)
  }
})
