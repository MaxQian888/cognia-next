/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node CommonJS harness */
const fs = require("fs")
const path = require("path")
const cp = require("child_process")
const crypto = require("crypto")
const root = path.resolve(process.argv[2] || process.cwd())
const ts = require(root + "/node_modules/typescript")
const { createRequire } = require("module")
const localRequire = createRequire(root + "/node_modules/next-intl/package.json")
const { IntlMessageFormat } = localRequire("intl-messageformat")
const output = path.resolve(process.argv[3] || __dirname)
fs.mkdirSync(output, { recursive: true })
const scope = [
  "app",
  "components",
  "hooks",
  "lib",
  "stores",
  "packages",
  "plugins",
  "services",
  "web",
]
const gitFiles = cp
  .execFileSync("rtk", ["proxy", "git", "ls-files", "-co", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  .trim()
  .split("\n")
const rgFiles = cp
  .execFileSync("rtk", ["proxy", "rg", "--files", ...scope], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  .trim()
  .split("\n")
const files = [...new Set([...gitFiles, ...rgFiles])].filter(
  (f) =>
    /^(app|components|hooks|lib|stores|packages|plugins|services|web)\//.test(f) &&
    /\.[cm]?[jt]sx?$/.test(f) &&
    !/(^|\/)(node_modules|out|dist|build|\.next|\.source|__mocks__|__tests__|fixtures|e2e|tests)(\/|$)|\.(test|spec|stories)\.|\.d\.ts$/.test(
      f
    )
)
const locales = {}
const flatten = (obj, prefix = "", out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + "." + k : k
    if (typeof v === "string") out[key] = v
    else if (v && typeof v === "object") flatten(v, key, out)
  }
  return out
}
for (const l of ["en", "zh-CN"])
  locales[l] = flatten(JSON.parse(fs.readFileSync(root + "/i18n/messages/" + l + ".json", "utf8")))
function preview(message) {
  if (!message) return null
  try {
    const fmt = new IntlMessageFormat(message, "zh-CN")
    const values = {}
    function fill(ast) {
      for (const n of ast) {
        if (n.type === 1) values[n.value] = "…"
        else if ([2, 3, 4, 6, 7].includes(n.type)) values[n.value] = 2
        else if (n.type === 5) values[n.value] = "other"
        else if (n.type === 8) values[n.value] = (chunks) => chunks.join("")
        if (n.options) for (const o of Object.values(n.options)) fill(o.value)
        if (n.children) fill(n.children)
      }
    }
    fill(fmt.getAst())
    return String(fmt.format(values))
  } catch {
    return message
  }
}
const calls = [],
  notificationCalls = [],
  otherCalls = [],
  sourceHashes = {}
let scanned = 0
for (const file of files) {
  let source
  try {
    source = fs.readFileSync(path.join(root, file), "utf8")
  } catch {
    continue
  }
  scanned++
  if (!/toast|notify|deliver|diagnostic/i.test(source)) continue
  sourceHashes[file] = crypto.createHash("sha256").update(source).digest("hex")
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const translators = []
  const toastNames = new Set(["toast"])
  const toastFunctions = new Map()
  const notificationAliases = new Map()
  function collect(n) {
    if (
      ts.isImportDeclaration(n) &&
      n.importClause?.namedBindings &&
      ts.isNamedImports(n.importClause.namedBindings)
    )
      for (const e of n.importClause.namedBindings.elements) {
        const original = e.propertyName?.text || e.name.text
        if (original === "toast") toastNames.add(e.name.text)
        if (/^(notify|deliver|dispatchDiagnostic|emitDiagnostic|showToast)$/.test(original))
          notificationAliases.set(e.name.text, n.moduleSpecifier.text)
      }
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (
        ts.isIdentifier(n.name) &&
        ts.isCallExpression(n.initializer) &&
        /(useTranslations|getTranslations)$/.test(n.initializer.expression.getText(sf))
      ) {
        const a = n.initializer.arguments[0]
        const namespace = a && ts.isStringLiteralLike(a) ? a.text : null
        let scope = n.parent
        while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope))
          scope = scope.parent
        translators.push({ name: n.name.text, namespace, start: scope.pos, end: scope.end })
      }
      if (
        ts.isIdentifier(n.name) &&
        ts.isPropertyAccessExpression(n.initializer) &&
        toastNames.has(n.initializer.expression.getText(sf))
      )
        toastFunctions.set(n.name.text, n.initializer.name.text)
      if (ts.isIdentifier(n.name) && ts.isConditionalExpression(n.initializer)) {
        const kinds = new Set()
        function getKinds(a) {
          if (ts.isPropertyAccessExpression(a) && toastNames.has(a.expression.getText(sf)))
            kinds.add(a.name.text)
          ts.forEachChild(a, getKinds)
        }
        getKinds(n.initializer)
        if (kinds.size) toastFunctions.set(n.name.text, [...kinds].sort().join("|"))
      }
    }
    ts.forEachChild(n, collect)
  }
  collect(sf)
  const text = (n) => n?.getText(sf) || ""
  function translations(node) {
    const result = []
    if (!node) return result
    function visit(n) {
      if (ts.isCallExpression(n)) {
        const expr = text(n.expression)
        const name = expr.replace(/Ref\.current$/, "")
        const matching = translators
          .filter((t) => (t.name === expr || t.name === name) && t.start <= n.pos && t.end >= n.end)
          .sort((a, b) => a.end - a.start - (b.end - b.start))
        if (matching.length) {
          const tr = matching[0]
          const arg = n.arguments[0]
          if (arg) {
            let patterns = []
            if (ts.isStringLiteralLike(arg)) patterns = [arg.text]
            else if (ts.isTemplateExpression(arg))
              patterns = [
                arg.head.text + arg.templateSpans.map((s) => "*" + s.literal.text).join(""),
              ]
            else if (ts.isConditionalExpression(arg)) {
              for (const a of [arg.whenTrue, arg.whenFalse])
                if (ts.isStringLiteralLike(a)) patterns.push(a.text)
            }
            for (const p of patterns) {
              const key = tr.namespace ? tr.namespace + "." + p : p
              const re = new RegExp(
                "^" +
                  key
                    .split("*")
                    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                    .join(".*") +
                  "$"
              )
              const keys = p.includes("*")
                ? Object.keys(locales["zh-CN"]).filter((k) => re.test(k))
                : [key]
              for (const k of keys)
                result.push({
                  key: k,
                  zh: locales["zh-CN"][k] || null,
                  en: locales.en[k] || null,
                  zhPreview: preview(locales["zh-CN"][k]),
                  dynamic: p.includes("*"),
                })
            }
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(node)
    return [...new Map(result.map((r) => [r.key, r])).values()]
  }
  function unwrap(n) {
    while (n && ts.isParenthesizedExpression(n)) n = n.expression
    return n
  }
  function options(n) {
    n = unwrap(n)
    if (!n) return {}
    if (ts.isObjectLiteralExpression(n)) {
      const obj = {}
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
          obj[p.name.getText(sf).replace(/^['"]|['"]$/g, "")] = ts.isPropertyAssignment(p)
            ? p.initializer
            : p.name
        else if (ts.isSpreadAssignment(p)) {
          obj.__spread = p.expression
          const spread = unwrap(p.expression)
          if (ts.isConditionalExpression(spread)) {
            for (const branch of [spread.whenTrue, spread.whenFalse])
              if (ts.isObjectLiteralExpression(unwrap(branch))) Object.assign(obj, options(branch))
          }
        }
      }
      return obj
    }
    return { __unresolved: n }
  }
  function walk(n) {
    if (ts.isCallExpression(n)) {
      const expr = text(n.expression)
      let method = null
      if (
        ts.isPropertyAccessExpression(n.expression) &&
        toastNames.has(text(n.expression.expression))
      )
        method = n.expression.name.text
      else if (
        ts.isElementAccessExpression(n.expression) &&
        toastNames.has(text(n.expression.expression))
      )
        method = "dynamic"
      else if (toastNames.has(expr)) method = "plain"
      else if (toastFunctions.has(expr)) method = toastFunctions.get(expr)
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
      if (method) {
        const opt = options(n.arguments[1])
        let body = n.arguments[0]
        if (method === "promise") body = opt.error
        const trs = translations(body),
          desc = translations(opt.description)
        const all = translations(n)
        let raw = false
        function findRaw(a) {
          if (!a) return
          if (ts.isStringLiteralLike(a) || ts.isNoSubstitutionTemplateLiteral(a)) return
          if (ts.isConditionalExpression(a)) {
            findRaw(a.whenTrue)
            findRaw(a.whenFalse)
            return
          }
          if (ts.isPropertyAccessExpression(a)) {
            if (/^(message|error|reason|detail|summary)$/.test(a.name.text)) raw = true
            return
          }
          if (ts.isPropertyAssignment(a)) {
            findRaw(a.initializer)
            return
          }
          if (
            ts.isIdentifier(a) &&
            /^(message|error|err|cause|reason|detail|summary|errorMessage|errorText|errReason)$/.test(
              a.text
            )
          )
            raw = true
          if (ts.isCallExpression(a) && /JSON\.stringify|\.join$|^String$/.test(text(a.expression)))
            raw = true
          if (ts.isCallExpression(a) && translators.some((t) => t.name === text(a.expression))) {
            for (const arg of a.arguments.slice(1)) findRaw(arg)
            return
          }
          ts.forEachChild(a, findRaw)
        }
        findRaw(body)
        findRaw(opt.description)
        const maxTitle = Math.max(
            0,
            ...trs.filter((t) => !t.dynamic).map((t) => t.zhPreview?.length || 0)
          ),
          maxDesc = Math.max(
            0,
            ...desc.filter((t) => !t.dynamic).map((t) => t.zhPreview?.length || 0)
          )
        const action = !!opt.action && !/^(?:undefined|null|false)$/.test(text(opt.action))
        const guide = trs
          .concat(desc)
          .some((t) =>
            /请|重试|检查|授权|安装|切换|重新|打开|前往|允许|解锁|在.{0,12}(?:设置|选择)/.test(
              t.zh || ""
            )
          )
        const bucket = action
          ? "button"
          : raw
            ? "runtime-detail"
            : maxTitle >= 60 || maxDesc >= 100
              ? "long-static"
              : guide
                ? "guidance-text"
                : "short-or-unresolved"
        calls.push({
          file,
          line,
          method,
          code: text(n),
          messageExpression: text(body),
          descriptionExpression: text(opt.description),
          actionExpression: text(opt.action),
          action,
          description: !!opt.description,
          unknownOptions: !!(opt.__spread || opt.__unresolved),
          rawRuntimeDetail: raw,
          maxZhTitleLength: maxTitle,
          maxZhDescriptionLength: maxDesc,
          staticGuidanceHint: guide,
          bucket,
          translations: all,
          titleTranslations: trs,
          descriptionTranslations: desc,
        })
      } else if (
        notificationAliases.has(expr) ||
        /(^|\.)(notify|deliver|dispatchDiagnostic|emitDiagnostic|showToast|showErrorToast|notifyError)$/.test(
          expr
        )
      ) {
        const opt = options(n.arguments[0])
        notificationCalls.push({
          file,
          line,
          callee: expr,
          importSource: notificationAliases.get(expr) || null,
          code: text(n),
          levelExpression: text(opt.level) || text(n.arguments[1]),
          actionsExpression: text(opt.actions),
          translations: translations(n),
        })
      } else if (/toast|notifyError|showErrorToast/i.test(expr))
        otherCalls.push({ file, line, callee: expr, code: text(n) })
    }
    ts.forEachChild(n, walk)
  }
  walk(sf)
}
const primary = calls.filter((c) => c.method === "error")
const warnings = calls.filter((c) => c.method === "warning")
const promises = calls.filter((c) => c.method === "promise" && c.messageExpression)
const count = (rows, key) => rows.reduce((a, r) => ((a[r[key]] = (a[r[key]] || 0) + 1), a), {})
const summary = {
  date: "2026-10-09",
  head: cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  scannedFiles: scanned,
  toastCalls: calls.length,
  methods: count(calls, "method"),
  errorFiles: new Set(primary.map((c) => c.file)).size,
  errorBuckets: count(primary, "bucket"),
  warningBuckets: count(warnings, "bucket"),
  promiseErrors: promises.length,
  errorsWithDescription: primary.filter((c) => c.description).length,
  errorsWithUnknownOptions: primary.filter((c) => c.unknownOptions).length,
  errorsWithRuntimeDetail: primary.filter((c) => c.rawRuntimeDetail).length,
  errorsWithResolvedTitle: primary.filter((c) => c.titleTranslations.some((t) => t.zh)).length,
  notificationCalls: notificationCalls.length,
  otherToastCalls: otherCalls.length,
}
sourceHashes["i18n/messages/zh-CN.json"] = crypto
  .createHash("sha256")
  .update(fs.readFileSync(root + "/i18n/messages/zh-CN.json"))
  .digest("hex")
sourceHashes["i18n/messages/en.json"] = crypto
  .createHash("sha256")
  .update(fs.readFileSync(root + "/i18n/messages/en.json"))
  .digest("hex")
fs.writeFileSync(
  output + "/inventory.json",
  JSON.stringify({ summary, calls, notificationCalls, otherCalls }, null, 2)
)
fs.writeFileSync(output + "/source-hashes.json", JSON.stringify(sourceHashes, null, 2))
fs.writeFileSync(output + "/summary.json", JSON.stringify(summary, null, 2))
const esc = (s) => '"' + String(s ?? "").replaceAll('"', '""') + '"'
fs.writeFileSync(
  output + "/inventory.csv",
  "file,line,method,bucket,action,description,runtime_detail,max_zh_title_length,max_zh_description_length,zh_title,zh_description,action_expression,source\n" +
    calls
      .filter(
        (c) =>
          ["error", "warning", "promise", "custom", "dynamic"].includes(c.method) ||
          c.method.includes("|")
      )
      .map((c) =>
        [
          c.file,
          c.line,
          c.method,
          c.bucket,
          c.action,
          c.description,
          c.rawRuntimeDetail,
          c.maxZhTitleLength,
          c.maxZhDescriptionLength,
          c.titleTranslations.map((t) => t.zhPreview || t.zh || t.key).join(" | "),
          c.descriptionTranslations.map((t) => t.zhPreview || t.zh || t.key).join(" | "),
          c.actionExpression,
          c.code,
        ]
          .map(esc)
          .join(",")
      )
      .join("\n")
)
console.log(JSON.stringify(summary, null, 2))
