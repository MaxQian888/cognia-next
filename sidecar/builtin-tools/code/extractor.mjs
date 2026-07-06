// AST → graph extraction.
//
// `extractFile(filePath, source, lang)` parses the file with the right grammar
// and walks the tree, consulting the per-language descriptor (languages/*.mjs)
// to produce `{ nodes, edges, unresolved }`:
//   - a `file` node is the root container
//   - symbol nodes (function/class/method/interface/struct/enum/…) with a
//     `contains` edge from their enclosing symbol (or the file)
//   - call sites become `unresolved_refs` (kind "calls") from the enclosing
//     symbol — the resolver pass links them to definitions afterward
//   - imports become `unresolved_refs` (kind "imports") from the file node
//   - inheritance becomes `unresolved_refs` (kind "extends"/"implements")
//
// Cross-file links can't be resolved here (we only see one file), so anything
// that isn't trivially local is deferred to `resolver-pass.mjs`.

import path from "node:path"

import { languageFor, grammarKeyFor, queriesFor } from "./languages/index.mjs"
import { getParser } from "./parser.mjs"

/** Build the deterministic node id for a symbol. */
export function nodeId(filePath, qualifiedName, startLine) {
  return `${filePath}::${qualifiedName}::${startLine}`
}

/** The file node id is just its path. */
export function fileNodeId(filePath) {
  return filePath
}

/**
 * @param {string} filePath  path used as-is for ids (caller normalises to repo-relative)
 * @param {string} source
 * @param {string} [langHint]  optional language id override
 * @returns {Promise<{ nodes: object[], edges: object[], unresolved: object[], language: string|null, errors: string[] }>}
 */
export async function extractFile(filePath, source, langHint) {
  const language = langHint ?? languageFor(filePath)
  const grammarKey = grammarKeyFor(filePath)
  const errors = []
  const nodes = []
  const edges = []
  const unresolved = []

  if (!language || !grammarKey) {
    return { nodes, edges, unresolved, language: null, errors: ["unsupported language"] }
  }

  const now = Date.now()
  const fileId = fileNodeId(filePath)
  // The root container node for the file.
  nodes.push({
    id: fileId,
    kind: "file",
    name: path.basename(filePath),
    qualified_name: filePath,
    file_path: filePath,
    language,
    start_line: 1,
    start_col: 0,
    end_line: lineCount(source),
    end_col: 0,
    docstring: null,
    signature: null,
    visibility: null,
    is_exported: 0,
    is_async: 0,
    is_static: 0,
    return_type: null,
    updated_at: now,
  })

  let tree
  try {
    const parser = await getParser(grammarKey)
    tree = parser.parse(source)
  } catch (err) {
    errors.push(`parse: ${err?.message ?? err}`)
    return { nodes, edges, unresolved, language, errors }
  }

  const bundle = queriesFor(language)
  const symbolTypes = bundle.SYMBOL_TYPES
  const callTypes = bundle.CALL_TYPES
  const importTypes = bundle.IMPORT_TYPES
  /** @type {Map<string, object>} bare name → first local node (for impl edges) */
  const localByName = new Map()

  /**
   * Recursive visitor. `container` is the nearest enclosing symbol node (graph
   * node), `qnamePrefix` the qualified-name prefix from that container chain.
   */
  const visit = (tsNode, container, qnamePrefix) => {
    let nextContainer = container
    let nextPrefix = qnamePrefix

    const baseKind = symbolTypes[tsNode.type]
    if (baseKind && !(bundle.shouldSkip?.(tsNode) ?? false)) {
      const name = bundle.nodeName(tsNode)
      if (name) {
        const kind = bundle.refineKind ? bundle.refineKind(tsNode, baseKind) : baseKind
        const qualified = qnamePrefix ? `${qnamePrefix}.${name}` : name
        const startLine = tsNode.startPosition.row + 1
        const mods = safeModifiers(bundle, tsNode, source)
        const id = nodeId(filePath, qualified, startLine)
        const graphNode = {
          id,
          kind,
          name,
          qualified_name: qualified,
          file_path: filePath,
          language,
          start_line: startLine,
          start_col: tsNode.startPosition.column,
          end_line: tsNode.endPosition.row + 1,
          end_col: tsNode.endPosition.column,
          docstring: docstringFor(tsNode, language, source),
          signature: mods.signature ?? null,
          visibility: mods.visibility ?? null,
          is_exported: mods.isExported ? 1 : 0,
          is_async: mods.isAsync ? 1 : 0,
          is_static: mods.isStatic ? 1 : 0,
          return_type: mods.returnType ?? null,
          updated_at: now,
        }
        nodes.push(graphNode)
        if (!localByName.has(name)) localByName.set(name, graphNode)
        // contains edge from the enclosing container (file or symbol).
        edges.push({
          source: container?.id ?? fileId,
          target: id,
          kind: "contains",
          metadata: null,
          line: startLine,
          col: graphNode.start_col,
          provenance: "tree-sitter",
        })
        // inheritance refs
        for (const base of safeBaseNames(bundle, tsNode)) {
          unresolved.push({
            from_node_id: id,
            reference_name: base,
            reference_kind: "extends",
            line: startLine,
            col: graphNode.start_col,
            candidates: null,
            file_path: filePath,
            language,
          })
        }
        nextContainer = graphNode
        nextPrefix = qualified
      }
    }

    // call sites — attribute to the nearest enclosing symbol (or the file).
    if (callTypes?.has(tsNode.type)) {
      const callee = bundle.calleeName(tsNode)
      if (callee) {
        unresolved.push({
          from_node_id: (nextContainer ?? container)?.id ?? fileId,
          reference_name: callee,
          reference_kind: "calls",
          line: tsNode.startPosition.row + 1,
          col: tsNode.startPosition.column,
          candidates: null,
          file_path: filePath,
          language,
        })
      }
    }

    // imports — attributed to the file node.
    if (importTypes?.has(tsNode.type)) {
      const src = bundle.importSource(tsNode)
      if (src) {
        unresolved.push({
          from_node_id: fileId,
          reference_name: src,
          reference_kind: "imports",
          line: tsNode.startPosition.row + 1,
          col: tsNode.startPosition.column,
          candidates: null,
          file_path: filePath,
          language,
        })
      }
    }

    for (const child of tsNode.namedChildren) visit(child, nextContainer, nextPrefix)
  }

  visit(tree.rootNode, null, "")

  // Rust `impl Trait for Type` → implements edges (type → trait), resolved
  // locally to the struct node when it lives in this file.
  if (typeof bundle.implEdges === "function") {
    for (const { from, to } of bundle.implEdges(tree.rootNode)) {
      const fromNode = localByName.get(from)
      if (fromNode) {
        unresolved.push({
          from_node_id: fromNode.id,
          reference_name: to,
          reference_kind: "implements",
          line: fromNode.start_line,
          col: fromNode.start_col,
          candidates: null,
          file_path: filePath,
          language,
        })
      }
    }
  }

  // Record the symbol count on the file node for stats.
  nodes[0].node_count = nodes.length - 1
  try {
    tree.delete?.()
  } catch {
    /* ignore */
  }

  return { nodes, edges, unresolved, language, errors }
}

function safeModifiers(bundle, node, source) {
  try {
    return bundle.modifiers(node, source) ?? {}
  } catch {
    return { signature: null }
  }
}

function safeBaseNames(bundle, node) {
  try {
    return bundle.baseNames?.(node) ?? []
  } catch {
    return []
  }
}

/**
 * Docstring heuristic: a preceding `comment` sibling for C-family languages, or
 * the first string literal in a Python function/class body.
 */
function docstringFor(node, language, source) {
  if (language === "python") {
    const body = node.childForFieldName?.("body")
    const first = body?.namedChildren?.[0]
    if (first && first.type === "expression_statement") {
      const str = first.namedChildren?.[0]
      if (str && str.type === "string") return cleanDoc(str.text)
    }
    return null
  }
  // The comment precedes the declaration, but the declaration may be wrapped
  // in an `export_statement` / `decorated_definition`; climb to the outermost
  // wrapper before reading the preceding sibling.
  let anchor = node
  while (
    anchor.parent &&
    (anchor.parent.type === "export_statement" || anchor.parent.type === "decorated_definition")
  ) {
    anchor = anchor.parent
  }
  const prev = anchor.previousNamedSibling
  if (prev && prev.type === "comment") {
    // Only treat an immediately-preceding comment (no blank-line gap) as a doc.
    if (anchor.startPosition.row - prev.endPosition.row <= 1) return cleanDoc(prev.text)
  }
  return null
}

function cleanDoc(text) {
  return String(text)
    .replace(/^\/\*\*?|\*\/$/g, "")
    .replace(/^\/\/+/gm, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/^['"]{1,3}|['"]{1,3}$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}

function lineCount(source) {
  if (typeof source !== "string" || source.length === 0) return 1
  let n = 1
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") n++
  return n
}
