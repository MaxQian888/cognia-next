import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

import {
  isRendererRestartError,
  loadEndpoint,
  parseEndpoint,
  reconcileDebugSession,
  request,
} from "./agent-debug.mjs"

const sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("operation aborted"))
    const timer = setTimeout(done, milliseconds)
    signal?.addEventListener("abort", aborted, { once: true })
    function done() {
      signal?.removeEventListener("abort", aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      reject(signal.reason || new Error("operation aborted"))
    }
  })
const cleanRegex = (value) => new RegExp(value.source, value.flags.replace(/[gy]/g, ""))
const remaining = (options, fallback) =>
  options._deadline === undefined
    ? (options.timeout ?? fallback)
    : Math.max(0, options._deadline - performance.now())
const budget = (options, fallback) => {
  const timeout = options.timeout ?? fallback
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 120_000)
    throw new TypeError("timeout must be between 0 and 120000 milliseconds")
  return { ...options, _deadline: options._deadline ?? performance.now() + Math.max(1, timeout) }
}
const preDispatchErrors = new Set([
  "not_found",
  "not_attached",
  "not_visible",
  "not_enabled",
  "not_editable",
  "not_stable",
  "not_receives_events",
  "source_changed",
  "target_changed",
  "target_not_found",
  "target_not_attached",
  "target_not_visible",
  "target_not_enabled",
  "target_not_stable",
  "target_not_receives_events",
])

function expressionFor(pageFunction, arg) {
  if (typeof pageFunction === "function")
    return `(${pageFunction.toString()})(${JSON.stringify(arg)})`
  if (typeof pageFunction !== "string")
    throw new TypeError("evaluate expects a function or JavaScript expression string")
  if (arg !== undefined) throw new TypeError("an evaluate argument requires a function")
  return pageFunction
}

function serializeMatcher(value) {
  return value instanceof RegExp ? { regex: value.source, flags: value.flags } : value
}

function needsScopedQuery(query) {
  if (!query) return false
  return (
    query.kind === "chain" ||
    (query.kind === "filtered" && query.index != null) ||
    [query.query, query.left, query.right, query.root].some(needsScopedQuery) ||
    (query.filters || []).some((filter) => needsScopedQuery(filter.query))
  )
}

function matches(actual, expected, exact = false) {
  if (expected instanceof RegExp) return cleanRegex(expected).test(String(actual ?? ""))
  const left = String(actual ?? "")
    .replace(/\s+/g, " ")
    .trim()
  const right = String(expected ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return exact ? left === right : left.toLocaleLowerCase().includes(right.toLocaleLowerCase())
}

export class TauriDebugUnsupportedError extends Error {
  constructor(feature, detail) {
    super(
      `${feature} is unavailable in the cross-platform Tauri webview bridge${detail ? `: ${detail}` : ""}`
    )
    this.name = "TauriDebugUnsupportedError"
    this.feature = feature
  }
}

export class TauriDebugLocatorError extends Error {
  constructor(code, message, retryable = false, dispatchState) {
    super(message)
    this.name = "TauriDebugLocatorError"
    this.code = code
    this.retryable = retryable
    this.dispatchState = dispatchState
  }
}

export class TauriDebugTimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = "TauriDebugTimeoutError"
  }
}

/**
 * The webview's web content process was replaced (WKWebView renderer killed or
 * crashed, then reloaded) while a command was pending. The page reloaded, so
 * element refs and in-page state are gone. Persisted or external effects may
 * survive. Recover the renderer, then inspect the outcome before any retry.
 */
export class TauriDebugRendererRestartedError extends Error {
  constructor(
    message,
    { window, rendererGeneration, code = "webview_renderer_restarted", cause } = {}
  ) {
    super(message, cause ? { cause } : undefined)
    this.name = "TauriDebugRendererRestartedError"
    this.code = code
    this.window = window
    this.rendererGeneration = rendererGeneration
    this.retryable = false
    this.dispatchState = "unknown"
  }
}

export class TauriDebugDocumentReplacedError extends Error {
  constructor(message, { code = "webview_document_replaced", window, documentEpoch, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = "TauriDebugDocumentReplacedError"
    this.code = code
    this.window = window
    this.documentEpoch = documentEpoch
    this.retryable = false
    this.dispatchState = "unknown"
  }
}

export class TauriDebugSessionError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = "TauriDebugSessionError"
    this.code = code
    this.retryable = false
    this.dispatchState = "unknown"
  }
}

const documentError = (error) =>
  ["webview_document_replaced", "webview_document_loading"].includes(error?.code)
const connectionError = (error) =>
  error instanceof TypeError ||
  ["ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(
    error?.code || error?.cause?.code
  )

export class TauriLocator {
  constructor(page, query, index = null, predicates = []) {
    this.page = page
    this.query = query
    this.index = index
    this.predicates = predicates
  }

  _clone({ query = this.query, index = this.index, predicates = this.predicates } = {}) {
    return new TauriLocator(this.page, query, index, predicates)
  }

  _append(step) {
    const query =
      this.query.steps && this.index === null && this.predicates.length === 0
        ? { steps: [...this.query.steps, step] }
        : { kind: "chain", root: this._selectionQuery(), step }
    return this._clone({ query, index: null, predicates: [] })
  }

  _selectionQuery() {
    if (this.index === null && this.predicates.length === 0) return this.query
    return {
      kind: "filtered",
      query: this.query,
      filters: this.predicates,
      ...(this.index === null ? {} : { index: this.index }),
    }
  }

  first() {
    return this.nth(0)
  }

  last() {
    return this.nth(-1)
  }

  nth(index) {
    if (!Number.isSafeInteger(index)) throw new TypeError("nth index must be an integer")
    if (this.index !== null)
      return this._clone({ query: this._selectionQuery(), index, predicates: [] })
    return this._clone({ index })
  }

  filter(options = {}) {
    if (this.index !== null)
      return this._clone({ query: this._selectionQuery(), index: null, predicates: [] }).filter(
        options
      )
    const predicates = [...this.predicates]
    if (options.hasText !== undefined)
      predicates.push({ kind: "hasText", value: serializeMatcher(options.hasText) })
    if (options.hasNotText !== undefined)
      predicates.push({ kind: "hasNotText", value: serializeMatcher(options.hasNotText) })
    for (const [key, kind] of [
      ["has", "has"],
      ["hasNot", "hasNot"],
    ]) {
      if (options[key] === undefined) continue
      const locator = options[key]
      if (!(locator instanceof TauriLocator) || locator.page !== this.page)
        throw new TypeError(`filter({ ${key} }) requires a locator from the same TauriPage`)
      predicates.push({
        kind,
        query: locator._selectionQuery(),
      })
    }
    if (options.visible !== undefined)
      predicates.push({ kind: "visible", value: Boolean(options.visible) })
    return this._clone({ predicates })
  }

  and(locator) {
    if (!(locator instanceof TauriLocator) || locator.page !== this.page)
      throw new TypeError("locator.and() requires a locator from the same TauriPage")
    return this._clone({
      query: {
        kind: "and",
        left: this._selectionQuery(),
        right: locator._selectionQuery(),
      },
      index: null,
      predicates: [],
    })
  }
  or(locator) {
    if (!(locator instanceof TauriLocator) || locator.page !== this.page)
      throw new TypeError("locator.or() requires a locator from the same TauriPage")
    return this._clone({
      query: {
        kind: "or",
        left: this._selectionQuery(),
        right: locator._selectionQuery(),
      },
      index: null,
      predicates: [],
    })
  }
  locator(selector) {
    return this._append({ kind: "css", selector })
  }
  getByTestId(testId) {
    return this.locator(`[data-testid=${JSON.stringify(String(testId))}]`)
  }
  getByPlaceholder(text, options = {}) {
    return this._append({
      kind: "attribute",
      name: "placeholder",
      value: serializeMatcher(text),
      exact: options.exact === true,
    })
  }
  getByAltText(text, options = {}) {
    return this._append({
      kind: "attribute",
      name: "alt",
      value: serializeMatcher(text),
      exact: options.exact === true,
    })
  }
  getByTitle(text, options = {}) {
    return this._append({
      kind: "attribute",
      name: "title",
      value: serializeMatcher(text),
      exact: options.exact === true,
    })
  }
  getByLabel(text, options = {}) {
    return this._append({
      kind: "label",
      text: serializeMatcher(text),
      exact: options.exact === true,
    })
  }
  getByText(text, options = {}) {
    const locator = this._append({
      kind: "text",
      text: serializeMatcher(text),
      exact: options.exact === true,
    })
    return locator
  }
  getByRole(role, options = {}) {
    const { name, exact, ...state } = options
    const locator = this._append({
      kind: "role",
      role,
      ...state,
      ...(name === undefined ? {} : { name: serializeMatcher(name), exact: exact === true }),
    })
    return locator
  }

  async _nodes({ includeHidden = true, strict = false, ...options } = {}) {
    await this.page._ensureLocatorQuery(this.query, this.predicates, options)
    const payload = await this.page._post(
      "/api/dev/agent/locator",
      {
        window: this.page.windowLabel,
        query: this.query,
        index: this.index,
        filters: this.predicates,
        operation: "query",
        strict,
        args: { includeHidden },
        options: { timeout: Math.max(1, Math.ceil(remaining(options, this.page.defaultTimeout))) },
      },
      options
    )
    if (!payload.locator?.ok)
      throw new TauriDebugLocatorError(
        payload.locator?.code || "locator_failed",
        payload.locator?.error || "locator query failed",
        payload.locator?.retryable === true
      )
    if (
      payload.locator.truncated ||
      (payload.locator.nodes?.length === 500 && payload.locator.count === undefined)
    )
      throw new TauriDebugUnsupportedError(
        "complete locator node query",
        "narrow the locator or use count/allTextContents/allInnerTexts for a complete collection"
      )
    if (strict && payload.locator.nodes.length > 1)
      throw new TauriDebugLocatorError(
        "strict_mode_violation",
        "strict locator resolved to multiple elements"
      )
    return payload.locator.nodes
  }

  async _resolve({
    strict = true,
    timeout = this.page.defaultTimeout,
    visible = false,
    enabled = false,
    editable = false,
  } = {}) {
    const deadline = Date.now() + timeout
    let lastNodes = []
    do {
      const allNodes = await this._nodes({ includeHidden: true })
      if (strict && this.index === null && allNodes.length > 1) {
        throw new Error(
          `strict locator resolved to ${allNodes.length} elements: ${JSON.stringify(this.query)}`
        )
      }
      lastNodes = allNodes
      const node = lastNodes[0]
      if (
        node &&
        (!visible || node.visible) &&
        (!enabled || !node.disabled) &&
        (!editable || node.editable)
      )
        return node
      if (Date.now() >= deadline) break
      await sleep(100)
    } while (true)
    throw new TauriDebugTimeoutError(
      `locator timed out after ${timeout}ms: ${JSON.stringify(this.query)}; last count: ${lastNodes.length}`
    )
  }

  async _atomic(operation, name, args = {}, options = {}, requirements = {}) {
    if (options.signal?.aborted) throw options.signal.reason || new Error("operation aborted")
    await this.page._ensureLocatorQuery(this.query, this.predicates, options)
    if (operation === "action")
      await this.page._requireCapability(
        "locatorActionControl",
        1,
        "cancellable locator actions",
        options
      )
    if (name === "dragTo") await this.page._ensureLocatorQuery(args.targetQuery, [], options)
    if (operation === "action" && name === "dispatchEvent")
      await this.page._requireCapability(
        "dispatchEventInit",
        true,
        "DOM event initialization",
        options
      )
    if (options.signal?.aborted) throw options.signal.reason || new Error("operation aborted")
    const requestId = randomUUID()
    let requestEndpoint
    let cancellationSent = false
    const cancel = () => {
      if (cancellationSent || operation !== "action" || !requestEndpoint) return
      cancellationSent = true
      // Cancellation delivery is best effort; it cannot undo an already dispatched event.
      void this.page
        ._transport("/api/dev/agent/locator", {
          method: "POST",
          body: { window: this.page.windowLabel, query: {}, operation: "cancel", requestId },
          timeout: 1_000,
          endpoint: requestEndpoint,
        })
        .catch(() => {})
    }
    let payload
    try {
      options.signal?.addEventListener("abort", cancel, { once: true })
      if (options.signal?.aborted) throw options.signal.reason || new Error("operation aborted")
      payload = await this.page._post(
        "/api/dev/agent/locator",
        {
          window: this.page.windowLabel,
          query: this.query,
          index: this.index,
          filters: this.predicates,
          operation,
          name,
          args,
          requestId,
          expiresAt: Date.now() + Math.ceil(remaining(options, this.page.defaultTimeout)),
          options: {
            force: options.force === true,
            trial: options.trial === true,
            scroll: options.scroll || "auto",
            timeout: Math.max(1, Math.ceil(remaining(options, this.page.defaultTimeout))),
          },
          requirements,
          strict: true,
        },
        {
          ...options,
          _onEndpoint: (endpoint) => {
            requestEndpoint = endpoint
          },
        }
      )
    } catch (error) {
      if (operation === "action") {
        cancel()
        if (error && typeof error === "object") error.dispatchState ??= "unknown"
      }
      throw error
    } finally {
      options.signal?.removeEventListener("abort", cancel)
    }
    const result = payload.locator
    if (!result?.ok && documentError(result))
      throw new TauriDebugDocumentReplacedError(result.error, {
        code: result.code,
        window: this.page.windowLabel,
      })
    if (!result?.ok && result?.code === "unsupported_event_class")
      throw new TauriDebugUnsupportedError("DOM event class", result.error)
    if (!result?.ok)
      throw new TauriDebugLocatorError(
        result?.code || "locator_failed",
        result?.error || "locator operation failed",
        result?.retryable === true,
        result?.dispatchState
      )
    try {
      if (operation === "action" && options.waitForURL !== undefined && !options.trial) {
        await this.page.waitForURL(options.waitForURL, options)
      } else if (operation === "action" && result.navigation && options.trial !== true) {
        await this.page.waitForLoadState(options.waitUntil || "load", {
          ...options,
          previousDocumentId: result.previousDocumentId,
          previousUrl: result.previousUrl,
          requireNavigation: true,
        })
      }
    } catch (error) {
      if (error && typeof error === "object") error.dispatchState = "dispatched"
      throw error
    }
    return result.value
  }

  async _act(action, args = {}, options = {}, requirements = {}) {
    options = budget(options, this.page.defaultTimeout)
    const timeout = options.timeout ?? this.page.defaultTimeout
    let lastError
    do {
      try {
        return await this._atomic("action", action, args, options, requirements)
      } catch (error) {
        lastError = error
        if (
          !(error instanceof TauriDebugLocatorError) ||
          !error.retryable ||
          error.dispatchState !== "not-dispatched" ||
          !preDispatchErrors.has(error.code)
        )
          throw error
        if (remaining(options, timeout) <= 0)
          throw new TauriDebugTimeoutError(
            `locator action ${action} timed out after ${timeout}ms: ${error.message}`
          )
        await sleep(Math.min(50, remaining(options, timeout)), options.signal)
      }
    } while (remaining(options, timeout) > 0)
    throw new TauriDebugTimeoutError(
      `locator action ${action} timed out after ${timeout}ms: ${lastError?.message}`
    )
  }

  async _inspect(operation, args = {}, options = {}) {
    options = budget(options, this.page.defaultTimeout)
    const timeout = options.timeout ?? this.page.defaultTimeout
    let lastError
    do {
      try {
        return await this._atomic("inspect", operation, args, options)
      } catch (error) {
        lastError = error
        if (
          !(error instanceof TauriDebugLocatorError) ||
          !error.retryable ||
          error.dispatchState !== "not-dispatched" ||
          !preDispatchErrors.has(error.code)
        )
          throw error
        if (remaining(options, timeout) <= 0)
          throw new TauriDebugTimeoutError(
            `locator inspection ${operation} timed out after ${timeout}ms: ${error.message}`
          )
        await sleep(Math.min(50, remaining(options, timeout)), options.signal)
      }
    } while (remaining(options, timeout) > 0)
    throw new TauriDebugTimeoutError(
      `locator inspection ${operation} timed out after ${timeout}ms: ${lastError?.message}`
    )
  }

  click(options) {
    return this._act("click", {}, options, {
      visible: true,
      stable: true,
      receivesEvents: true,
      enabled: true,
    })
  }
  tap(options) {
    return this.click(options)
  }
  dblclick(options) {
    return this._act("dblclick", {}, options, {
      visible: true,
      stable: true,
      receivesEvents: true,
      enabled: true,
    })
  }
  focus(options) {
    return this._act("focus", {}, options, { visible: true })
  }
  blur(options) {
    return this._act("blur", {}, options)
  }
  hover(options) {
    return this._act("hover", {}, options, { visible: true })
  }
  fill(value, options) {
    return this._act("fill", { value }, options, { visible: true, enabled: true, editable: true })
  }
  clear(options) {
    return this.fill("", options)
  }
  press(key, options) {
    return this._act("press", { key }, options, { visible: true, enabled: true })
  }
  check(options) {
    return this._act("check", {}, options, { visible: true, enabled: true })
  }
  uncheck(options) {
    return this._act("uncheck", {}, options, { visible: true, enabled: true })
  }
  scrollIntoViewIfNeeded(options) {
    return this._act("scrollIntoView", {}, options)
  }
  dispatchEvent(type, eventInit, options) {
    return this._act("dispatchEvent", { type, eventInit }, options)
  }

  async selectOption(values, options) {
    const list = Array.isArray(values) ? values : [values]
    const normalized = list
      .map((value) => (typeof value === "string" ? value : (value?.value ?? value?.label)))
      .filter((value) => value !== undefined)
    return this._act("select", { values: normalized }, options, { visible: true, enabled: true })
  }

  async type(text, options = {}) {
    return this.pressSequentially(text, options)
  }

  async pressSequentially(text, options = {}) {
    options = budget(options, this.page.defaultTimeout)
    if (!options.delay)
      return this._act("type", { value: String(text) }, options, {
        visible: true,
        enabled: true,
        editable: true,
      })
    for (const character of String(text)) {
      await this._act("type", { value: character }, options, {
        visible: true,
        enabled: true,
        editable: true,
      })
      await sleep(
        Math.min(options.delay, remaining(options, this.page.defaultTimeout)),
        options.signal
      )
    }
  }

  async dragTo(target, options = {}) {
    if (!(target instanceof TauriLocator) || target.page !== this.page)
      throw new TypeError("dragTo target must be a locator from the same TauriPage")
    return this._act("dragTo", { targetQuery: target._selectionQuery() }, options, {
      visible: true,
      enabled: true,
      stable: true,
      receivesEvents: true,
    })
  }

  async setInputFiles(files, options = {}) {
    const entries = Array.isArray(files) ? files : [files]
    const payload = entries.map((entry) => {
      if (typeof entry === "string") {
        const absolute = path.resolve(entry)
        return {
          name: path.basename(absolute),
          mimeType: "application/octet-stream",
          base64: fs.readFileSync(absolute).toString("base64"),
        }
      }
      if (!entry || !entry.name || entry.buffer === undefined)
        throw new TypeError("file payload requires name and buffer")
      return {
        name: entry.name,
        mimeType: entry.mimeType || "application/octet-stream",
        base64: Buffer.from(entry.buffer).toString("base64"),
      }
    })
    return this._act("setInputFiles", { files: payload }, options, { enabled: true })
  }

  async count() {
    return this._collection("count")
  }
  async all() {
    if (this.index !== null) return (await this.count()) === 0 ? [] : [this]
    return Array.from({ length: await this.count() }, (_, index) => this.nth(index))
  }
  async allTextContents() {
    return this._collection("allTextContents")
  }
  async allInnerTexts() {
    return this._collection("allInnerTexts")
  }

  async _collection(name) {
    await this.page._ensureLocatorQuery(this.query, this.predicates)
    const payload = await this.page._post("/api/dev/agent/locator", {
      window: this.page.windowLabel,
      query: this.query,
      index: this.index,
      filters: this.predicates,
      operation: "query",
      strict: false,
      args: { collection: name },
    })
    const result = payload.locator
    if (!result?.ok)
      throw new TauriDebugLocatorError(
        result?.code || "locator_failed",
        result?.error || "locator collection query failed",
        result?.retryable === true
      )
    if (name === "count" && Number.isSafeInteger(result.value) && result.value >= 0)
      return result.value
    if (
      name !== "count" &&
      Array.isArray(result.value) &&
      result.value.every((entry) => typeof entry === "string")
    )
      return result.value
    if (
      name === "count" &&
      Array.isArray(result.nodes) &&
      result.nodes.length < 500 &&
      !result.truncated
    )
      return result.nodes.length
    throw new TauriDebugUnsupportedError(
      "complete locator collections",
      "restart the agent-debug shell with a helper that supports locatorCollectionQueries"
    )
  }
  textContent(options) {
    return this._inspect("textContent", {}, options)
  }
  innerText(options) {
    return this._inspect("innerText", {}, options)
  }
  innerHTML(options) {
    return this._inspect("innerHTML", {}, options)
  }
  inputValue(options) {
    return this._inspect("inputValue", {}, options)
  }
  getAttribute(name, options) {
    return this._inspect("getAttribute", { name }, options)
  }
  boundingBox(options) {
    return this._inspect("boundingBox", {}, options)
  }
  getComputedStyle(property, options) {
    return this._inspect("getComputedStyle", { property }, options)
  }

  evaluate(pageFunction, arg, options) {
    if (typeof pageFunction !== "function")
      throw new TypeError("locator.evaluate expects a function")
    return this._inspect("evaluate", { functionSource: pageFunction.toString(), arg }, options)
  }

  async waitForFunction(pageFunction, arg, options = {}) {
    if (typeof pageFunction !== "function")
      throw new TypeError("locator.waitForFunction expects a function")
    options = budget(options, this.page.defaultTimeout)
    const timeout = options.timeout ?? this.page.defaultTimeout
    let lastValue
    do {
      if (options.signal?.aborted)
        throw options.signal.reason || new Error("locator.waitForFunction aborted")
      lastValue = await this.evaluate(pageFunction, arg, options)
      if (lastValue) return lastValue
      if (remaining(options, timeout) <= 0) break
      await sleep(
        Math.min(
          typeof options.polling === "number" ? options.polling : 100,
          remaining(options, timeout)
        ),
        options.signal
      )
    } while (true)
    throw new TauriDebugTimeoutError(
      `locator.waitForFunction timed out after ${timeout}ms; last value: ${JSON.stringify(lastValue)}`
    )
  }

  ariaSnapshot(options = {}) {
    return this._inspect("ariaSnapshot", { options }, options)
  }

  async isVisible() {
    return Boolean((await this._nodes({ strict: true }))[0]?.visible)
  }
  async isHidden() {
    return !(await this.isVisible())
  }
  async isEnabled() {
    return !(await this.isDisabled())
  }
  async isDisabled() {
    return Boolean((await this._resolve({ timeout: 0 })).disabled)
  }
  async isEditable() {
    return Boolean((await this._resolve({ timeout: 0 })).editable)
  }
  async isChecked() {
    return Boolean((await this._resolve({ timeout: 0 })).checked)
  }
  async isFocused() {
    return Boolean((await this._resolve({ timeout: 0 })).focused)
  }

  async waitFor(options = {}) {
    if (typeof options === "number") options = { timeout: options }
    const state = options.state || "visible"
    if (!["attached", "detached", "visible", "hidden"].includes(state))
      throw new TypeError(`unsupported locator state: ${state}`)
    options = budget(options, this.page.defaultTimeout)
    const timeout = options.timeout ?? this.page.defaultTimeout
    let lastCount = 0
    do {
      const nodes = await this._nodes({ ...options, includeHidden: true, strict: true })
      lastCount = nodes.length
      const attached = lastCount > 0
      const visible = nodes.some((node) => node.visible)
      if (
        (state === "attached" && attached) ||
        (state === "visible" && visible) ||
        (state === "detached" && !attached) ||
        (state === "hidden" && !visible)
      )
        return
      if (remaining(options, timeout) <= 0) break
      await sleep(Math.min(100, remaining(options, timeout)), options.signal)
    } while (true)
    throw new TauriDebugTimeoutError(
      `locator.waitFor(${state}) timed out after ${timeout}ms; last count: ${lastCount}`
    )
  }
}

class TauriKeyboard {
  constructor(page) {
    this.page = page
  }
  _call(operation, args = {}) {
    return this.page._helperCall("keyboard", operation, args)
  }
  async press(key, options = {}) {
    const parts = String(key).split("+")
    const main = parts.pop()
    for (const modifier of parts) await this.down(modifier)
    await this._call("press", { key: main })
    for (const modifier of parts.reverse()) await this.up(modifier)
    if (options.delay) await sleep(options.delay)
  }
  down(key) {
    return this._call("down", { key })
  }
  up(key) {
    return this._call("up", { key })
  }
  async type(text, options = {}) {
    if (!options.delay) return this._call("type", { text })
    for (const character of String(text)) {
      await this._call("type", { text: character })
      await sleep(options.delay)
    }
  }
  insertText(text) {
    return this._call("insertText", { text })
  }
}

class TauriMouse {
  constructor(page) {
    this.page = page
  }
  _call(operation, args = {}) {
    return this.page._helperCall("mouse", operation, args)
  }
  click(x, y, options = {}) {
    return this._call(options.clickCount === 2 ? "dblclick" : "click", {
      x,
      y,
      button: options.button,
    })
  }
  dblclick(x, y, options = {}) {
    return this._call("dblclick", { x, y, button: options.button })
  }
  move(x, y, options = {}) {
    return this._call("move", { x, y, steps: options.steps })
  }
  down(options = {}) {
    return this._call("down", options)
  }
  up(options = {}) {
    return this._call("up", options)
  }
  wheel(deltaX, deltaY) {
    return this._call("wheel", { deltaX, deltaY })
  }
}

export class TauriPage {
  constructor({
    endpoint = loadEndpoint(),
    window = "main",
    fetchImpl = fetch,
    defaultTimeout = 10_000,
    endpointLoader,
  } = {}) {
    this.endpoint = endpoint
    this.windowLabel = window
    this.fetchImpl = fetchImpl
    this.defaultTimeout = defaultTimeout
    this._endpointLoader =
      endpointLoader || (endpoint.file ? () => loadEndpoint(endpoint.file) : null)
    this._debugSession =
      endpoint.debugSession?.sessionId && endpoint.debugSession?.workspace
        ? { sessionId: endpoint.debugSession.sessionId, workspace: endpoint.debugSession.workspace }
        : null
    this._connectionLost = false
    this._consoleCursor = 0
    this._networkCursor = 0
    this._consoleDocumentId = null
    this._networkDocumentId = null
    // Last renderer generation observed for this window (null until a health
    // probe or restart error reports one).
    this._rendererGeneration = null
    this.keyboard = new TauriKeyboard(this)
    this.mouse = new TauriMouse(this)
  }

  _transport(route, options = {}) {
    return request(route, {
      ...options,
      endpoint: options.endpoint || this.endpoint,
      fetchImpl: this.fetchImpl,
    })
  }

  async _refreshConnection(options) {
    if (!this._endpointLoader || !this._debugSession) return
    if (this._connectionLost) return this.reconnect(options)
    let candidate
    try {
      candidate = this._endpointLoader()
    } catch {
      return
    }
    if (
      candidate.baseUrl !== this.endpoint.baseUrl ||
      candidate.devToken !== this.endpoint.devToken ||
      candidate.debugSession?.appInstanceId !== this.endpoint.debugSession?.appInstanceId ||
      candidate.debugSession?.sessionId !== this._debugSession.sessionId ||
      candidate.debugSession?.workspace !== this._debugSession.workspace
    )
      await this.reconnect(options)
  }

  async reconnect(options = {}) {
    if (!this._endpointLoader || !this._debugSession)
      throw new TauriDebugUnsupportedError(
        "managed app reconnection",
        "launch a managed debug session or supply an endpoint loader and session identity"
      )
    options = budget(options, this.defaultTimeout)
    let lastError
    do {
      if (options.signal?.aborted) throw options.signal.reason || new Error("reconnection aborted")
      if (remaining(options, this.defaultTimeout) <= 0) break
      try {
        const candidate = parseEndpoint(JSON.stringify(this._endpointLoader()))
        if (!candidate)
          throw new TauriDebugSessionError(
            "debug_endpoint_invalid",
            "managed discovery must contain a loopback endpoint and credential"
          )
        if (
          candidate.debugSession?.sessionId !== this._debugSession.sessionId ||
          candidate.debugSession?.workspace !== this._debugSession.workspace
        )
          throw new TauriDebugSessionError(
            "debug_session_mismatch",
            "refusing to reconnect to another debug session or workspace"
          )
        const health = await this._transport("/api/dev/agent/health", {
          endpoint: candidate,
          signal: options.signal,
          timeout: remaining(options, this.defaultTimeout),
        })
        try {
          reconcileDebugSession(this._debugSession, health, candidate)
        } catch (error) {
          throw new TauriDebugSessionError("debug_session_mismatch", error.message, error)
        }
        if (health.helper?.version !== undefined && health.helper.version !== 3)
          throw new TauriDebugUnsupportedError(
            "managed app reconnection",
            "the replacement app has an incompatible helper"
          )
        if (
          health.helper?.version === 3 &&
          ["interactive", "complete"].includes(health.helper.readyState) &&
          !health.renderers?.main?.documentLoading &&
          !health.renderers?.main?.awaitingLoad
        ) {
          const latest = this._endpointLoader()
          if (
            latest.baseUrl !== candidate.baseUrl ||
            latest.devToken !== candidate.devToken ||
            latest.debugSession?.appInstanceId !== candidate.debugSession.appInstanceId ||
            latest.debugSession?.sessionId !== this._debugSession.sessionId ||
            latest.debugSession?.workspace !== this._debugSession.workspace
          )
            continue
          if (options.signal?.aborted)
            throw options.signal.reason || new Error("reconnection aborted")
          if (remaining(options, this.defaultTimeout) <= 0) break
          if (candidate.debugSession.appInstanceId !== this.endpoint.debugSession?.appInstanceId) {
            this._consoleCursor = this._networkCursor = 0
            this._consoleDocumentId = this._networkDocumentId = null
            this._rendererGeneration = null
          }
          this.endpoint = candidate
          this._connectionLost = false
          return this._noteRenderer(health)
        }
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason || error
        if (error.status === 401 || error.status === 403)
          throw new TauriDebugSessionError(
            "debug_session_authentication_failed",
            "replacement app authentication failed",
            error
          )
        if (error instanceof TauriDebugSessionError || error instanceof TauriDebugUnsupportedError)
          throw error
        lastError = error
      }
      await sleep(Math.min(100, remaining(options, this.defaultTimeout)), options.signal)
    } while (remaining(options, this.defaultTimeout) > 0)
    throw new TauriDebugTimeoutError(
      `managed app reconnection timed out${lastError ? `: ${lastError.message}` : ""}`
    )
  }

  async _request(route, options = {}) {
    if (this._endpointLoader && this._debugSession) options = budget(options, this.defaultTimeout)
    if (options.signal?.aborted) throw options.signal.reason || new Error("operation aborted")
    await this._refreshConnection(options)
    const timeout =
      options._deadline === undefined ? options.timeout : remaining(options, this.defaultTimeout)
    if (timeout !== undefined && timeout <= 0)
      throw new TauriDebugTimeoutError(`operation deadline exceeded before ${route}`)
    try {
      const endpoint = this.endpoint
      options._onEndpoint?.(endpoint)
      const body =
        options._deadline !== undefined && route === "/api/dev/agent/evaluate"
          ? { ...options.body, timeout: Math.max(1, Math.ceil(timeout)) }
          : options.body
      const payload = await this._transport(route, { ...options, body, timeout, endpoint })
      if (endpoint.debugSession?.appInstanceId !== this.endpoint.debugSession?.appInstanceId)
        throw new TauriDebugSessionError(
          "debug_app_restarted",
          "the app instance changed while the command was pending; inspect its outcome before retrying"
        )
      if (options.signal?.aborted) throw options.signal.reason || new Error("operation aborted")
      if (options._deadline !== undefined && remaining(options, this.defaultTimeout) <= 0)
        throw new TauriDebugTimeoutError(
          `operation deadline exceeded while waiting for ${route}; effects may have occurred`
        )
      return payload
    } catch (error) {
      if (connectionError(error) && !options.signal?.aborted && this._debugSession) {
        this._connectionLost = true
        throw new TauriDebugSessionError(
          "debug_connection_lost",
          "the managed app connection was interrupted; reconnect or explicitly attach again, and inspect the pending operation's outcome",
          error
        )
      }
      if (error?.name === "TimeoutError" && !options.signal?.aborted)
        throw new TauriDebugTimeoutError(
          `operation timed out while waiting for ${route}; effects may have occurred`
        )
      if (options._explainErrors === false) throw error
      if (options._deadline !== undefined || options.signal?.aborted) {
        // Error enrichment must not start another transport after the caller's deadline.
        if (!isRendererRestartError(error) && !documentError(error)) throw error
      }
      throw await this._explainBridgeError(error)
    }
  }
  /**
   * Turn renderer-replacement failures into `TauriDebugRendererRestartedError`.
   * The bridge reports a termination it observed while a command was pending;
   * an evaluation timeout is additionally checked against the renderer state,
   * because the termination can land just after the bridge gave up waiting.
   */
  async _explainBridgeError(error) {
    if (documentError(error))
      return new TauriDebugDocumentReplacedError(error.message, {
        code: error.code,
        window: error.window ?? this.windowLabel,
        documentEpoch: error.documentEpoch,
        cause: error,
      })
    if (isRendererRestartError(error)) {
      if (Number.isSafeInteger(error.rendererGeneration))
        this._rendererGeneration = error.rendererGeneration
      return new TauriDebugRendererRestartedError(error.message, {
        window: error.window ?? this.windowLabel,
        rendererGeneration: error.rendererGeneration,
        code: error.code,
        cause: error,
      })
    }
    if (error?.code !== "webview_eval_timeout") return error
    const previous = this._rendererGeneration
    let renderer
    try {
      renderer = await this.rendererState()
    } catch {
      return error
    }
    const replaced = previous !== null && renderer.generation !== previous
    if (!renderer.awaitingLoad && !replaced) return error
    return new TauriDebugRendererRestartedError(
      `webview renderer restarted: the ${this.windowLabel} web content process was replaced while the command was pending (renderer generation ${renderer.generation}); inspect persisted and external effects before retrying`,
      {
        window: this.windowLabel,
        rendererGeneration: renderer.generation,
        code: renderer.awaitingLoad ? "webview_renderer_restarting" : "webview_renderer_restarted",
        cause: error,
      }
    )
  }
  _post(route, body, options = {}) {
    return this._request(route, { ...options, method: "POST", body })
  }
  _helperCall(method, ...args) {
    const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(",")
    return this.evaluate(`window.__cogniaAgentDebug.${method}(${serializedArgs})`)
  }

  async _ensureLocatorQuery(query, filters = [], options = {}) {
    if (!needsScopedQuery(query) && !filters.some((filter) => needsScopedQuery(filter.query)))
      return
    await this._requireCapability(
      "locatorCompositionVersion",
      2,
      "scoped locator composition",
      options
    )
  }

  async _requireCapability(name, expected, feature, options = {}) {
    let health = await this._request("/api/dev/agent/health", options)
    const renderer = health.renderers?.[this.windowLabel]
    if (!health.helper && (renderer?.documentLoading || renderer?.awaitingLoad)) {
      await this.waitForRenderer(options)
      health = await this._request("/api/dev/agent/health", options)
    }
    this._noteRenderer(health)
    const capabilities = health.helper?.capabilities || {}
    if (capabilities[name] !== expected)
      throw new TauriDebugUnsupportedError(
        feature,
        `restart the agent-debug shell with a helper that supports ${name} ${expected}`
      )
  }

  locator(selector) {
    return new TauriLocator(this, { steps: [{ kind: "css", selector }] })
  }
  getByTestId(testId) {
    return this.locator(`[data-testid=${JSON.stringify(String(testId))}]`)
  }
  getByPlaceholder(text, options = {}) {
    return new TauriLocator(this, {
      steps: [
        {
          kind: "attribute",
          name: "placeholder",
          value: serializeMatcher(text),
          exact: options.exact === true,
        },
      ],
    })
  }
  getByAltText(text, options = {}) {
    return new TauriLocator(this, {
      steps: [
        {
          kind: "attribute",
          name: "alt",
          value: serializeMatcher(text),
          exact: options.exact === true,
        },
      ],
    })
  }
  getByTitle(text, options = {}) {
    return new TauriLocator(this, {
      steps: [
        {
          kind: "attribute",
          name: "title",
          value: serializeMatcher(text),
          exact: options.exact === true,
        },
      ],
    })
  }
  getByLabel(text, options = {}) {
    return new TauriLocator(this, {
      steps: [{ kind: "label", text: serializeMatcher(text), exact: options.exact === true }],
    })
  }
  getByText(text, options = {}) {
    const locator = new TauriLocator(this, {
      steps: [{ kind: "text", text: serializeMatcher(text), exact: options.exact === true }],
    })
    return locator
  }
  getByRole(role, options = {}) {
    const { name, exact, ...state } = options
    const query = {
      steps: [
        {
          kind: "role",
          role,
          ...state,
          ...(name === undefined ? {} : { name: serializeMatcher(name), exact: exact === true }),
        },
      ],
    }
    const locator = new TauriLocator(this, query)
    return locator
  }

  setDefaultTimeout(timeout) {
    if (!Number.isFinite(timeout) || timeout < 0)
      throw new TypeError("timeout must be a non-negative number")
    this.defaultTimeout = timeout
  }

  async capabilities() {
    const health = await this._request("/api/dev/agent/health")
    this._noteRenderer(health)
    return health.helper?.capabilities || {}
  }

  _noteRenderer(health) {
    const renderer = health?.renderers?.[this.windowLabel] ?? {
      generation: 0,
      awaitingLoad: false,
    }
    this._rendererGeneration = renderer.generation
    return renderer
  }

  /**
   * Native renderer lifecycle for this window: `generation` counts web content
   * process terminations, `awaitingLoad` is true until the replacement
   * renderer commits a document.
   */
  async rendererState(options = {}) {
    return this._noteRenderer(
      await this._request("/api/dev/agent/health", { ...options, _explainErrors: false })
    )
  }

  /**
   * Wait until the window has a live renderer whose helper answers — the
   * recovery step after a `TauriDebugRendererRestartedError`.
   */
  async waitForRenderer(options = {}) {
    options = budget(options, this.defaultTimeout)
    const timeout = options.timeout ?? this.defaultTimeout
    let lastError = null
    do {
      try {
        const renderer = await this.rendererState(options)
        if (!renderer.awaitingLoad && !renderer.documentLoading) {
          const state = await this._pageState(options)
          if (["interactive", "complete"].includes(state.readyState)) return renderer
        }
      } catch (error) {
        if (
          !(error instanceof TauriDebugRendererRestartedError) &&
          !(error instanceof TauriDebugDocumentReplacedError) &&
          error.code !== "debug_connection_lost" &&
          error.code !== "webview_eval_timeout"
        )
          throw error
        lastError = error
      }
      if (remaining(options, timeout) <= 0) break
      await sleep(Math.min(100, remaining(options, timeout)), options.signal)
    } while (true)
    throw new TauriDebugTimeoutError(
      `page.waitForRenderer timed out after ${timeout}ms${lastError ? `: ${lastError.message}` : ""}`
    )
  }

  async snapshot(options = {}) {
    const payload = await this._post("/api/dev/agent/snapshot", {
      window: this.windowLabel,
      includeText: options.includeText === true,
      includeHidden: options.includeHidden === true,
      ...(options.selector ? { selector: options.selector } : {}),
    })
    return payload.snapshot
  }

  async evaluate(pageFunction, arg, options = {}) {
    const payload = await this._post(
      "/api/dev/agent/evaluate",
      {
        window: this.windowLabel,
        expression: expressionFor(pageFunction, arg),
        ...(options._deadline === undefined && options.timeout === undefined
          ? {}
          : { timeout: Math.max(1, Math.ceil(remaining(options, this.defaultTimeout))) }),
      },
      options
    )
    return payload.value
  }

  url() {
    return this.evaluate(() => location.href)
  }
  title() {
    return this.evaluate(() => document.title)
  }
  content() {
    return this.evaluate(() => document.documentElement.outerHTML)
  }

  _pageState(options) {
    return this.evaluate(() => window.__cogniaAgentDebug.health(), undefined, options)
  }

  async reload(options = {}) {
    options = budget(options, this.defaultTimeout)
    const before = await this._pageState(options)
    await this._post("/api/dev/agent/reload", { window: this.windowLabel }, options)
    await this.waitForLoadState(options.waitUntil || "load", {
      ...options,
      previousDocumentId: before.documentId,
      requireNewDocument: true,
    })
  }
  async goto(url, options = {}) {
    options = budget(options, this.defaultTimeout)
    const before = await this._pageState(options)
    await this._post("/api/dev/agent/navigate", { window: this.windowLabel, url }, options)
    await this.waitForLoadState(options.waitUntil || "load", {
      ...options,
      previousDocumentId: before.documentId,
      previousUrl: before.url,
      requireNavigation: true,
    })
    return { url: await this.evaluate(() => location.href, undefined, options) }
  }
  async goBack(options = {}) {
    options = budget(options, this.defaultTimeout)
    const before = await this._pageState(options)
    await this.evaluate(
      () => {
        setTimeout(() => history.back(), 0)
        return true
      },
      undefined,
      options
    )
    await this.waitForLoadState(options.waitUntil || "load", {
      ...options,
      previousDocumentId: before.documentId,
      previousUrl: before.url,
      requireNavigation: true,
    })
  }
  async goForward(options = {}) {
    options = budget(options, this.defaultTimeout)
    const before = await this._pageState(options)
    await this.evaluate(
      () => {
        setTimeout(() => history.forward(), 0)
        return true
      },
      undefined,
      options
    )
    await this.waitForLoadState(options.waitUntil || "load", {
      ...options,
      previousDocumentId: before.documentId,
      previousUrl: before.url,
      requireNavigation: true,
    })
  }

  waitForTimeout(milliseconds) {
    return sleep(milliseconds)
  }
  waitForSelector(selector, options) {
    if (typeof options === "number") options = { timeout: options }
    return this.locator(selector).waitFor(options)
  }
  async waitForURL(pattern, options = {}) {
    if (typeof pattern !== "string" && !(pattern instanceof RegExp))
      throw new TypeError("waitForURL expects an exact URL string or RegExp")
    options = budget(options, this.defaultTimeout)
    // Strings are exact URLs. Use a RegExp for partial matching.
    await this.waitForFunction(
      (matcher) => {
        if (matcher.regex) return new RegExp(matcher.regex, matcher.flags).test(location.href)
        return location.href === matcher
      },
      serializeMatcher(pattern),
      options
    )
    await this.waitForLoadState(options.waitUntil || "load", options)
  }
  async waitForFunction(pageFunction, arg, options = {}) {
    if (typeof pageFunction === "string" && typeof arg === "number" && arguments.length === 2) {
      options = { timeout: arg }
      arg = undefined
    }
    options = budget(options, this.defaultTimeout)
    const timeout = options.timeout ?? this.defaultTimeout
    let lastValue
    do {
      lastValue = await this.evaluate(pageFunction, arg, options)
      if (lastValue) return lastValue
      if (remaining(options, timeout) <= 0) break
      await sleep(
        Math.min(
          typeof options.polling === "number" ? options.polling : 100,
          remaining(options, timeout)
        ),
        options.signal
      )
    } while (true)
    throw new TauriDebugTimeoutError(
      `page.waitForFunction timed out after ${timeout}ms; last value: ${JSON.stringify(lastValue)}`
    )
  }
  async waitForLoadState(state = "load", options = {}) {
    if (!["load", "domcontentloaded", "networkidle"].includes(state))
      throw new TypeError(`unsupported load state: ${state}`)
    options = budget(options, this.defaultTimeout)
    const timeout = options.timeout ?? this.defaultTimeout
    let idleSince = null
    do {
      if (options.signal?.aborted)
        throw options.signal.reason || new Error(`page.waitForLoadState(${state}) aborted`)
      const health = await this._pageState(options)
      const documentChanged = health.documentId !== options.previousDocumentId
      const urlChanged = health.url !== options.previousUrl
      const navigationSettled = options.requireNewDocument
        ? documentChanged
        : !options.requireNavigation || documentChanged || urlChanged
      const domReady =
        state === "domcontentloaded"
          ? ["interactive", "complete"].includes(health.readyState)
          : health.readyState === "complete"
      if (state !== "networkidle" && navigationSettled && domReady) return
      if (
        state === "networkidle" &&
        navigationSettled &&
        domReady &&
        health.pendingRequests === 0
      ) {
        idleSince ??= performance.now()
        if (performance.now() - idleSince >= 500) return
      } else idleSince = null
      if (remaining(options, timeout) <= 0) break
      await sleep(Math.min(100, remaining(options, timeout)), options.signal)
    } while (true)
    throw new TauriDebugTimeoutError(`page.waitForLoadState(${state}) timed out after ${timeout}ms`)
  }

  click(selector, options) {
    return this.locator(selector).click(options)
  }
  dblclick(selector, options) {
    return this.locator(selector).dblclick(options)
  }
  hover(selector, options) {
    return this.locator(selector).hover(options)
  }
  fill(selector, value, options) {
    return this.locator(selector).fill(value, options)
  }
  type(selector, value, options) {
    return this.locator(selector).type(value, options)
  }
  press(selector, key, options) {
    return this.locator(selector).press(key, options)
  }
  check(selector, options) {
    return this.locator(selector).check(options)
  }
  uncheck(selector, options) {
    return this.locator(selector).uncheck(options)
  }
  selectOption(selector, value, options) {
    return this.locator(selector).selectOption(value, options)
  }
  focus(selector, options) {
    return this.locator(selector).focus(options)
  }
  blur(selector, options) {
    return this.locator(selector).blur(options)
  }
  dispatchEvent(selector, type, eventInit, options) {
    return this.locator(selector).dispatchEvent(type, eventInit, options)
  }
  dragAndDrop(source, target, options) {
    return this.locator(source).dragTo(this.locator(target), options)
  }
  setInputFiles(selector, files, options) {
    return this.locator(selector).setInputFiles(files, options)
  }
  textContent(selector, options) {
    return this.locator(selector).textContent(options)
  }
  innerText(selector, options) {
    return this.locator(selector).innerText(options)
  }
  innerHTML(selector, options) {
    return this.locator(selector).innerHTML(options)
  }
  inputValue(selector, options) {
    return this.locator(selector).inputValue(options)
  }
  getAttribute(selector, name, options) {
    return this.locator(selector).getAttribute(name, options)
  }
  boundingBox(selector, options) {
    return this.locator(selector).boundingBox(options)
  }
  getComputedStyle(selector, property, options) {
    return this.locator(selector).getComputedStyle(property, options)
  }
  allTextContents(selector) {
    return this.locator(selector).allTextContents()
  }
  allInnerTexts(selector) {
    return this.locator(selector).allInnerTexts()
  }
  count(selector) {
    return this.locator(selector).count()
  }
  isVisible(selector) {
    return this.locator(selector).isVisible()
  }
  isHidden(selector) {
    return this.locator(selector).isHidden()
  }
  isEnabled(selector) {
    return this.locator(selector).isEnabled()
  }
  isDisabled(selector) {
    return this.locator(selector).isDisabled()
  }
  isEditable(selector) {
    return this.locator(selector).isEditable()
  }
  isChecked(selector) {
    return this.locator(selector).isChecked()
  }
  isFocused(selector) {
    return this.locator(selector).isFocused()
  }

  async installDialogHandler(options = {}) {
    return this._helperCall("installDialogHandler", {
      defaultConfirm: options.defaultConfirm ?? true,
      defaultPromptText: options.defaultPromptText ?? "",
    })
  }
  getDialogs() {
    return this._helperCall("getDialogs")
  }
  clearDialogs() {
    return this._helperCall("clearDialogs")
  }
  route(pattern, response = {}) {
    return this._helperCall("addNetworkRoute", pattern, response)
  }
  unroute(pattern) {
    return this._helperCall("removeNetworkRoute", pattern)
  }
  clearRoutes() {
    return this._helperCall("clearNetworkRoutes")
  }
  getNetworkRequests() {
    return this._helperCall("getNetworkRequests")
  }
  clearNetworkRequests() {
    return this._helperCall("clearNetworkRequests")
  }

  async screenshot(options = {}) {
    const payload = await this._request(
      `/api/dev/agent/screenshot?window=${encodeURIComponent(this.windowLabel)}`
    )
    const buffer = Buffer.from(payload.screenshot.bytes, "base64")
    if (options.path) {
      const target = path.resolve(options.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, buffer)
    }
    return buffer
  }
  startRecording() {
    throw new TauriDebugUnsupportedError(
      "video recording",
      "capabilities.video is false; use screenshots or the Windows CDP suite"
    )
  }
  stopRecording() {
    throw new TauriDebugUnsupportedError("video recording", "no recording is active")
  }
  async consoleMessages() {
    const result = await this.readConsole({
      after: this._consoleCursor,
      documentId: this._consoleDocumentId ?? undefined,
    })
    this._consoleCursor = result.nextCursor
    this._consoleDocumentId = result.documentId ?? null
    return result.entries
  }
  async networkEvents() {
    const result = await this.readNetwork({
      after: this._networkCursor,
      documentId: this._networkDocumentId ?? undefined,
    })
    this._networkCursor = result.nextCursor
    this._networkDocumentId = result.documentId ?? null
    return result.entries
  }
  async _readDiagnostics(kind, options = {}) {
    const params = new URLSearchParams({
      window: this.windowLabel,
      after: String(options.after ?? 0),
      limit: String(options.limit ?? 500),
    })
    if (options.documentId !== undefined) params.set("documentId", options.documentId)
    const payload = await this._request(`/api/dev/agent/${kind}?${params}`)
    return payload[kind]
  }
  readConsole(options = {}) {
    return this._readDiagnostics("console", options)
  }
  readNetwork(options = {}) {
    return this._readDiagnostics("network", options)
  }
  async nativeLogs(options = {}) {
    const lines = options.lines ?? 400
    return (await this._request(`/api/dev/agent/logs?lines=${encodeURIComponent(lines)}`)).lines
  }

  window(label) {
    return new TauriPage({
      endpoint: this.endpoint,
      window: label,
      fetchImpl: this.fetchImpl,
      defaultTimeout: this.defaultTimeout,
      endpointLoader: this._endpointLoader,
    })
  }
  get targetWindow() {
    return this.windowLabel
  }
  async listWindows() {
    return (await this._request("/api/dev/agent/windows")).windows
  }
  async waitForWindow(predicate, options = {}) {
    const timeout = options.timeout ?? this.defaultTimeout
    const deadline = Date.now() + timeout
    do {
      const match = (await this.listWindows()).find(predicate)
      if (match) return this.window(match.label)
      if (Date.now() >= deadline) break
      await sleep(50)
    } while (true)
    throw new Error(`waitForWindow: no matching window within ${timeout}ms`)
  }
  async close() {
    return this._post("/api/dev/agent/shutdown", {})
  }
}

async function pollAssertion(read, predicate, timeout) {
  const deadline = Date.now() + timeout
  let value
  do {
    try {
      value = await read()
      if (predicate(value)) return { pass: true, value }
    } catch (error) {
      value = error
    }
    if (Date.now() >= deadline) break
    await sleep(100)
  } while (true)
  return { pass: false, value }
}

function assertionApi(subject, negated = false) {
  const run = async (name, read, predicate, expected, options = {}) => {
    const timeout =
      options.timeout ?? subject.page?.defaultTimeout ?? subject.defaultTimeout ?? 5000
    const result = await pollAssertion(
      read,
      (value) => (negated ? !predicate(value) : predicate(value)),
      timeout
    )
    if (!result.pass)
      throw new Error(
        `${name} failed after ${timeout}ms: expected ${negated ? "not " : ""}${expected}; received ${String(result.value)}`
      )
  }
  return {
    get not() {
      return assertionApi(subject, !negated)
    },
    toBeVisible: (options) =>
      run("toBeVisible", () => subject.isVisible(), Boolean, "visible", options),
    toBeHidden: (options) =>
      run("toBeHidden", () => subject.isHidden(), Boolean, "hidden", options),
    toBeEnabled: (options) =>
      run("toBeEnabled", () => subject.isEnabled(), Boolean, "enabled", options),
    toBeDisabled: (options) =>
      run("toBeDisabled", () => subject.isDisabled(), Boolean, "disabled", options),
    toBeEditable: (options) =>
      run("toBeEditable", () => subject.isEditable(), Boolean, "editable", options),
    toBeChecked: (options) =>
      run("toBeChecked", () => subject.isChecked(), Boolean, "checked", options),
    toBeFocused: (options) =>
      run("toBeFocused", () => subject.isFocused(), Boolean, "focused", options),
    toBeAttached: (options) =>
      run(
        "toBeAttached",
        () => subject.count(),
        (value) => value > 0,
        "attached",
        options
      ),
    toBeEmpty: (options) =>
      run(
        "toBeEmpty",
        async () => {
          try {
            return await subject.inputValue()
          } catch {
            return (await subject.textContent()) ?? ""
          }
        },
        (value) => String(value).trim() === "",
        "empty",
        options
      ),
    toHaveCount: (expected, options) =>
      run(
        "toHaveCount",
        () => subject.count(),
        (value) => value === expected,
        expected,
        options
      ),
    toContainText: (expected, options) =>
      run(
        "toContainText",
        () => subject.textContent(),
        (value) => matches(value, expected),
        expected,
        options
      ),
    toHaveText: (expected, options) =>
      run(
        "toHaveText",
        () => subject.textContent(),
        (value) => matches(value, expected, true),
        expected,
        options
      ),
    toHaveValue: (expected, options) =>
      run(
        "toHaveValue",
        () => subject.inputValue(),
        (value) => matches(value, expected, true),
        expected,
        options
      ),
    toHaveAttribute: (name, expected, options) =>
      run(
        "toHaveAttribute",
        () => subject.getAttribute(name),
        (value) => matches(value, expected, true),
        `${name}=${expected}`,
        options
      ),
    toHaveClass: (expected, options) =>
      run(
        "toHaveClass",
        () => subject.getAttribute("class"),
        (value) => matches(value, expected, true),
        `class=${expected}`,
        options
      ),
    toHaveId: (expected, options) =>
      run(
        "toHaveId",
        () => subject.getAttribute("id"),
        (value) => matches(value, expected, true),
        `id=${expected}`,
        options
      ),
    toHaveCSS: (property, expected, options) =>
      run(
        "toHaveCSS",
        () => subject.getComputedStyle(property),
        (value) => matches(value, expected, true),
        `${property}=${expected}`,
        options
      ),
    toHaveURL: (expected, options) =>
      run(
        "toHaveURL",
        () => subject.url(),
        (value) => matches(value, expected, true),
        expected,
        options
      ),
    toHaveTitle: (expected, options) =>
      run(
        "toHaveTitle",
        () => subject.title(),
        (value) => matches(value, expected, true),
        expected,
        options
      ),
  }
}

export const tauriExpect = (subject) => assertionApi(subject)
export const expect = tauriExpect
export function connectTauriPage(options) {
  return new TauriPage(options)
}
