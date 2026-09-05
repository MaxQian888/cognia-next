import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"

/** Make webclone's hidden runtime dependency visible to both release bundlers. */
export function rewriteWebcloneAnalyzer(source) {
  let result = source.replaceAll("\r\n", "\n")
  for (const [search, replacement] of [
    ['import { createRequire } from "node:module";\n', ""],
    [
      'const require = createRequire(import.meta.url);\nconst traverse = require("@babel/traverse").default;',
      'import traverse from "@babel/traverse";',
    ],
  ]) {
    const count = result.split(search).length - 1
    if (count !== 1)
      throw new Error(`webclone bundle: analyzer binding changed (expected one match, got ${count})`)
    result = result.replace(search, replacement)
  }
  if (/\bcreateRequire\b|\brequire\s*\(/u.test(result))
    throw new Error("webclone bundle: analyzer has an unbundled runtime require")
  return result
}

/** Resolve from webclone's own package, including pnpm's separate dependency tree. */
export function createWebcloneBundlePlugin({ root }) {
  const require = createRequire(path.join(root, "sidecar/webclone/package.json"))
  return {
    name: "webclone-runtime-dependencies",
    setup(build) {
      build.onResolve({ filter: /^css-tree$/ }, () => ({
        path: path.join(path.dirname(require.resolve("css-tree/package.json")), "dist/csstree.esm.js"),
      }))
      build.onResolve({ filter: /^@babel\/traverse$/ }, () => ({
        path: require.resolve("@babel/traverse"),
      }))
      build.onLoad(
        { filter: /[\\/]sidecar[\\/]webclone[\\/]dist[\\/]transform[\\/]js-analyzer\.js$/ },
        async ({ path: filename }) => ({
          contents: rewriteWebcloneAnalyzer(await fs.readFile(filename, "utf8")),
          loader: "js",
        })
      )
    },
  }
}
