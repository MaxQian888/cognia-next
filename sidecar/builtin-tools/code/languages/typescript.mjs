// TypeScript / TSX / JavaScript extraction descriptor.
//
// The generic extractor (`../extractor.mjs`) walks the tree-sitter AST and
// consults this descriptor to turn nodes into graph nodes/edges. We keep the
// grammar-specific knowledge here (node-type → symbol kind, how to read a
// callee/import/heritage) rather than hand-writing S-expression queries, which
// mirrors codegraph's `visitNode` approach and is far easier to test.
//
// The same descriptor serves the `typescript`, `tsx`, and (JS via the `tsx`
// grammar) parses — JSX is irrelevant to symbol/import extraction, and the
// node types below exist in all three grammars.

/** grammar keys these rules are valid for. */
export const grammarKeys = ["typescript", "tsx"]

/**
 * AST node type → graph symbol kind. A `variable_declarator` is refined later
 * (`refineKind`) into function/constant/variable based on its initializer.
 * @type {Readonly<Record<string, string>>}
 */
export const SYMBOL_TYPES = Object.freeze({
  function_declaration: "function",
  generator_function_declaration: "function",
  function_signature: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  method_definition: "method",
  method_signature: "method",
  interface_declaration: "interface",
  type_alias_declaration: "type_alias",
  enum_declaration: "enum",
  variable_declarator: "variable",
})

/** Call-site node types → an unresolved `calls` edge. */
export const CALL_TYPES = Object.freeze(new Set(["call_expression", "new_expression"]))

/** Import node types → an unresolved `imports` edge. */
export const IMPORT_TYPES = Object.freeze(new Set(["import_statement", "export_statement"]))

const IDENTIFIER_TYPES = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
  "shorthand_property_identifier",
])

/**
 * Symbol name for a definition node. Defaults to the `name` field; for
 * `variable_declarator` the name is also the `name` field.
 * @param {any} node
 * @returns {string | null}
 */
export function nodeName(node) {
  const named = node.childForFieldName?.("name")
  if (named) return named.text
  for (const child of node.namedChildren ?? []) {
    if (IDENTIFIER_TYPES.has(child.type)) return child.text
  }
  return null
}

/**
 * Refine a `variable_declarator`'s kind: `const f = () => …` / `= function` →
 * `function`; a `const` binding → `constant`; otherwise `variable`.
 * @param {any} node  the variable_declarator
 * @param {string} baseKind
 * @returns {string}
 */
export function refineKind(node, baseKind) {
  if (baseKind !== "variable") return baseKind
  const value = node.childForFieldName?.("value")
  if (value && (value.type === "arrow_function" || value.type === "function_expression"))
    return "function"
  // `lexical_declaration` parent with a `const` keyword → constant.
  const decl = node.parent
  if (decl && decl.type === "lexical_declaration") {
    const kw = decl.children?.[0]?.text
    if (kw === "const") return "constant"
  }
  return "variable"
}

/**
 * Whether a declarator/declaration is so trivial it should not become its own
 * graph node (e.g. a loop index). We keep all top-level/class members; skip
 * un-named declarators.
 */
export function shouldSkip(node) {
  return nodeName(node) == null
}

/** Callee name from a call/new expression. */
export function calleeName(callNode) {
  const fn = callNode.childForFieldName?.("function") ?? callNode.childForFieldName?.("constructor")
  if (!fn) {
    // new_expression uses `constructor` field in some grammar versions; fall
    // back to the first named child.
    const first = callNode.namedChildren?.[0]
    return first ? lastIdentifier(first) : null
  }
  return lastIdentifier(fn)
}

/** For `a.b.c(…)` return `c`; for `f(…)` return `f`. */
function lastIdentifier(node) {
  if (!node) return null
  if (IDENTIFIER_TYPES.has(node.type)) return node.text
  if (node.type === "member_expression") {
    const prop = node.childForFieldName?.("property")
    if (prop) return prop.text
  }
  // Dig for the right-most identifier.
  const named = node.namedChildren ?? []
  for (let i = named.length - 1; i >= 0; i--) {
    const t = lastIdentifier(named[i])
    if (t) return t
  }
  return null
}

/**
 * Import module specifier (the quoted source) for an import/export statement.
 * Returns null for statements with no `from "…"` clause (e.g. `export const x`).
 */
export function importSource(importNode) {
  const src = importNode.childForFieldName?.("source")
  if (src) return stripQuotes(src.text)
  for (const child of importNode.namedChildren ?? []) {
    if (child.type === "string") return stripQuotes(child.text)
  }
  return null
}

function stripQuotes(text) {
  if (typeof text !== "string") return text
  return text.replace(/^['"`]|['"`]$/g, "")
}

/**
 * Base type names a class/interface extends or implements. Reads the
 * `class_heritage` (classes) or `extends_type_clause` (interfaces).
 * @param {any} node
 * @returns {string[]}
 */
export function baseNames(node) {
  const out = []
  const collectFrom = (n) => {
    if (!n) return
    for (const child of n.namedChildren ?? []) {
      if (child.type === "type_identifier" || child.type === "identifier") {
        out.push(child.text)
      } else if (
        child.type === "extends_clause" ||
        child.type === "implements_clause" ||
        child.type === "extends_type_clause" ||
        child.type === "generic_type"
      ) {
        collectFrom(child)
      } else if (child.type === "member_expression") {
        const id = lastIdentifier(child)
        if (id) out.push(id)
      }
    }
  }
  for (const child of node.namedChildren ?? []) {
    if (
      child.type === "class_heritage" ||
      child.type === "extends_type_clause" ||
      child.type === "implements_clause"
    ) {
      collectFrom(child)
    }
  }
  return out
}

/**
 * Language-specific modifiers + signature bits for a symbol node.
 * @param {any} node
 * @param {string} source  full file source (for slicing the signature)
 * @returns {{ isExported: boolean, isAsync: boolean, isStatic: boolean, isAbstract: boolean, visibility: string|null, returnType: string|null, signature: string }}
 */
export function modifiers(node, source) {
  let isExported = false
  let isAsync = false
  let isStatic = false
  let isAbstract = false
  let visibility = null

  // `export`/`export default` wraps the declaration in an export_statement.
  let p = node.parent
  while (p) {
    if (p.type === "export_statement") {
      isExported = true
      break
    }
    if (p.type === "program" || p.type === "statement_block") break
    p = p.parent
  }

  // Inline modifier tokens are unnamed children (`async`, `static`, `abstract`,
  // `public`/`private`/`protected`).
  for (const child of node.children ?? []) {
    const t = child.type
    if (t === "async") isAsync = true
    else if (t === "static") isStatic = true
    else if (t === "abstract" || t === "abstract_modifier") isAbstract = true
    else if (t === "accessibility_modifier") visibility = child.text
  }
  // method/function async can also live as a leading keyword in text.
  if (!isAsync && /^\s*async\b/.test(sliceHead(node, source))) isAsync = true

  const returnTypeNode = node.childForFieldName?.("return_type")
  const returnType = returnTypeNode ? returnTypeNode.text.replace(/^:\s*/, "") : null

  return {
    isExported,
    isAsync,
    isStatic,
    isAbstract,
    visibility,
    returnType,
    signature: buildSignature(node, source),
  }
}

/** The header text (declaration up to the body), single-lined & trimmed. */
export function buildSignature(node, source) {
  const body = node.childForFieldName?.("body")
  const end = body ? body.startIndex : node.endIndex
  const text = source.slice(node.startIndex, end)
  return collapse(text)
}

function sliceHead(node, source) {
  return source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 64))
}

function collapse(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 400)
}
