/** Static argument shapes for literal renderer invoke calls. Dynamic argument
 * objects remain opaque; spreads/computed keys suppress only absence checks. */
import ts from "typescript"

function unwrap(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node))
  ) {
    node = node.expression
  }
  return node
}

function literalText(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined
}

function objectKeys(node) {
  const keys = []
  let hasSpread = false
  let hasComputed = false
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      hasSpread = true
      continue
    }
    const name = property.name
    if (!name) continue
    if (ts.isComputedPropertyName(name)) {
      const key = literalText(unwrap(name.expression))
      if (key === undefined) hasComputed = true
      else keys.push(key)
    } else if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      keys.push(name.text)
    }
  }
  return { keys, hasSpread, hasComputed }
}

/** Read an object body with the same TypeScript parser used for call sites. */
export function objectLiteralKeys(body) {
  const source = ts.createSourceFile("args.ts", `({${body}})`, ts.ScriptTarget.Latest, true)
  if (source.parseDiagnostics.length) throw new Error("Invalid invoke argument object")
  return objectKeys(unwrap(source.statements[0].expression))
}

/**
 * Only literal command identifiers are in scope. Parsing syntax rather than
 * scanning text excludes comments/strings and handles nested generic types.
 */
export function findInvokeCallSites(source, file) {
  if (!/\binvoke\b/.test(source)) return []
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  if (ast.parseDiagnostics.length) {
    const diagnostic = ast.parseDiagnostics[0]
    throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`)
  }
  const sites = []
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      const isInvoke =
        (ts.isIdentifier(callee) && callee.text === "invoke") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "invoke")
      const command = literalText(unwrap(node.arguments[0]))
      if (isInvoke && command && /^[A-Za-z_][A-Za-z0-9_]*$/.test(command)) {
        const argument = unwrap(node.arguments[1])
        const empty = !argument || (ts.isIdentifier(argument) && argument.text === "undefined")
        const object = argument && ts.isObjectLiteralExpression(argument)
        const shape = object ? objectKeys(argument) : { keys: [], hasSpread: false }
        sites.push({
          command,
          file,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          kind: empty ? "none" : object ? "object" : "opaque",
          keys: shape.keys,
          hasSpread: shape.hasSpread || Boolean(shape.hasComputed),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return sites
}
