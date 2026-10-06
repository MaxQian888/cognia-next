#!/usr/bin/env node
/** Compare the host whitelist with current CLI, author and distribution builders. */
import { findExternalsDrift } from "./lib/plugin-externals.mjs"

try {
  const problems = findExternalsDrift()
  if (problems.length) {
    console.error(`[plugin-externals] ${problems.length} contract disagreement(s):`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exitCode = 1
  } else {
    console.log("[plugin-externals] host, CLI, author and distribution externals agree.")
  }
} catch (error) {
  console.error(`[plugin-externals] ${error.message}`)
  process.exitCode = 1
}
