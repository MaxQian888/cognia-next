import fs from "node:fs"
import path from "node:path"

const en = JSON.parse(fs.readFileSync("i18n/messages/en.json", "utf8"))

function dig(obj, parts) {
  let cur = obj
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in cur) cur = cur[p]
    else return undefined
  }
  return cur
}

const missing = new Map()

function processFile(p) {
  const txt = fs.readFileSync(p, "utf8")
  const lines = txt.split("\n")
  const nsCalls = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/const\s+(\w+)\s*=\s*useTranslations\(["'`]([^"'`]+)["'`]\)/)
    if (m) nsCalls.push({ varName: m[1], ns: m[2] })
  }
  if (nsCalls.length === 0) return

  // 1) Literal `t("foo")` and `t("foo.bar")` calls.
  const tLit = /\b(\w+)\s*\(\s*["'`]([^"'`]+)["'`]/g
  let m
  const checkedKeys = new Set()
  const recordKey = (ns, key) => {
    const probe = `${ns}::${key}`
    if (checkedKeys.has(probe)) return
    checkedKeys.add(probe)
    if (dig(en, [...ns.split("."), ...key.split(".")]) === undefined) {
      const arr = missing.get(p) || []
      arr.push({ ns, key })
      missing.set(p, arr)
    }
  }
  while ((m = tLit.exec(txt)) !== null) {
    const call = nsCalls.find((c) => c.varName === m[1])
    if (call) recordKey(call.ns, m[2])
  }

  // 2) Dynamic dispatch: `t(varName)` where varName resolves to a literal
  // value or a union of literals from this file (const map values, union
  // type, ternary chain). We collect candidate literals per variable name.
  const dynRe = /\b(\w+)\s*\(\s*([a-zA-Z_$][\w$]*)\s*\)/g
  while ((m = dynRe.exec(txt)) !== null) {
    const call = nsCalls.find((c) => c.varName === m[1])
    if (!call) continue
    const candidates = candidatesForIdent(txt, m[2])
    for (const key of candidates) recordKey(call.ns, key)
  }
}

/**
 * Collect string-literal candidate values for a local identifier by
 * scanning the file for:
 *   - object map values like `KEY = { x: "viaX", y: "viaY" } as const`
 *   - ternary chains like `cond ? "a" : cond2 ? "b" : "c"` assigned to it
 *   - simple `const x = "literal"` bindings
 *
 * Best-effort, no AST parsing — meant to surface obvious lookup tables in
 * audit, not to be a substitute for the TS type checker.
 */
function candidatesForIdent(txt, ident) {
  const out = new Set()
  // a) const IDENT = { ... } as const
  const objAssign = new RegExp(
    "const\\s+" + ident + "\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*(?:as\\s+const)?",
    "m"
  )
  let m = txt.match(objAssign)
  if (m) {
    const body = m[1]
    const lit = /:\s*["'`]([^"'`]+)["'`]/g
    let mm
    while ((mm = lit.exec(body)) !== null) out.add(mm[1])
    if (out.size > 0) return out
  }
  // b) `const IDENT = ... ? "x" : ... "y" : ... "z"` (multi-line ternary)
  // capture all string literals in the line range until the next semicolon-less const.
  const condAssign = new RegExp(
    "const\\s+" + ident + "\\s*=([\\s\\S]*?)(?:\\n\\s*const|\\n\\s*return|\\n\\s*\\})",
    "m"
  )
  m = txt.match(condAssign)
  if (m) {
    const body = m[1]
    const lit = /["'`]([A-Za-z][\w.]*)["'`]/g
    let mm
    while ((mm = lit.exec(body)) !== null) out.add(mm[1])
  }
  // c) Iterator-source: `ORDER.map((step, ...) => ... t(step) ...)` —
  // collect const-array literals declared as `const ORDER = [...] as const`
  // when the ident is `step`/`name`/`kind` and there's an enclosing .map call.
  if (out.size === 0) {
    const arrRe = /const\s+\w+\s*(?::[^=]+)?=\s*\[([^\]]*)\]\s*(?:as\s+const)?/g
    let mm
    while ((mm = arrRe.exec(txt)) !== null) {
      const lit = /["'`]([A-Za-z][\w.]*)["'`]/g
      let inner
      while ((inner = lit.exec(mm[1])) !== null) out.add(inner[1])
    }
  }
  return out
}

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name).replace(/\\/g, "/")
    if (ent.isDirectory()) {
      if (ent.name !== "node_modules" && !ent.name.startsWith(".")) walk(p)
      continue
    }
    if (!/\.(tsx?|jsx?)$/.test(ent.name)) continue
    if (/\.test\.(tsx?|jsx?)$/.test(ent.name)) continue
    processFile(p)
  }
}

walk("components/mobile")
processFile("components/app-shell-mobile.tsx")

let total = 0
for (const [f, arr] of missing) {
  console.log("--- " + f + " ---")
  const uniq = [...new Set(arr.map(({ ns, key }) => ns + "." + key))].sort()
  for (const k of uniq) console.log("  " + k)
  total += uniq.length
}
console.log("TOTAL missing keys: " + total)
