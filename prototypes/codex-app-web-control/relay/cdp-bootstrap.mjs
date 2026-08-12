import { stat } from "node:fs/promises"
import { basename, isAbsolute, resolve } from "node:path"

import { commandResult, sleep, waitFor } from "./shared.mjs"

const BOOTSTRAP_MARKER_PREFIX = "COGNIA_BOOTSTRAP:"
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COMPOSER_SUBMIT_PATTERN = /^(send(?: message)?|submit|run|queue|发送|提交|运行|排队)$/i

function requiredString(value, name, { maxLength = 16_000 } = {}) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`)
  if (value.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`)
  return value.trim()
}

function validBrowserUrl(value) {
  const url = new URL(requiredString(value, "browserUrl", { maxLength: 8000 }))
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("browserUrl must use http or https")
  }
  return url.toString()
}

export function buildCodexTaskDeepLink({ prompt, browserUrl, workspace, nonce }) {
  const cleanPrompt = requiredString(prompt, "prompt")
  const cleanNonce = requiredString(nonce, "nonce", { maxLength: 128 })
  if (!/^[A-Za-z0-9._-]+$/.test(cleanNonce)) {
    throw new Error("nonce contains unsupported characters")
  }
  const cleanWorkspace = resolve(requiredString(workspace, "workspace", { maxLength: 4096 }))
  if (!isAbsolute(cleanWorkspace)) throw new Error("workspace must be absolute")

  const url = new URL("codex://new")
  url.searchParams.set("path", cleanWorkspace)
  url.searchParams.set("prompt", `${cleanPrompt}\n\n[${BOOTSTRAP_MARKER_PREFIX}${cleanNonce}]`)
  url.searchParams.set("browserUrl", validBrowserUrl(browserUrl))
  return url.toString()
}

export function buildCodexThreadDeepLink(threadId) {
  const value = requiredString(threadId, "threadId", { maxLength: 64 })
  if (!THREAD_ID_PATTERN.test(value)) throw new Error("threadId is invalid")
  return `codex://threads/${value}`
}

export function isComposerSubmitLabel(value) {
  return typeof value === "string" && COMPOSER_SUBMIT_PATTERN.test(value.trim())
}

export function selectCodexRendererTarget(targets) {
  if (!Array.isArray(targets)) return null
  return (
    targets.find(
      (target) =>
        target?.type === "page" &&
        typeof target.webSocketDebuggerUrl === "string" &&
        (String(target.url ?? "").startsWith("app://") ||
          String(target.url ?? "").startsWith("codex-sandbox://"))
    ) ?? null
  )
}

export async function discoverCodexRenderer(cdpPort, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`http://127.0.0.1:${cdpPort}/json/list`, {
    signal: AbortSignal.timeout(2000),
  })
  if (!response.ok) throw new Error(`CDP target discovery failed with HTTP ${response.status}`)
  return selectCodexRendererTarget(await response.json())
}

export async function waitForCodexRenderer(cdpPort, options = {}) {
  return waitFor(() => discoverCodexRenderer(cdpPort, options).catch(() => null), {
    timeoutMs: options.timeoutMs ?? 15_000,
    intervalMs: options.intervalMs ?? 200,
    description: "Codex renderer CDP target",
  })
}

async function eventDataText(data) {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
  }
  if (typeof data?.text === "function") return data.text()
  return String(data)
}

export async function connectCdp(
  webSocketDebuggerUrl,
  { WebSocketImpl = globalThis.WebSocket, timeoutMs = 5000 } = {}
) {
  if (typeof WebSocketImpl !== "function")
    throw new Error("WebSocket is unavailable in this Node runtime")
  const socket = new WebSocketImpl(webSocketDebuggerUrl)
  const pending = new Map()
  const eventWaiters = new Map()
  let nextId = 0

  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error("Timed out connecting to CDP")), timeoutMs)
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer)
        resolveOpen()
      },
      { once: true }
    )
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer)
        rejectOpen(new Error("Unable to connect to the Codex renderer CDP target"))
      },
      { once: true }
    )
  })

  socket.addEventListener("message", async (event) => {
    let message
    try {
      message = JSON.parse(await eventDataText(event.data))
    } catch {
      return
    }
    if (message.id != null) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else entry.resolve(message.result ?? {})
      return
    }
    if (!message.method) return
    const waiters = eventWaiters.get(message.method)
    if (!waiters) return
    for (const entry of [...waiters]) {
      if (entry.predicate && !entry.predicate(message.params ?? {})) continue
      waiters.delete(entry)
      clearTimeout(entry.timer)
      entry.resolve(message.params ?? {})
    }
    if (waiters.size === 0) eventWaiters.delete(message.method)
  })

  socket.addEventListener("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error("CDP connection closed"))
    }
    pending.clear()
    for (const waiters of eventWaiters.values()) {
      for (const entry of waiters) {
        clearTimeout(entry.timer)
        entry.reject(new Error("CDP connection closed"))
      }
    }
    eventWaiters.clear()
  })

  return {
    send(method, params = {}) {
      const id = ++nextId
      return new Promise((resolveCommand, rejectCommand) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectCommand(new Error(`Timed out waiting for CDP ${method}`))
        }, timeoutMs)
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    waitForEvent(method, options = {}) {
      return new Promise((resolveEvent, rejectEvent) => {
        const waiters = eventWaiters.get(method) ?? new Set()
        const entry = {
          predicate: options.predicate,
          resolve: resolveEvent,
          reject: rejectEvent,
          timer: null,
        }
        entry.timer = setTimeout(() => {
          waiters.delete(entry)
          if (waiters.size === 0) eventWaiters.delete(method)
          rejectEvent(new Error(`Timed out waiting for CDP event ${method}`))
        }, options.timeoutMs ?? timeoutMs)
        waiters.add(entry)
        eventWaiters.set(method, waiters)
      })
    },
    close() {
      socket.close()
    },
  }
}

function checkedFilePaths(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("filePaths is required")
  if (values.length > 20) throw new Error("at most 20 files can be attached")
  return [...new Set(values)].map((value) => {
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new Error("attachment paths must be absolute")
    }
    return value
  })
}

function selectedConversationExpression(threadId) {
  return `(() => {
    const expected = ${JSON.stringify(threadId)};
    const rendered = [...new Set([...document.querySelectorAll('[data-response-annotation-conversation]')]
      .map((element) => element.getAttribute('data-response-annotation-conversation'))
      .filter(Boolean))];
    return { expected, rendered, selected: rendered.includes(expected) };
  })()`
}

function composerSubmitExpression(nonce, threadId = null) {
  const marker = `[${BOOTSTRAP_MARKER_PREFIX}${nonce}]`
  return `(() => {
    const marker = ${JSON.stringify(marker)};
    const expectedThreadId = ${JSON.stringify(threadId)};
    if (expectedThreadId) {
      const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
        .map((element) => element.getAttribute('data-response-annotation-conversation'));
      if (!rendered.includes(expectedThreadId)) {
        return { composerFound: false, promptMatched: false, submitted: false, reason: 'wrong_conversation' };
      }
    }
    const candidates = [document.activeElement, ...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
      .filter((element, index, all) => element && all.indexOf(element) === index);
    const readText = (element) => typeof element.value === 'string' ? element.value : (element.innerText || element.textContent || '');
    const composer = candidates.find((element) => readText(element).includes(marker));
    if (!composer) return { composerFound: false, promptMatched: false, submitted: false, reason: 'prompt_not_found' };
    composer.focus();
    const scope = composer.closest('[data-composer-layout]') || composer.closest('form') || document;
    const buttons = [...scope.querySelectorAll('button')];
    const submitPattern = new RegExp(${JSON.stringify(COMPOSER_SUBMIT_PATTERN.source)}, ${JSON.stringify(COMPOSER_SUBMIT_PATTERN.flags)});
    const matchingLabel = (element) => [element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText, element.textContent]
      .filter(Boolean).map((value) => value.trim()).find((value) => submitPattern.test(value));
    const submit = buttons.find((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true' && matchingLabel(element));
    if (!submit) return { composerFound: true, promptMatched: true, submitted: false, reason: 'submit_button_not_found' };
    const buttonLabel = matchingLabel(submit);
    submit.click();
    return { composerFound: true, promptMatched: true, submitted: true, method: 'button', buttonLabel };
  })()`
}

function focusComposerExpression(threadId) {
  return `(() => {
    const expectedThreadId = ${JSON.stringify(threadId)};
    const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
      .map((element) => element.getAttribute('data-response-annotation-conversation'));
    if (!rendered.includes(expectedThreadId)) return { composerFound: false, selected: false };
    const preferred = [...document.querySelectorAll('[data-codex-composer="true"]')];
    const candidates = (preferred.length ? preferred : [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')])
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !element.disabled;
      });
    const composer = candidates.at(-1);
    if (!composer) return { composerFound: false, selected: true };
    const clone = composer.cloneNode(true);
    clone.querySelectorAll('[plugin-mention-name]').forEach((element) => element.remove());
    const text = typeof composer.value === 'string' ? composer.value : (clone.textContent || '');
    if (text.trim()) return { composerFound: true, empty: false, reason: 'draft_not_empty' };
    composer.focus();
    if (composer.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return { composerFound: true, empty: true, selected: true, hasPluginMention: Boolean(composer.querySelector('[plugin-mention-name]')) };
  })()`
}

function attachmentInjectionExpression(threadId, descriptors) {
  return `(() => {
    const expectedThreadId = ${JSON.stringify(threadId)};
    if (expectedThreadId) {
      const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
        .map((element) => element.getAttribute('data-response-annotation-conversation'));
      if (!rendered.includes(expectedThreadId)) return { injected: false, reason: 'wrong_conversation' };
    }
    const files = ${JSON.stringify(descriptors)};
    for (const file of files) {
      window.postMessage({ type: 'add-context-file', file }, window.location.origin);
    }
    return { injected: true, count: files.length };
  })()`
}

function attachmentVerificationExpression(threadId, names, baselineLabels = []) {
  return `(() => {
    const expectedThreadId = ${JSON.stringify(threadId)};
    if (expectedThreadId) {
      const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
        .map((element) => element.getAttribute('data-response-annotation-conversation'));
      if (!rendered.includes(expectedThreadId)) return { ready: false, reason: 'wrong_conversation' };
    }
    const expected = ${JSON.stringify(names)};
    const baseline = ${JSON.stringify(baselineLabels)};
    const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const containers = [...document.querySelectorAll('[data-composer-attachments]')].filter(visible);
    const labels = containers.flatMap((container) => [...container.querySelectorAll('span')]
      .filter((element) => element.childElementCount === 0)
      .map((element) => element.textContent?.trim()).filter(Boolean));
    const requiredCounts = [...baseline, ...expected]
      .reduce((counts, name) => ({ ...counts, [name]: (counts[name] || 0) + 1 }), {});
    const attached = Object.entries(requiredCounts)
      .filter(([name, count]) => labels.filter((label) => label === name).length >= count)
      .map(([name]) => name);
    return { ready: attached.length === Object.keys(requiredCounts).length, expected, attached, labels };
  })()`
}

async function attachmentDescriptors(filePaths, statImpl = stat) {
  return Promise.all(
    filePaths.map(async (fsPath) => {
      const metadata = await statImpl(fsPath)
      return {
        fsPath,
        label: basename(fsPath),
        path: metadata.isDirectory() && !fsPath.endsWith("/") ? `${fsPath}/` : fsPath,
      }
    })
  )
}

export async function attachFilesToComposer(connection, filePaths, options = {}) {
  const files = checkedFilePaths(filePaths)
  const names = files.map((path) => basename(path))
  const descriptors = await attachmentDescriptors(files, options.statImpl)
  const before = await connection.send("Runtime.evaluate", {
    expression: attachmentVerificationExpression(options.threadId ?? null, []),
    returnByValue: true,
  })
  const baselineLabels = before.result?.value?.labels ?? []
  const injected = await connection.send("Runtime.evaluate", {
    expression: attachmentInjectionExpression(options.threadId ?? null, descriptors),
    returnByValue: true,
  })
  const injectionResult = injected.result?.value ?? null
  if (!injectionResult?.injected) {
    throw new Error(injectionResult?.reason ?? "Codex attachment injection failed")
  }

  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  let verification = null
  while (Date.now() < deadline) {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: attachmentVerificationExpression(options.threadId ?? null, names, baselineLabels),
      returnByValue: true,
    })
    verification = evaluated.result?.value ?? null
    if (verification?.ready) break
    await sleep(200)
  }
  if (!verification?.ready) {
    throw new Error(`Codex App did not render attachments: ${JSON.stringify(verification)}`)
  }
  return {
    files: names,
    method: "renderer-host-message",
  }
}

async function submitComposer(connection, nonce, { timeoutMs = 15_000, threadId = null } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: composerSubmitExpression(nonce, threadId),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (evaluated.exceptionDetails) throw new Error("Codex composer inspection failed")
    last = evaluated.result?.value ?? null
    if (last?.submitted) return last
    if (last?.composerFound) {
      await connection.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
      await connection.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
      return { ...last, submitted: true, method: "keyboard" }
    }
    await sleep(200)
  }
  throw new Error(last?.reason ?? "Codex composer did not become ready")
}

function openCodexDeepLink(value) {
  const opened = commandResult("/usr/bin/open", [value], { timeout: 5000 })
  if (!opened.ok) throw new Error(opened.stderr || opened.error || "Unable to open Codex deep link")
}

async function waitForSelectedConversation(connection, threadId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: selectedConversationExpression(threadId),
      returnByValue: true,
    })
    last = evaluated.result?.value ?? null
    if (last?.selected) return last
    await sleep(200)
  }
  throw new Error(
    `Codex App did not select thread ${threadId}; rendered: ${JSON.stringify(last?.rendered ?? [])}`
  )
}

export async function bootstrapCodexTask(input, dependencies = {}) {
  const deepLink = buildCodexTaskDeepLink(input)
  const cdpPort = dependencies.cdpPort ?? Number(process.env.CODEX_RELAY_CDP_PORT)
  if (dependencies.waitForRenderer == null && !Number.isSafeInteger(cdpPort)) {
    throw new Error("A valid CDP port is required")
  }
  const openDeepLink = dependencies.openDeepLink ?? openCodexDeepLink
  const waitForRenderer = dependencies.waitForRenderer ?? (() => waitForCodexRenderer(cdpPort))
  const connect = dependencies.connect ?? connectCdp

  await openDeepLink(deepLink)
  const renderer = await waitForRenderer()
  const connection = await connect(renderer.webSocketDebuggerUrl)
  try {
    await connection.send("Runtime.enable")
    const attachments = input.filePaths?.length
      ? await (dependencies.attachFiles ?? attachFilesToComposer)(connection, input.filePaths, {
          timeoutMs: dependencies.timeoutMs,
        })
      : null
    const submission = await submitComposer(connection, input.nonce)
    return {
      deepLink,
      rendererId: renderer.id,
      rendererUrl: renderer.url ?? null,
      attachments,
      submission,
    }
  } finally {
    connection.close()
  }
}

export async function submitCodexComposerPrompt(input, dependencies = {}) {
  const prompt = requiredString(input.prompt, "prompt")
  const nonce = requiredString(input.nonce, "nonce", { maxLength: 128 })
  const threadDeepLink = buildCodexThreadDeepLink(input.threadId)
  const threadId = input.threadId
  if (!/^[A-Za-z0-9._-]+$/.test(nonce)) throw new Error("nonce contains unsupported characters")
  const cdpPort = dependencies.cdpPort ?? Number(process.env.CODEX_RELAY_CDP_PORT)
  if (dependencies.waitForRenderer == null && !Number.isSafeInteger(cdpPort)) {
    throw new Error("A valid CDP port is required")
  }
  await (dependencies.openThread ?? openCodexDeepLink)(threadDeepLink)
  const renderer = await (dependencies.waitForRenderer ?? (() => waitForCodexRenderer(cdpPort)))()
  const connection = await (dependencies.connect ?? connectCdp)(renderer.webSocketDebuggerUrl)
  try {
    await connection.send("Runtime.enable")
    const selection = await waitForSelectedConversation(
      connection,
      threadId,
      dependencies.timeoutMs ?? 15_000
    )
    const deadline = Date.now() + (dependencies.timeoutMs ?? 15_000)
    let focused = null
    while (Date.now() < deadline) {
      const evaluated = await connection.send("Runtime.evaluate", {
        expression: focusComposerExpression(threadId),
        returnByValue: true,
        userGesture: true,
      })
      focused = evaluated.result?.value ?? null
      if (focused?.empty) break
      await sleep(200)
    }
    if (!focused?.empty) throw new Error("Codex composer is not ready for a follow-up")
    const attachments = input.filePaths?.length
      ? await (dependencies.attachFiles ?? attachFilesToComposer)(connection, input.filePaths, {
          threadId,
          timeoutMs: dependencies.timeoutMs,
        })
      : null
    if (attachments) {
      const refocused = await connection.send("Runtime.evaluate", {
        expression: focusComposerExpression(threadId),
        returnByValue: true,
        userGesture: true,
      })
      if (!refocused.result?.value?.empty) {
        throw new Error("Codex composer lost its safe draft state after attaching files")
      }
    }
    await connection.send("Input.insertText", {
      text: `${prompt}\n\n[${BOOTSTRAP_MARKER_PREFIX}${nonce}]`,
    })
    const submission = await submitComposer(connection, nonce, { threadId })
    return {
      threadId,
      threadDeepLink,
      selection,
      rendererId: renderer.id,
      rendererUrl: renderer.url ?? null,
      attachments,
      submission,
    }
  } finally {
    connection.close()
  }
}

async function withSelectedThread(input, dependencies, action) {
  const threadId = input.threadId
  const threadDeepLink = buildCodexThreadDeepLink(threadId)
  const cdpPort = dependencies.cdpPort ?? Number(process.env.CODEX_RELAY_CDP_PORT)
  if (dependencies.waitForRenderer == null && !Number.isSafeInteger(cdpPort)) {
    throw new Error("A valid CDP port is required")
  }
  await (dependencies.openThread ?? openCodexDeepLink)(threadDeepLink)
  const renderer = await (dependencies.waitForRenderer ?? (() => waitForCodexRenderer(cdpPort)))()
  const connection = await (dependencies.connect ?? connectCdp)(renderer.webSocketDebuggerUrl)
  try {
    await connection.send("Runtime.enable")
    const selection = await waitForSelectedConversation(
      connection,
      threadId,
      dependencies.timeoutMs ?? 15_000
    )
    const result = await action(connection, threadId)
    return {
      threadId,
      threadDeepLink,
      rendererId: renderer.id,
      rendererUrl: renderer.url ?? null,
      selection,
      ...result,
    }
  } finally {
    connection.close()
  }
}

export async function openCodexTask(input, dependencies = {}) {
  return withSelectedThread(input, dependencies, async () => ({ opened: true }))
}

export async function attachCodexTaskFiles(input, dependencies = {}) {
  return withSelectedThread(input, dependencies, async (connection, threadId) => ({
    attachments: await (dependencies.attachFiles ?? attachFilesToComposer)(
      connection,
      input.filePaths,
      { threadId, timeoutMs: dependencies.timeoutMs }
    ),
  }))
}

export async function interruptCodexTask(input, dependencies = {}) {
  return withSelectedThread(input, dependencies, async (connection, threadId) => {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: `(() => {
        const expected = ${JSON.stringify(input.threadId)};
        const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
          .map((element) => element.getAttribute('data-response-annotation-conversation'));
        if (!rendered.includes(expected)) return { interrupted: false, reason: 'wrong_conversation' };
        const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
        const candidates = [...document.querySelectorAll('button[aria-label="Stop"]')].filter(visible);
        if (candidates.length !== 1) return { interrupted: false, reason: candidates.length ? 'ambiguous_stop' : 'not_running' };
        candidates[0].click();
        return { interrupted: true };
      })()`,
      returnByValue: true,
      userGesture: true,
    })
    const interruption = evaluated.result?.value ?? null
    if (!interruption?.interrupted && interruption?.reason !== "not_running") {
      throw new Error(interruption?.reason ?? "unable to interrupt task")
    }
    return { threadId, interruption }
  })
}

function composerContextExpression(threadId, actionLabel = null) {
  return `(async () => {
    const expected = ${JSON.stringify(threadId)};
    const action = ${JSON.stringify(actionLabel)};
    const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
      .map((element) => element.getAttribute('data-response-annotation-conversation'));
    if (!rendered.includes(expected)) return { ready: false, reason: 'wrong_conversation' };
    const visible = (element) => { const rect = element?.getBoundingClientRect(); return Boolean(rect?.width && rect?.height); };
    const exactLeaf = (text) => [...document.querySelectorAll('span,div')]
      .find((element) => element.childElementCount === 0 && element.textContent?.trim() === text && visible(element));
    let filesButton = exactLeaf('Files and folders')?.closest('button');
    const composer = [...document.querySelectorAll('[data-codex-composer="true"]')].filter(visible).at(-1);
    const scope = composer?.closest('[data-composer-layout]') || composer?.closest('form') || document;
    const addButton = [...scope.querySelectorAll('button')]
      .find((element) => element.getAttribute('data-composer-navigation-target') === 'add-context' && visible(element));
    if (!filesButton && addButton) {
      addButton.click();
      for (let index = 0; index < 30 && !filesButton; index += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        filesButton = exactLeaf('Files and folders')?.closest('button');
      }
    }
    if (!filesButton) return { ready: false, reason: 'context_menu_not_found' };
    const menu = filesButton.parentElement?.parentElement;
    if (!menu) return { ready: false, reason: 'context_menu_not_found' };
    const items = [...menu.querySelectorAll('button')].filter(visible).map((button) => {
      const lines = (button.innerText || button.textContent || '').split('\\n').map((value) => value.trim()).filter(Boolean);
      return { label: lines[0] || '', description: lines.slice(1).join(' ') || null };
    }).filter((item) => item.label);
    if (action) {
      if (action === 'Files and folders') return { ready: false, reason: 'use_attachment_command' };
      const leaf = exactLeaf(action);
      const button = leaf?.closest('button');
      if (!button || !menu.contains(button)) return { ready: false, reason: 'context_not_found', items };
      button.click();
      return { ready: true, invoked: action, items };
    }
    addButton?.click();
    return { ready: true, items };
  })()`
}

export async function listCodexComposerContexts(input, dependencies = {}) {
  return withSelectedThread(input, dependencies, async (connection, threadId) => {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: composerContextExpression(threadId),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    const contexts = evaluated.result?.value ?? null
    if (!contexts?.ready) throw new Error(contexts?.reason ?? "unable to list composer contexts")
    return { contexts: contexts.items }
  })
}

export async function invokeCodexComposerContext(input, dependencies = {}) {
  const label = requiredString(input.label, "label", { maxLength: 160 })
  return withSelectedThread(input, dependencies, async (connection, threadId) => {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: composerContextExpression(threadId, label),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    const context = evaluated.result?.value ?? null
    if (!context?.ready) throw new Error(context?.reason ?? "unable to invoke composer context")
    return { context: { invoked: context.invoked, available: context.items } }
  })
}
