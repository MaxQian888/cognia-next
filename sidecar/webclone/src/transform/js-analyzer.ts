import { createRequire } from "node:module"
import * as parser from "@babel/parser"
import type { JsAnalysisResult, DomRef } from "./types.js"
import type { StateVariable, MethodSpec, EventBinding } from "../types.js"
import type { Node } from "@babel/types"

const require = createRequire(import.meta.url)
const traverse = require("@babel/traverse").default

// Grading Strategy Thresholds
const FULL_PARSE_LIMIT = 100 * 1024 // < 100KB: Full Babel Explanation
const FILTERED_PARSE_LIMIT = 1024 * 1024 // < 1MB: Babel parsing after prefiltering
const TRUNCATED_PARSE_LIMIT = 5 * 1024 * 1024 // < 5MB: Babel parsing after truncation

interface BabelPath {
  node: Node & Record<string, unknown>
  parent?: Node & Record<string, unknown>
}

export function analyzeJavaScript(
  js: string,
  _options?: { extractLogic?: boolean }
): JsAnalysisResult {
  const result: JsAnalysisResult = {
    state: [],
    methods: [],
    events: [],
    refs: [],
    lifecycles: {},
    todos: [],
  }

  if (!js.trim()) return result

  const size = js.length

  // Hierarchical strategy: choose different parsing methods according to file size
  if (size <= FULL_PARSE_LIMIT) {
    // < 100KB: Quick scan first, then Babel. If Babel fails, regex fallback preserved.
    const quick = quickScanJs(js)
    result.state = quick.state.map((n) => ({
      name: n,
      type: "unknown",
      initial: undefined,
      bindings: [],
      mutators: [],
      confidence: 0.3,
    }))
    result.methods = quick.handlers.map((n) => ({
      name: n,
      kind: "handler" as const,
      code: "",
      parameters: [],
      sideEffects: [],
    }))
    // Babel supplements (may fail on compressed bundles, quick scan results kept)
    const babelResult = parseWithBabel(js, emptyResult())
    result.state = mergeStateDeduped(result.state, babelResult.state)
    result.methods = mergeMethodsDeduped(result.methods, babelResult.methods)
    result.events = babelResult.events
    result.refs = babelResult.refs
    result.lifecycles = babelResult.lifecycles
    result.todos.push(...babelResult.todos)
    return result
  } else if (size <= FILTERED_PARSE_LIMIT) {
    // 100KB - 1MB: Quick Scan + Babel Parsing
    const quick = quickScanJs(js)
    result.state = quick.state.map((n) => ({
      name: n,
      type: "unknown",
      initial: undefined,
      bindings: [],
      mutators: [],
      confidence: 0.3,
    }))
    result.methods = quick.handlers.map((n) => ({
      name: n,
      kind: "handler" as const,
      code: "",
      parameters: [],
      sideEffects: [],
    }))
    // Supplemental Babel Analysis
    const babelResult = parseWithBabel(js, emptyResult())
    result.state = mergeStateDeduped(result.state, babelResult.state)
    result.methods = mergeMethodsDeduped(result.methods, babelResult.methods)
    result.events = babelResult.events
    result.refs = babelResult.refs
    result.lifecycles = babelResult.lifecycles
    result.todos.push(...babelResult.todos)
    return result
  } else if (size <= TRUNCATED_PARSE_LIMIT) {
    // 1MB - 5MB: Babel parsing after truncation
    console.warn(`⚠ JS truncated: ${fmt(size)} → ${fmt(FULL_PARSE_LIMIT)}`)
    // Quick scan first to get the full amount of information
    const quick = quickScanJs(js)
    result.state = quick.state.map((n) => ({
      name: n,
      type: "unknown",
      initial: undefined,
      bindings: [],
      mutators: [],
      confidence: 0.3,
    }))
    result.methods = quick.handlers.map((n) => ({
      name: n,
      kind: "handler" as const,
      code: "",
      parameters: [],
      sideEffects: [],
    }))
    // Truncate the first 500KB for Babel parsing.
    const truncated = js.slice(0, FULL_PARSE_LIMIT * 5)
    const babelResult = parseWithBabel(truncated, emptyResult())
    result.state = mergeStateDeduped(result.state, babelResult.state)
    result.methods = mergeMethodsDeduped(result.methods, babelResult.methods)
    result.events = babelResult.events
    result.refs = babelResult.refs
    result.lifecycles = babelResult.lifecycles
    result.todos.push(...babelResult.todos)
    result.todos.push({
      type: "unknown_pattern",
      description: `JS truncated: ${fmt(size)} parsed, full size ${fmt(size)}`,
      severity: "info",
    })
    return result
  } else {
    // > 5MB: regular fast scan only
    console.warn(`⚠ JS too large (${fmt(size)}), using quick scan only`)
    const quick = quickScanJs(js)
    result.state = quick.state.map((n) => ({
      name: n,
      type: "unknown",
      initial: undefined,
      bindings: [],
      mutators: [],
      confidence: 0.3,
    }))
    result.methods = quick.handlers.map((n) => ({
      name: n,
      kind: "handler" as const,
      code: "",
      parameters: [],
      sideEffects: [],
    }))
    result.todos.push({
      type: "unknown_pattern",
      description: `JS too large (${fmt(size)}), quick scan only — results may be incomplete`,
      severity: "warning",
    })
    return result
  }
}

function fmt(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${["B", "KB", "MB", "GB"][i]}`
}

function emptyResult(): JsAnalysisResult {
  return { state: [], methods: [], events: [], refs: [], lifecycles: {}, todos: [] }
}

function mergeStateDeduped(existing: StateVariable[], incoming: StateVariable[]): StateVariable[] {
  const names = new Set(existing.map((s) => s.name))
  return [...existing, ...incoming.filter((s) => !names.has(s.name))]
}

function mergeMethodsDeduped(existing: MethodSpec[], incoming: MethodSpec[]): MethodSpec[] {
  const names = new Set(existing.map((m) => m.name))
  return [...existing, ...incoming.filter((m) => !names.has(m.name))]
}

/**
 * Quick scan JS using regex patterns — lightweight, no Babel.
 */
function quickScanJs(js: string): { state: string[]; handlers: string[] } {
  const state: string[] = []
  const handlers: string[] = []

  // A quick scan of variable declarations
  const statePattern =
    /\b(var|let|const)\s+(\w+)\s*=\s*(['"`]|\d+|true|false|null|undefined|\{|\[)/g
  let match
  while ((match = statePattern.exec(js)) !== null) {
    const name = match[2]
    if (isLikelyState(name) && !state.includes(name)) {
      state.push(name)
    }
  }

  // 快速扫描函数定义
  const handlerPattern = /\b(?:function\s+(\w+)|(\w+)\s*=\s*(?:function|\([^)]*\)\s*=>))\s*[({]/g
  while ((match = handlerPattern.exec(js)) !== null) {
    const name = match[1] || match[2]
    if (name && isLikelyHandler(name) && !handlers.includes(name)) {
      handlers.push(name)
    }
  }

  return { state, handlers }
}

/**
 * Full Babel-based AST parsing.
 */
function parseWithBabel(js: string, result: JsAnalysisResult): JsAnalysisResult {
  try {
    const ast = parser.parse(js, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
    })

    const stateVariables = new Map<string, StateVariable>()
    const methodMap = new Map<string, MethodSpec>()
    const eventListeners: EventBinding[] = []
    const domRefs: DomRef[] = []

    interface BabelPath {
      node: Node & Record<string, unknown>
      parent?: Node & Record<string, unknown>
    }

    traverse(ast, {
      VariableDeclarator(path: BabelPath) {
        const sv = extractStateVariable(path)
        if (sv) stateVariables.set(sv.name, sv)
      },

      ObjectProperty(path: BabelPath) {
        // Detect object properties that look like state (e.g., data: { count: 0 })
        const sv = extractObjectPropertyState(path)
        if (sv) stateVariables.set(sv.name, sv)
      },

      FunctionDeclaration(path: BabelPath) {
        const method = extractMethod(path)
        if (method) {
          methodMap.set(method.name, method)
          if (isLifecycleMethod(method.name)) {
            result.lifecycles[method.name] = method
          }
        }
      },

      ArrowFunctionExpression(path: BabelPath) {
        const method = extractArrowFunction(path)
        if (method) methodMap.set(method.name, method)
      },

      AssignmentExpression(path: BabelPath) {
        // Detect state mutations like state.count = 5
        const stateRef = detectStateMutation(path)
        if (stateRef && stateVariables.has(stateRef.varName)) {
          const sv = stateVariables.get(stateRef.varName)
          if (sv) {
            sv.mutators.push(stateRef.type)
          }
        }
      },

      CallExpression(path: BabelPath) {
        // Try to extract event listeners
        const event = tryExtractEvent(path)
        if (event) eventListeners.push(event)

        // Try to extract DOM references
        const ref = tryExtractDomRef(path)
        if (ref) domRefs.push(ref)
      },
    })

    result.state = Array.from(stateVariables.values())
    result.methods = Array.from(methodMap.values())
    result.events = eventListeners
    result.refs = domRefs
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    result.todos.push({
      type: "unknown_pattern",
      description: `JS parsing error: ${errorMessage}`,
      severity: "critical",
    })
  }

  return result
}

function extractStateVariable(path: BabelPath): StateVariable | null {
  const node = path.node as unknown
  const { id, init } = node as { id?: unknown; init?: unknown }
  if (!id || (id as Record<string, unknown>).type !== "Identifier") return null

  const name = (id as Record<string, unknown>).name as string
  if (!isLikelyState(name)) return null

  return {
    name,
    type: inferType(init),
    initial: inferInitialValue(init),
    bindings: [],
    mutators: [],
    confidence: scoreAsState(name),
  }
}

function extractObjectPropertyState(path: BabelPath): StateVariable | null {
  const node = path.node as unknown
  const { key, value } = node as { key?: unknown; value?: unknown }
  if (!key || (key as Record<string, unknown>).type !== "Identifier") return null

  const name = (key as Record<string, unknown>).name as string
  if (!isLikelyState(name)) return null

  return {
    name,
    type: inferType(value),
    initial: inferInitialValue(value),
    bindings: [],
    mutators: [],
    confidence: scoreAsState(name) - 0.1, // Slightly lower for object properties
  }
}

function extractMethod(path: BabelPath): MethodSpec | null {
  const node = path.node as unknown
  const nodeObj = node as Record<string, unknown>
  const idObj = nodeObj.id as Record<string, unknown> | undefined
  const name = (idObj?.name as string | undefined) || undefined
  if (!name) return null

  const isHandler = isLikelyHandler(name)
  const isLifecycle = isLifecycleMethod(name)

  if (!isHandler && !isLifecycle) return null

  const params = (nodeObj.params as unknown[] | undefined) || []
  return {
    name,
    kind: isLifecycle ? "lifecycle" : "handler",
    code: "", // Simplified
    parameters: params.map((p) => ((p as Record<string, unknown>).name || "arg") as string),
    sideEffects: [],
  }
}

function extractArrowFunction(path: BabelPath): MethodSpec | null {
  // Try to get function name from assignment or object property
  let funcName: string | null = null

  if (path.parent?.type === "VariableDeclarator" && (path.parent as Record<string, unknown>).id) {
    funcName = ((path.parent as Record<string, unknown>).id as Record<string, unknown>)
      .name as string
  } else if (
    path.parent?.type === "ObjectProperty" &&
    (path.parent as Record<string, unknown>).key
  ) {
    funcName = ((path.parent as Record<string, unknown>).key as Record<string, unknown>)
      .name as string
  }

  if (!funcName || (!isLikelyHandler(funcName) && !isLifecycleMethod(funcName))) {
    return null
  }

  const params =
    ((path.node as Record<string, unknown>).params as Array<Record<string, unknown>>) || []
  return {
    name: funcName,
    kind: isLifecycleMethod(funcName) ? "lifecycle" : "handler",
    code: "",
    parameters: params.map((p) => (p.name || "arg") as string),
    sideEffects: [],
  }
}

function detectStateMutation(path: BabelPath): { varName: string; type: string } | null {
  const node = path.node as Record<string, unknown> & {
    left?: Record<string, unknown>
    operator?: string
  }
  if (!node.left) return null

  let varName = ""
  let mutationType = "assignment"

  if (node.left.type === "Identifier") {
    varName = ((node.left as Record<string, unknown>).name as string) || ""
  } else if (node.left.type === "MemberExpression") {
    varName =
      (((node.left as Record<string, unknown>).object as Record<string, unknown>)
        ?.name as string) || ""
  }

  // Check for compound assignments
  const op = node.operator || ""
  if (op.includes("=") && !op.startsWith("==")) {
    if (op === "++" || op === "--") {
      mutationType = op
    } else if (op.includes("+") || op.includes("-") || op.includes("*")) {
      mutationType = "arithmetic"
    }
  }

  return varName ? { varName, type: mutationType } : null
}

function tryExtractEvent(path: BabelPath): EventBinding | null {
  const node = path.node as Record<string, unknown> & {
    callee?: Record<string, unknown>
    arguments?: unknown[]
  }
  const callee = node.callee as Record<string, unknown> | undefined
  if (callee?.property && (callee.property as Record<string, unknown>).name !== "addEventListener")
    return null

  const eventArg = node.arguments?.[0]
  const handlerArg = node.arguments?.[1]

  if (!eventArg || !handlerArg) return null

  const eventArgObj = eventArg as Record<string, unknown>
  const handlerArgObj = handlerArg as Record<string, unknown>

  const event = (eventArgObj.value || eventArgObj.name || "") as string
  const handler = (handlerArgObj.name ||
    (handlerArgObj.type === "ArrowFunctionExpression" ? "arrow" : "")) as string

  if (!event) return null

  return {
    selector: "",
    event,
    handler: handler || "unnamed",
    preventDefault: false,
  }
}

function tryExtractDomRef(path: BabelPath): DomRef | null {
  const node = path.node as Record<string, unknown> & {
    callee?: Record<string, unknown>
    arguments?: unknown[]
  }
  const callee = node.callee as Record<string, unknown> | undefined

  const domMethods = [
    "getElementById",
    "getElementsByClassName",
    "getElementsByTagName",
    "querySelector",
    "querySelectorAll",
    "closest",
    "parentElement",
    "children",
    "nextElementSibling",
    "previousElementSibling",
  ]

  const methodName = ((callee?.property as Record<string, unknown>)?.name as string) || ""
  if (!domMethods.includes(methodName)) return null

  const arg = node.arguments?.[0]
  const argObj = arg as Record<string, unknown> | undefined
  const selector = ((argObj?.value || argObj?.name) as string) || ""

  if (!selector) return null

  return { selector, method: methodName }
}

interface BabelPath {
  node: Node & Record<string, unknown>
  parent?: Node & Record<string, unknown>
}

function isLikelyState(name: string): boolean {
  // Use word-boundary matching to reduce false positives from substring matches.
  // Prefixes: is*, has*, should*, current*, selected*
  // Suffixes: *Count, *List, *Items, *Value, *Data, *State, *Model, *Name, *Type, *Key, *Id, *Index, *Status, *Error, *Message, *Visible, *Active, *Loading
  // Whole words: state, data, model, form, visible, active, loading, error, result
  if (/^(is|has|should|current|selected)/i.test(name)) return true
  if (
    /(Count|List|Items|Value|Data|State|Model|Name|Type|Key|Id|Index|Status|Error|Message|Visible|Active|Loading)$/i.test(
      name
    )
  )
    return true
  return /^(state|data|model|form|visible|active|loading|error|result)$/i.test(name)
}

function isLikelyHandler(name: string): boolean {
  // Use word-boundary matching to reduce false positives.
  // Prefixes: handle*, on*
  // Suffixes: *Click, *Submit, *Change, *Toggle, *Handler, *Callback, *Action, *Request, *Response
  // Whole words: click, submit, change, toggle, fetch, load, close, open, add, remove, delete, update, save, cancel, reset, search, filter, sort, init, setup, render, refresh, retry, cleanup
  if (/^(handle|on)/i.test(name)) return true
  if (/(Click|Submit|Change|Toggle|Handler|Callback|Action|Request|Response)$/i.test(name))
    return true
  return /^(click|submit|change|toggle|fetch|load|close|open|add|remove|delete|update|save|cancel|reset|search|filter|sort|init|setup|render|refresh|retry|cleanup)$/i.test(
    name
  )
}

function isLifecycleMethod(name: string): boolean {
  const patterns = [
    "init",
    "mount",
    "unmount",
    "destroy",
    "create",
    "setup",
    "ready",
    "render",
    "update",
  ]
  return patterns.some((p) => name.toLowerCase().includes(p))
}

function scoreAsState(name: string): number {
  let score = 0.3
  // Boost score for strong prefix/suffix indicators
  if (/^(is|has|should)/i.test(name)) score += 0.2
  if (/(Data|State|Model|List|Items|Count|Value|Status|Error|Visible|Active|Loading)$/i.test(name))
    score += 0.2
  if (/(Id|Name|Type|Key|Index)$/i.test(name)) score += 0.1
  return Math.min(1, score)
}

function inferType(init: unknown): string {
  if (!init) return "unknown"
  const initObj = init as Record<string, unknown>
  if (initObj.type === "NumericLiteral") return "number"
  if (initObj.type === "StringLiteral") return "string"
  if (initObj.type === "BooleanLiteral") return "boolean"
  if (initObj.type === "ArrayExpression") return "array"
  if (initObj.type === "ObjectExpression") return "object"
  if (initObj.type === "FunctionExpression" || initObj.type === "ArrowFunctionExpression")
    return "function"
  return "unknown"
}

function inferInitialValue(init: unknown): unknown {
  if (!init) return undefined
  const initObj = init as Record<string, unknown>
  if (initObj.type === "NumericLiteral") return initObj.value
  if (initObj.type === "StringLiteral") return initObj.value
  if (initObj.type === "BooleanLiteral") return initObj.value
  if (initObj.type === "ArrayExpression") return []
  if (initObj.type === "ObjectExpression") return {}
  return undefined
}
