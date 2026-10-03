// Drives `vscode.lm` the ways extensions do; each command returns what the
// extension saw.
const vscode = require("vscode")

exports.activate = (context) => {
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  const access = context.languageModelAccessInformation
  let modelsChanged = 0
  let accessChanged = 0
  context.subscriptions.push(vscode.lm.onDidChangeChatModels(() => modelsChanged++))
  context.subscriptions.push(access.onDidChange(() => accessChanged++))

  const model = async () => {
    const [first] = await vscode.lm.selectChatModels({ vendor: "cognia" })
    return first
  }
  const failure = (error) => ({
    name: error.name,
    code: error.code,
    message: error.message,
    isLanguageModelError: error instanceof vscode.LanguageModelError,
    isCancellation: error instanceof vscode.CancellationError,
  })

  register("lmFixture.select", async () => {
    // JSON drops `undefined`, so it is spelled out.
    const before = String(access.canSendRequest({ id: "cognia/fixture" }))
    const chat = await model()
    return {
      id: chat.id,
      name: chat.name,
      vendor: chat.vendor,
      family: chat.family,
      version: chat.version,
      maxInputTokens: chat.maxInputTokens,
      methods: [typeof chat.sendRequest, typeof chat.countTokens],
      before,
      after: access.canSendRequest(chat),
      none: await vscode.lm.selectChatModels({ vendor: "copilot" }),
    }
  })
  register("lmFixture.ask", async () => {
    const chat = await model()
    const response = await chat.sendRequest(
      [
        vscode.LanguageModelChatMessage.User("Say hello"),
        vscode.LanguageModelChatMessage.Assistant([
          new vscode.LanguageModelTextPart("Hel"),
          new vscode.LanguageModelTextPart("lo?"),
        ]),
      ],
      { justification: "a test", modelOptions: { temperature: 0 } }
    )
    let text = ""
    for await (const fragment of response.text) text += fragment
    const parts = []
    for await (const part of response.stream) {
      parts.push({ isTextPart: part instanceof vscode.LanguageModelTextPart, value: part.value })
    }
    return { text, parts }
  })
  register("lmFixture.refused", async () => {
    const chat = await model()
    try {
      await chat.sendRequest([vscode.LanguageModelChatMessage.User("hi")])
      return "sent"
    } catch (error) {
      return failure(error)
    }
  })
  register("lmFixture.failsMidway", async () => {
    const chat = await model()
    const response = await chat.sendRequest([vscode.LanguageModelChatMessage.User("hi")])
    let text = ""
    try {
      for await (const fragment of response.text) text += fragment
      return { text }
    } catch (error) {
      return { text, error: failure(error) }
    }
  })
  register("lmFixture.cancel", async () => {
    const chat = await model()
    const source = new vscode.CancellationTokenSource()
    const response = await chat.sendRequest(
      [vscode.LanguageModelChatMessage.User("hi")],
      {},
      source.token
    )
    let text = ""
    try {
      for await (const fragment of response.text) {
        text += fragment
        source.cancel()
      }
      return { text }
    } catch (error) {
      return { text, error: failure(error) }
    }
  })
  register("lmFixture.toolParts", async () => {
    const chat = await model()
    try {
      await chat.sendRequest([
        vscode.LanguageModelChatMessage.Assistant([
          new vscode.LanguageModelToolCallPart("call-1", "search", { q: "x" }),
        ]),
      ])
      return "sent"
    } catch (error) {
      return error.message
    }
  })
  register("lmFixture.count", async () => {
    const chat = await model()
    return [
      await chat.countTokens("one two three"),
      await chat.countTokens(vscode.LanguageModelChatMessage.User("four five")),
    ]
  })
  register("lmFixture.tools", async () => {
    const registration = vscode.lm.registerTool("fixture_search", { invoke: () => undefined })
    registration.dispose()
    let invoke
    try {
      await vscode.lm.invokeTool("fixture_search", { input: {} })
    } catch (error) {
      invoke = error.message
    }
    return {
      tools: vscode.lm.tools.length,
      invoke,
      toolMode: vscode.LanguageModelChatToolMode.Required,
    }
  })
  register("lmFixture.changes", () => ({
    modelsChanged,
    accessChanged,
    canSend: access.canSendRequest({ id: "cognia/fixture" }),
  }))
}
