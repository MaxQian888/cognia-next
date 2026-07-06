// Python extraction descriptor (tree-sitter-python).

/** grammar keys these rules are valid for. */
export const grammarKeys = ["python"]

/**
 * AST node type → graph symbol kind. `function_definition` is refined to
 * `method` inside a class body; module/class-level `assignment` becomes
 * constant/variable (see `refineKind`).
 * @type {Readonly<Record<string, string>>}
 */
export const SYMBOL_TYPES = Object.freeze({
  function_definition: "function",
  class_definition: "class",
  assignment: "variable",
})

/** Call-site node types → an unresolved `calls` edge. */
export const CALL_TYPES = Object.freeze(new Set(["call"]))

/** Import node types → an unresolved `imports` edge. */
export const IMPORT_TYPES = Object.freeze(new Set(["import_statement", "import_from_statement"]))

/** Symbol name. Assignments use the left-hand identifier. */
export function nodeName(node) {
  if (node.type === "assignment") {
    const left = node.childForFieldName?.("left")
    if (left && left.type === "identifier") return left.text
    return null // tuple/subscript targets are not first-class symbols
  }
  const named = node.childForFieldName?.("name")
  if (named) return named.text
  for (const child of node.namedChildren ?? []) {
    if (child.type === "identifier") return child.text
  }
  return null
}

/**
 * Refine kind: a `function_definition` inside a class body is a `method`; an
 * `assignment` whose name is ALL_CAPS is a `constant`, otherwise a `variable`.
 * Only module- and class-level assignments are kept (the extractor skips those
 * nested inside function bodies).
 */
export function refineKind(node, baseKind) {
  if (node.type === "function_definition") {
    let p = node.parent
    // function_definition → block → class_definition
    while (p) {
      if (p.type === "class_definition") return "method"
      if (p.type === "module" || p.type === "function_definition") break
      p = p.parent
    }
    return baseKind
  }
  if (node.type === "assignment") {
    const name = nodeName(node)
    return name && /^[A-Z][A-Z0-9_]*$/.test(name) ? "constant" : "variable"
  }
  return baseKind
}

/**
 * Skip un-named declarations and assignments nested inside a function body
 * (locals are noise for a symbol graph). Module- and class-level assignments
 * are kept.
 */
export function shouldSkip(node) {
  if (nodeName(node) == null) return true
  if (node.type === "assignment") {
    let p = node.parent
    while (p) {
      if (p.type === "function_definition") return true
      if (p.type === "module" || p.type === "class_definition") return false
      p = p.parent
    }
  }
  return false
}

/** Callee name from a `call` node. */
export function calleeName(callNode) {
  const fn = callNode.childForFieldName?.("function")
  return fn ? lastAttr(fn) : null
}

/** `a.b.c(…)` → `c`; `f(…)` → `f`. */
function lastAttr(node) {
  if (!node) return null
  if (node.type === "identifier") return node.text
  if (node.type === "attribute") {
    const attr = node.childForFieldName?.("attribute")
    if (attr) return attr.text
  }
  const named = node.namedChildren ?? []
  for (let i = named.length - 1; i >= 0; i--) {
    const t = lastAttr(named[i])
    if (t) return t
  }
  return null
}

/** Import module name(s). Returns the dotted module path. */
export function importSource(node) {
  if (node.type === "import_from_statement") {
    const mod = node.childForFieldName?.("module_name")
    if (mod) return collapse(mod.text)
  }
  // `import a.b.c` — first dotted_name / aliased_import.
  for (const child of node.namedChildren ?? []) {
    if (child.type === "dotted_name" || child.type === "aliased_import") {
      return collapse(child.text)
    }
  }
  return null
}

/** Base classes of a `class_definition`. */
export function baseNames(node) {
  const out = []
  const supers = node.childForFieldName?.("superclasses")
  if (supers) {
    for (const child of supers.namedChildren ?? []) {
      if (child.type === "identifier") out.push(child.text)
      else if (child.type === "attribute") {
        const t = lastAttr(child)
        if (t) out.push(t)
      }
    }
  }
  return out
}

/** Modifiers + signature for a Python symbol node. */
export function modifiers(node, source) {
  const name = nodeName(node)
  // Convention: leading underscore → "private"-ish; dunder stays public.
  let visibility = null
  if (name && name.startsWith("_") && !name.startsWith("__")) visibility = "private"
  let isAsync = false
  for (const child of node.children ?? []) {
    if (child.type === "async") isAsync = true
  }
  if (!isAsync && /^\s*async\s+def\b/.test(sliceHead(node, source))) isAsync = true
  // Python module-level names are "exported" unless underscore-prefixed.
  const isExported = node.type !== "assignment" ? !visibility : !visibility
  return {
    isExported,
    isAsync,
    isStatic: false,
    isAbstract: false,
    visibility,
    returnType: returnTypeOf(node),
    signature: buildSignature(node, source),
  }
}

function returnTypeOf(node) {
  if (node.type !== "function_definition") return null
  const rt = node.childForFieldName?.("return_type")
  return rt ? collapse(rt.text) : null
}

export function buildSignature(node, source) {
  if (node.type === "assignment") return collapse(source.slice(node.startIndex, node.endIndex))
  const body = node.childForFieldName?.("body")
  const end = body ? body.startIndex : node.endIndex
  return collapse(source.slice(node.startIndex, end)).replace(/:\s*$/, "")
}

function sliceHead(node, source) {
  return source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 64))
}

function collapse(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 400)
}
