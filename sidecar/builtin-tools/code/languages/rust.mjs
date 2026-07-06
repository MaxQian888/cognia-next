// Rust extraction descriptor (tree-sitter-rust).

/** grammar keys these rules are valid for. */
export const grammarKeys = ["rust"]

/**
 * AST node type → graph symbol kind. `function_item` is refined to `method`
 * when it lives inside an `impl_item`/`trait_item` (see `refineKind`).
 * @type {Readonly<Record<string, string>>}
 */
export const SYMBOL_TYPES = Object.freeze({
  function_item: "function",
  struct_item: "struct",
  enum_item: "enum",
  union_item: "struct",
  trait_item: "trait",
  type_item: "type_alias",
  const_item: "constant",
  static_item: "constant",
  macro_definition: "function",
})

/** Call-site node types → an unresolved `calls` edge. */
export const CALL_TYPES = Object.freeze(new Set(["call_expression", "macro_invocation"]))

/** Import node types → an unresolved `imports` edge. */
export const IMPORT_TYPES = Object.freeze(new Set(["use_declaration"]))

/** Symbol name — Rust declarations use the `name` field. */
export function nodeName(node) {
  const named = node.childForFieldName?.("name")
  if (named) return named.text
  for (const child of node.namedChildren ?? []) {
    if (child.type === "identifier" || child.type === "type_identifier") return child.text
  }
  return null
}

/** A `function_item` inside an impl/trait body is a method. */
export function refineKind(node, baseKind) {
  if (node.type !== "function_item") return baseKind
  let p = node.parent
  while (p) {
    if (p.type === "impl_item" || p.type === "trait_item") return "method"
    if (p.type === "source_file" || p.type === "mod_item") break
    p = p.parent
  }
  return baseKind
}

export function shouldSkip(node) {
  return nodeName(node) == null
}

/** Callee name from a call or macro invocation. */
export function calleeName(callNode) {
  if (callNode.type === "macro_invocation") {
    const macro = callNode.childForFieldName?.("macro")
    return macro ? lastSegment(macro) : null
  }
  const fn = callNode.childForFieldName?.("function")
  return fn ? lastSegment(fn) : null
}

/** Right-most path/field segment: `a::b::c` / `obj.method` → `c` / `method`. */
function lastSegment(node) {
  if (!node) return null
  if (node.type === "identifier" || node.type === "type_identifier") return node.text
  if (node.type === "scoped_identifier") {
    const name = node.childForFieldName?.("name")
    if (name) return name.text
  }
  if (node.type === "field_expression") {
    const field = node.childForFieldName?.("field")
    if (field) return field.text
  }
  const named = node.namedChildren ?? []
  for (let i = named.length - 1; i >= 0; i--) {
    const t = lastSegment(named[i])
    if (t) return t
  }
  return null
}

/** Import path text for a `use` declaration: `use a::b::C;` → `a::b::C`. */
export function importSource(node) {
  for (const child of node.namedChildren ?? []) {
    if (
      child.type === "scoped_identifier" ||
      child.type === "use_as_clause" ||
      child.type === "scoped_use_list" ||
      child.type === "use_list" ||
      child.type === "identifier"
    ) {
      return collapse(child.text)
    }
  }
  return null
}

/**
 * Inheritance / trait-impl base names. For a `trait_item` with supertraits
 * (`trait A: B`), returns the bounds. `impl X for Y` edges are emitted by the
 * extractor's Rust impl hook, not here.
 * @param {any} node
 * @returns {string[]}
 */
export function baseNames(node) {
  const out = []
  const bounds = node.childForFieldName?.("bounds")
  if (bounds) {
    for (const child of bounds.namedChildren ?? []) {
      if (child.type === "type_identifier") out.push(child.text)
    }
  }
  return out
}

/** Modifiers + signature for a Rust symbol node. */
export function modifiers(node, source) {
  let isExported = false
  let isAsync = false
  for (const child of node.children ?? []) {
    if (child.type === "visibility_modifier") isExported = true
    if (child.type === "function_modifiers" && /\basync\b/.test(child.text)) isAsync = true
  }
  if (!isAsync && /\basync\s+fn\b/.test(sliceHead(node, source))) isAsync = true
  const returnTypeNode = node.childForFieldName?.("return_type")
  const returnType = returnTypeNode ? collapse(returnTypeNode.text) : null
  return {
    isExported,
    isAsync,
    isStatic: node.type === "static_item",
    isAbstract: false,
    visibility: isExported ? "pub" : null,
    returnType,
    signature: buildSignature(node, source),
  }
}

export function buildSignature(node, source) {
  const body = node.childForFieldName?.("body")
  const end = body ? body.startIndex : node.endIndex
  return collapse(source.slice(node.startIndex, end))
}

/**
 * Rust-specific structural edges the generic extractor can't infer: for each
 * `impl Trait for Type` block emit an `implements` reference from `Type` to
 * `Trait`. Returns `{ from, to }[]` of bare type names.
 * @param {any} root  the tree root node
 * @returns {{ from: string, to: string }[]}
 */
export function implEdges(root) {
  const out = []
  const visit = (node) => {
    if (node.type === "impl_item") {
      const traitNode = node.childForFieldName?.("trait")
      const typeNode = node.childForFieldName?.("type")
      if (traitNode && typeNode) {
        const from = lastSegment(typeNode)
        const to = lastSegment(traitNode)
        if (from && to) out.push({ from, to })
      }
    }
    for (const child of node.namedChildren ?? []) visit(child)
  }
  visit(root)
  return out
}

function sliceHead(node, source) {
  return source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 64))
}

function collapse(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 400)
}
