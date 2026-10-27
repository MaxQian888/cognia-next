import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"

import config from "../../.storybook/main.ts"

const require = createRequire(import.meta.url)
const frameworkRequire = createRequire(require.resolve("@storybook/nextjs"))
const RuleSetCompiler = frameworkRequire("webpack/lib/rules/RuleSetCompiler")
const compiler = new RuleSetCompiler([])

test("Storybook transpiles Next's allowlisted packages through pnpm's virtual store", async () => {
  const transpilePackages = ["@cognia/sync-protocol", "@cognia/status-contract", "@noble/curves"]
  const virtualModule = path.resolve("node_modules/.cache/storybook/virtual.ts")
  const options = { nextConfig: { transpilePackages }, hasReactRefresh: true }
  const rule = {
    test: /\.[jt]sx?$/,
    include: [process.cwd()],
    exclude: [
      /node_modules\/(?!(@cognia\/sync-protocol|@cognia\/status-contract|@noble\/curves)\/)/,
      virtualModule,
    ],
    use: { loader: "@storybook/nextjs/next-swc-loader-patch", options },
  }
  // Keep the existing nested-rule traversal working as well as top-level rules.
  const rawRule = { resourceQuery: /raw/, exclude: /node_modules/ }
  await config.webpackFinal({ module: { rules: [rawRule, { oneOf: [rule] }] } })
  const excludes = compiler.compileCondition("exclude", rule.exclude).fn

  for (const name of transpilePackages) {
    for (const separator of ["/", "\\"]) {
      for (const file of [
        `/repo/node_modules/${name}/src/index.ts`,
        `/repo/node_modules/.pnpm/${name.replace("/", "+")}@pinned/node_modules/${name}/src/index.ts`,
      ]) {
        const resource = file.replaceAll("/", separator)
        assert.equal(excludes(resource), false, resource)
      }
    }
  }
  for (const resource of [
    virtualModule,
    "/repo/node_modules/unlisted/index.ts",
    "/repo/node_modules/.pnpm/unlisted@1/node_modules/unlisted/index.ts",
    "/repo/node_modules/@cognia/sync-protocol-extra/index.ts",
    "/repo/node_modules/@cognia/sync-protocol/node_modules/unlisted/index.ts",
  ]) {
    assert.equal(excludes(resource), true, resource)
  }
  assert.equal(excludes("/repo/components/chat/tool-approval-dialog.tsx"), false)
  assert.equal(rawRule.exclude.test("/repo/node_modules/unlisted/index.ts"), true)
  assert.equal(rule.use.options, options, "Reuse the framework's compiler options")
  assert.equal(options.hasReactRefresh, false, "Preserve the existing refresh workaround")
})
