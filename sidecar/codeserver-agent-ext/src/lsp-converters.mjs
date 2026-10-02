/**
 * LSP ⇄ VS Code value conversion for the managed language-server adapter.
 *
 * A language server answers in LSP JSON; VS Code's providers must return VS
 * Code types. Handing it the JSON as is fails quietly: VS Code's converters
 * throw on a `MarkupContent` where they expect `MarkdownString[]`, or on a
 * `uri` string where they expect a `Uri`, and the feature shows nothing. The
 * other direction has its own traps: `Range.toJSON()` is `[start, end]`, not
 * `{ start, end }`, and VS Code numbers several enums from 0 where LSP numbers
 * them from 1 (completion trigger kinds, completion/symbol kinds, diagnostic
 * severities, highlight kinds).
 *
 * Items a server may later resolve (completion items, code actions, code
 * lenses, links, inlay hints, hierarchy items, workspace symbols) remember the
 * LSP value they came from, so the resolve request carries the server's own
 * `data` back unchanged. Diagnostics remember theirs for the same reason when
 * they return inside a code action context.
 */

const FOLDING_KINDS = { comment: "Comment", imports: "Imports", region: "Region" }

export function createLspConverters(vscode) {
  const origins = new WeakMap()
  const remember = (converted, original) => {
    if (converted && typeof converted === "object") origins.set(converted, original)
    return converted
  }
  const originOf = (value) => (value && typeof value === "object" ? origins.get(value) : undefined)

  // --- protocol → code -----------------------------------------------------

  const uri = (value) => vscode.Uri.parse(String(value))
  const position = (value) => new vscode.Position(value?.line ?? 0, value?.character ?? 0)
  const range = (value) =>
    new vscode.Range(
      value?.start?.line ?? 0,
      value?.start?.character ?? 0,
      value?.end?.line ?? 0,
      value?.end?.character ?? 0
    )
  const optionalRange = (value) => (value ? range(value) : undefined)
  const location = (value) => new vscode.Location(uri(value.uri), range(value.range))

  function markdown(value) {
    if (value == null) return undefined
    if (typeof value === "string") return new vscode.MarkdownString(value)
    if (value.kind === "plaintext") return new vscode.MarkdownString().appendText(value.value ?? "")
    if (value.kind === "markdown") return new vscode.MarkdownString(value.value ?? "")
    // A legacy MarkedString `{ language, value }`.
    if (typeof value.language === "string") {
      return new vscode.MarkdownString().appendCodeblock(value.value ?? "", value.language)
    }
    return new vscode.MarkdownString(String(value.value ?? ""))
  }
  /** Documentation: plain strings stay strings, as VS Code renders them as text. */
  const documentation = (value) => (typeof value === "string" ? value : markdown(value))

  function command(value) {
    if (!value || typeof value.command !== "string") return undefined
    return {
      title: String(value.title ?? ""),
      command: value.command,
      ...(Array.isArray(value.arguments) ? { arguments: value.arguments } : {}),
      ...(value.tooltip ? { tooltip: value.tooltip } : {}),
    }
  }

  const textEdit = (value) =>
    vscode.TextEdit.replace(range(value.range), String(value.newText ?? ""))
  const textEdits = (value) => (Array.isArray(value) ? value.map(textEdit) : undefined)

  function diagnostic(value) {
    const result = new vscode.Diagnostic(
      range(value.range),
      String(value.message ?? ""),
      // LSP Error = 1 … Hint = 4; VS Code Error = 0 … Hint = 3.
      typeof value.severity === "number"
        ? value.severity - 1
        : (vscode.DiagnosticSeverity?.Error ?? 0)
    )
    if (value.code !== undefined) {
      result.code = value.codeDescription?.href
        ? { value: value.code, target: uri(value.codeDescription.href) }
        : value.code
    }
    if (value.source) result.source = value.source
    if (Array.isArray(value.tags)) result.tags = value.tags
    if (Array.isArray(value.relatedInformation)) {
      result.relatedInformation = value.relatedInformation.map(
        (info) => new vscode.DiagnosticRelatedInformation(location(info.location), info.message)
      )
    }
    return remember(result, value)
  }

  function hover(value) {
    if (!value) return undefined
    const contents = Array.isArray(value.contents) ? value.contents : [value.contents]
    return new vscode.Hover(contents.map(markdown).filter(Boolean), optionalRange(value.range))
  }

  function locationLink(value) {
    return {
      originSelectionRange: optionalRange(value.originSelectionRange),
      targetUri: uri(value.targetUri),
      targetRange: range(value.targetRange),
      targetSelectionRange: optionalRange(value.targetSelectionRange ?? value.targetRange),
    }
  }
  function definition(value) {
    if (!value) return undefined
    const entries = Array.isArray(value) ? value : [value]
    return entries.map((entry) => (entry.targetUri ? locationLink(entry) : location(entry)))
  }
  const locations = (value) => (Array.isArray(value) ? value.map(location) : undefined)

  function completionItem(value, defaults = {}) {
    const label = value.labelDetails
      ? {
          label: value.label,
          detail: value.labelDetails.detail,
          description: value.labelDetails.description,
        }
      : value.label
    const item = new vscode.CompletionItem(
      label,
      typeof value.kind === "number" ? value.kind - 1 : undefined
    )
    if (value.detail) item.detail = value.detail
    if (value.documentation) item.documentation = documentation(value.documentation)
    if (value.sortText) item.sortText = value.sortText
    if (value.filterText) item.filterText = value.filterText
    if (value.preselect) item.preselect = true
    if (Array.isArray(value.tags)) item.tags = value.tags
    const commitCharacters = value.commitCharacters ?? defaults.commitCharacters
    if (commitCharacters) item.commitCharacters = commitCharacters
    const format = value.insertTextFormat ?? defaults.insertTextFormat
    const text = value.textEdit?.newText ?? value.textEditText ?? value.insertText ?? value.label
    item.insertText = format === 2 ? new vscode.SnippetString(text) : text
    const edit = value.textEdit ?? (defaults.editRange ? { range: defaults.editRange } : undefined)
    if (edit?.insert && edit?.replace) {
      item.range = { inserting: range(edit.insert), replacing: range(edit.replace) }
    } else if (edit?.range?.insert && edit?.range?.replace) {
      item.range = { inserting: range(edit.range.insert), replacing: range(edit.range.replace) }
    } else if (edit?.range) {
      item.range = range(edit.range)
    }
    if (value.additionalTextEdits) item.additionalTextEdits = textEdits(value.additionalTextEdits)
    if (value.command) item.command = command(value.command)
    return remember(item, value)
  }
  function completion(value) {
    if (!value) return undefined
    if (Array.isArray(value)) return value.map((item) => completionItem(item))
    const defaults = value.itemDefaults ?? {}
    return new vscode.CompletionList(
      (value.items ?? []).map((item) => completionItem(item, defaults)),
      value.isIncomplete === true
    )
  }

  const documentHighlights = (value) =>
    Array.isArray(value)
      ? value.map(
          (entry) =>
            new vscode.DocumentHighlight(
              range(entry.range),
              typeof entry.kind === "number" ? entry.kind - 1 : undefined
            )
        )
      : undefined

  function documentSymbol(value) {
    const symbol = new vscode.DocumentSymbol(
      String(value.name ?? ""),
      String(value.detail ?? ""),
      (value.kind ?? 1) - 1,
      range(value.range),
      range(value.selectionRange ?? value.range)
    )
    if (Array.isArray(value.tags)) symbol.tags = value.tags
    symbol.children = (value.children ?? []).map(documentSymbol)
    return symbol
  }
  function symbolInformation(value) {
    const where = value.location?.range
      ? location(value.location)
      : new vscode.Location(uri(value.location?.uri ?? ""), new vscode.Range(0, 0, 0, 0))
    const symbol = new vscode.SymbolInformation(
      String(value.name ?? ""),
      (value.kind ?? 1) - 1,
      String(value.containerName ?? ""),
      where
    )
    if (Array.isArray(value.tags)) symbol.tags = value.tags
    return remember(symbol, value)
  }
  function documentSymbols(value) {
    if (!Array.isArray(value)) return undefined
    return value.map((entry) => (entry.location ? symbolInformation(entry) : documentSymbol(entry)))
  }
  const workspaceSymbols = (value) =>
    Array.isArray(value) ? value.map(symbolInformation) : undefined

  /** A code action (or bare command); `reviveEdit` turns a WorkspaceEdit into VS Code's. */
  function codeAction(value, reviveEdit) {
    if (typeof value.command === "string") return command(value)
    const action = new vscode.CodeAction(
      String(value.title ?? ""),
      value.kind ? vscode.CodeActionKind.Empty.append(value.kind) : undefined
    )
    applyCodeAction(action, value, reviveEdit)
    return remember(action, value)
  }
  function applyCodeAction(action, value, reviveEdit) {
    if (Array.isArray(value.diagnostics)) action.diagnostics = value.diagnostics.map(diagnostic)
    if (value.edit) action.edit = reviveEdit(value.edit)
    if (value.command) action.command = command(value.command)
    if (value.isPreferred) action.isPreferred = true
    if (value.disabled) action.disabled = { reason: String(value.disabled.reason ?? "") }
    return action
  }
  const codeActions = (value, reviveEdit) =>
    Array.isArray(value) ? value.map((entry) => codeAction(entry, reviveEdit)) : undefined

  const codeLens = (value) =>
    remember(new vscode.CodeLens(range(value.range), command(value.command)), value)
  const codeLenses = (value) => (Array.isArray(value) ? value.map(codeLens) : undefined)

  function documentLink(value) {
    const link = new vscode.DocumentLink(
      range(value.range),
      value.target ? uri(value.target) : undefined
    )
    if (value.tooltip) link.tooltip = value.tooltip
    return remember(link, value)
  }
  const documentLinks = (value) => (Array.isArray(value) ? value.map(documentLink) : undefined)

  const color = (value) => new vscode.Color(value.red, value.green, value.blue, value.alpha)
  const colorInformation = (value) =>
    Array.isArray(value)
      ? value.map((entry) => new vscode.ColorInformation(range(entry.range), color(entry.color)))
      : undefined
  const colorPresentations = (value) =>
    Array.isArray(value)
      ? value.map((entry) => {
          const presentation = new vscode.ColorPresentation(String(entry.label ?? ""))
          if (entry.textEdit) presentation.textEdit = textEdit(entry.textEdit)
          if (entry.additionalTextEdits) {
            presentation.additionalTextEdits = textEdits(entry.additionalTextEdits)
          }
          return presentation
        })
      : undefined

  function prepareRename(value) {
    // `null`: the server says nothing here can be renamed.
    if (value == null) throw new Error("The element can't be renamed.")
    if (value.defaultBehavior) return undefined
    if (value.range)
      return { range: range(value.range), placeholder: String(value.placeholder ?? "") }
    return range(value)
  }

  const foldingRanges = (value) =>
    Array.isArray(value)
      ? value.map(
          (entry) =>
            new vscode.FoldingRange(
              entry.startLine,
              entry.endLine,
              FOLDING_KINDS[entry.kind]
                ? vscode.FoldingRangeKind[FOLDING_KINDS[entry.kind]]
                : undefined
            )
        )
      : undefined

  const selectionRange = (value) =>
    new vscode.SelectionRange(
      range(value.range),
      value.parent ? selectionRange(value.parent) : undefined
    )
  const selectionRanges = (value) => (Array.isArray(value) ? value.map(selectionRange) : undefined)

  function signatureHelp(value) {
    if (!value) return undefined
    const help = new vscode.SignatureHelp()
    help.signatures = (value.signatures ?? []).map((entry) => {
      const signature = new vscode.SignatureInformation(
        String(entry.label ?? ""),
        documentation(entry.documentation)
      )
      signature.parameters = (entry.parameters ?? []).map(
        (parameter) =>
          new vscode.ParameterInformation(parameter.label, documentation(parameter.documentation))
      )
      if (typeof entry.activeParameter === "number")
        signature.activeParameter = entry.activeParameter
      return signature
    })
    help.activeSignature = value.activeSignature ?? 0
    help.activeParameter = value.activeParameter ?? 0
    return remember(help, value)
  }

  const inlineValues = (value) =>
    Array.isArray(value)
      ? value.map((entry) => {
          if (typeof entry.text === "string") {
            return new vscode.InlineValueText(range(entry.range), entry.text)
          }
          // LSP tells a variable lookup apart by its required `caseSensitiveLookup`.
          if (typeof entry.caseSensitiveLookup === "boolean") {
            return new vscode.InlineValueVariableLookup(
              range(entry.range),
              entry.variableName,
              entry.caseSensitiveLookup
            )
          }
          return new vscode.InlineValueEvaluatableExpression(range(entry.range), entry.expression)
        })
      : undefined

  function inlayHint(value) {
    const label =
      typeof value.label === "string"
        ? value.label
        : value.label.map((part) => {
            const labelPart = new vscode.InlayHintLabelPart(String(part.value ?? ""))
            if (part.tooltip) labelPart.tooltip = documentation(part.tooltip)
            if (part.location) labelPart.location = location(part.location)
            if (part.command) labelPart.command = command(part.command)
            return labelPart
          })
    const hint = new vscode.InlayHint(position(value.position), label, value.kind)
    if (value.tooltip) hint.tooltip = documentation(value.tooltip)
    if (value.paddingLeft) hint.paddingLeft = true
    if (value.paddingRight) hint.paddingRight = true
    if (value.textEdits) hint.textEdits = textEdits(value.textEdits)
    return remember(hint, value)
  }
  const inlayHints = (value) => (Array.isArray(value) ? value.map(inlayHint) : undefined)

  const linkedEditingRanges = (value) =>
    value
      ? new vscode.LinkedEditingRanges(
          (value.ranges ?? []).map(range),
          value.wordPattern ? new RegExp(value.wordPattern) : undefined
        )
      : undefined

  function hierarchyItem(Type, value) {
    const item = new Type(
      (value.kind ?? 1) - 1,
      String(value.name ?? ""),
      String(value.detail ?? ""),
      uri(value.uri),
      range(value.range),
      range(value.selectionRange ?? value.range)
    )
    if (Array.isArray(value.tags)) item.tags = value.tags
    return remember(item, value)
  }
  const callHierarchyItems = (value) =>
    Array.isArray(value)
      ? value.map((entry) => hierarchyItem(vscode.CallHierarchyItem, entry))
      : undefined
  const incomingCalls = (value) =>
    Array.isArray(value)
      ? value.map(
          (entry) =>
            new vscode.CallHierarchyIncomingCall(
              hierarchyItem(vscode.CallHierarchyItem, entry.from),
              (entry.fromRanges ?? []).map(range)
            )
        )
      : undefined
  const outgoingCalls = (value) =>
    Array.isArray(value)
      ? value.map(
          (entry) =>
            new vscode.CallHierarchyOutgoingCall(
              hierarchyItem(vscode.CallHierarchyItem, entry.to),
              (entry.fromRanges ?? []).map(range)
            )
        )
      : undefined
  const typeHierarchyItems = (value) =>
    Array.isArray(value)
      ? value.map((entry) => hierarchyItem(vscode.TypeHierarchyItem, entry))
      : undefined

  // --- code → protocol -----------------------------------------------------

  const toPosition = (value) => ({ line: value.line, character: value.character })
  const toRange = (value) => ({ start: toPosition(value.start), end: toPosition(value.end) })
  const toMarkup = (value) =>
    value == null
      ? undefined
      : typeof value === "string"
        ? value
        : { kind: "markdown", value: String(value.value ?? "") }

  function toDiagnostic(value) {
    const original = originOf(value)
    if (original) return original
    const code = value.code && typeof value.code === "object" ? value.code.value : value.code
    return {
      range: toRange(value.range),
      message: value.message,
      severity: typeof value.severity === "number" ? value.severity + 1 : undefined,
      ...(code !== undefined ? { code } : {}),
      ...(value.source ? { source: value.source } : {}),
      ...(value.tags?.length ? { tags: value.tags } : {}),
    }
  }

  const toCompletionContext = (value) => ({
    // VS Code Invoke = 0 … TriggerForIncompleteCompletions = 2; LSP from 1.
    triggerKind: (value?.triggerKind ?? 0) + 1,
    ...(value?.triggerCharacter ? { triggerCharacter: value.triggerCharacter } : {}),
  })

  const toCodeActionContext = (value) => ({
    diagnostics: (value?.diagnostics ?? []).map(toDiagnostic),
    ...(value?.only ? { only: [value.only.value] } : {}),
    ...(value?.triggerKind ? { triggerKind: value.triggerKind } : {}),
  })

  function toSignatureHelp(value) {
    if (!value) return undefined
    return (
      originOf(value) ?? {
        signatures: value.signatures.map((signature) => ({
          label: signature.label,
          documentation: toMarkup(signature.documentation),
          parameters: (signature.parameters ?? []).map((parameter) => ({
            label: parameter.label,
            documentation: toMarkup(parameter.documentation),
          })),
          ...(typeof signature.activeParameter === "number"
            ? { activeParameter: signature.activeParameter }
            : {}),
        })),
        activeSignature: value.activeSignature,
        activeParameter: value.activeParameter,
      }
    )
  }
  const toSignatureHelpContext = (value) => ({
    triggerKind: value?.triggerKind ?? 1,
    isRetrigger: value?.isRetrigger === true,
    ...(value?.triggerCharacter ? { triggerCharacter: value.triggerCharacter } : {}),
    ...(value?.activeSignatureHelp
      ? { activeSignatureHelp: toSignatureHelp(value.activeSignatureHelp) }
      : {}),
  })

  const toInlineValueContext = (value) => ({
    frameId: value.frameId,
    stoppedLocation: toRange(value.stoppedLocation),
  })

  function toHierarchyItem(value) {
    return (
      originOf(value) ?? {
        name: value.name,
        kind: value.kind + 1,
        detail: value.detail,
        uri: value.uri.toString(),
        range: toRange(value.range),
        selectionRange: toRange(value.selectionRange),
      }
    )
  }

  return {
    originOf,
    // protocol → code
    applyCodeAction,
    codeActions,
    codeLens,
    codeLenses,
    colorInformation,
    colorPresentations,
    command,
    completion,
    completionItem,
    definition,
    diagnostic,
    documentHighlights,
    documentLink,
    documentLinks,
    documentSymbols,
    foldingRanges,
    hover,
    callHierarchyItems,
    incomingCalls,
    outgoingCalls,
    inlayHint,
    inlayHints,
    inlineValues,
    linkedEditingRanges,
    locations,
    prepareRename,
    range,
    selectionRanges,
    signatureHelp,
    symbolInformation,
    textEdits,
    typeHierarchyItems,
    workspaceSymbols,
    // code → protocol
    toCodeActionContext,
    toCompletionContext,
    toDiagnostic,
    toHierarchyItem,
    toInlineValueContext,
    toPosition,
    toRange,
    toSignatureHelpContext,
  }
}
