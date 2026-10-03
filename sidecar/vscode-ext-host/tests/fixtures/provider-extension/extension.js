// Registers one provider of each shape the host has to translate, and keeps
// a log of the document and editor events it sees, which it reports back as
// workspace symbols.
const vscode = require("vscode")

exports.activate = (context) => {
  const seen = []
  const selector = { language: "plaintext", scheme: "file" }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => seen.push(`open:${document.languageId}`)),
    vscode.workspace.onDidChangeTextDocument((event) =>
      seen.push(`change:${event.document.version}:${event.contentChanges[0].text}`)
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      seen.push(`active:${editor ? editor.selection.active.character : "none"}`)
    ),
    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols: () =>
        seen.map(
          (entry) =>
            new vscode.SymbolInformation(
              entry,
              vscode.SymbolKind.Event,
              "",
              new vscode.Location(vscode.Uri.file("/seen"), new vscode.Position(0, 0))
            )
        ),
    }),
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position)
        const word = range ? document.getText(range) : ""
        return new vscode.Hover(
          [new vscode.MarkdownString(`**${word}**`), `line ${document.lineAt(position.line).text}`],
          range
        )
      },
    }),
    vscode.languages.registerCompletionItemProvider(
      "plaintext",
      {
        provideCompletionItems(_document, _position, _token, completionContext) {
          const item = new vscode.CompletionItem("hello", vscode.CompletionItemKind.Keyword)
          item.insertText = new vscode.SnippetString("hello ${1:name}")
          item.documentation = new vscode.MarkdownString("Says hi")
          return new vscode.CompletionList(
            [item],
            completionContext.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter
          )
        },
      },
      "."
    ),
    vscode.languages.registerCodeActionsProvider("plaintext", {
      provideCodeActions(document, _range, actionContext) {
        if (!actionContext.only || !actionContext.only.contains(vscode.CodeActionKind.QuickFix))
          return []
        return actionContext.diagnostics.map((diagnostic) => {
          const action = new vscode.CodeAction(
            `Fix ${diagnostic.message}`,
            vscode.CodeActionKind.QuickFix
          )
          action.edit = new vscode.WorkspaceEdit()
          action.edit.replace(document.uri, diagnostic.range, "fixed")
          action.diagnostics = [diagnostic]
          return action
        })
      },
    }),
    vscode.languages.registerDefinitionProvider("plaintext", {
      provideDefinition: (document) => new vscode.Location(document.uri, new vscode.Position(0, 0)),
    }),
    vscode.languages.registerFoldingRangeProvider("plaintext", {
      provideFoldingRanges: () => [new vscode.FoldingRange(0, 2, vscode.FoldingRangeKind.Region)],
    }),
    vscode.languages.registerSignatureHelpProvider(
      "plaintext",
      {
        provideSignatureHelp(_document, _position, _token, helpContext) {
          const help = new vscode.SignatureHelp()
          const signature = new vscode.SignatureInformation(
            `greet(${helpContext.triggerCharacter})`
          )
          signature.parameters = [new vscode.ParameterInformation("name")]
          help.signatures = [signature]
          return help
        },
      },
      { triggerCharacters: ["("], retriggerCharacters: [","] }
    ),
    vscode.languages.registerCallHierarchyProvider("plaintext", {
      prepareCallHierarchy(document) {
        const item = new vscode.CallHierarchyItem(
          vscode.SymbolKind.Function,
          "main",
          "",
          document.uri,
          new vscode.Range(0, 0, 0, 4),
          new vscode.Range(0, 0, 0, 4)
        )
        item.secret = "kept on the item"
        return item
      },
      provideCallHierarchyIncomingCalls: (item) => [
        new vscode.CallHierarchyIncomingCall(
          new vscode.CallHierarchyItem(
            item.kind,
            item.secret,
            "",
            item.uri,
            item.range,
            item.range
          ),
          [item.range]
        ),
      ],
      provideCallHierarchyOutgoingCalls: () => [],
    }),
    // Answers only once the call is cancelled, to prove the token is live.
    vscode.languages.registerReferenceProvider("plaintext", {
      provideReferences: (document, _position, _context, token) =>
        new Promise((resolve) => {
          token.onCancellationRequested(() =>
            resolve([new vscode.Location(document.uri, new vscode.Position(9, 9))])
          )
        }),
    })
  )
}
