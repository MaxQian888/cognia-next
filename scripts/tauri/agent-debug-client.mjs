import fs from "node:fs"
import path from "node:path"

import { loadEndpoint, request } from "./agent-debug.mjs"

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
  constructor(code, message, retryable = false) {
    super(message)
    this.name = "TauriDebugLocatorError"
    this.code = code
    this.retryable = retryable
  }
}

export class TauriDebugTimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = "TauriDebugTimeoutError"
  }
}

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
    return this._clone({ query: { steps: [...this.query.steps, step] }, index: null })
  }

  first() {
    return this.nth(0)
  }

  last() {
    return this._clone({ index: -1 })
  }

  nth(index) {
    if (!Number.isSafeInteger(index)) throw new TypeError("nth index must be an integer")
    return this._clone({ index })
  }

  filter(options = {}) {
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
        query: locator.query,
        ...(locator.predicates.length ? { filters: locator.predicates } : {}),
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
        left: { kind: "filtered", query: this.query, filters: this.predicates },
        right: { kind: "filtered", query: locator.query, filters: locator.predicates },
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
        left: { kind: "filtered", query: this.query, filters: this.predicates },
        right: { kind: "filtered", query: locator.query, filters: locator.predicates },
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

  async _nodes({ includeHidden = true } = {}) {
    const payload = await this.page._post("/api/dev/agent/locator", {
      window: this.page.windowLabel,
      query: this.query,
      filters: this.predicates,
      operation: "query",
      strict: false,
      args: { includeHidden },
    })
    if (!payload.locator?.ok)
      throw new TauriDebugLocatorError(
        payload.locator?.code || "locator_failed",
        payload.locator?.error || "locator query failed",
        payload.locator?.retryable === true
      )
    return payload.locator.nodes
  }

  _indexed(nodes) {
    if (this.index === null) return nodes
    const index = this.index < 0 ? nodes.length + this.index : this.index
    return nodes[index] ? [nodes[index]] : []
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
      lastNodes = this._indexed(allNodes)
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
    const payload = await this.page._post(
      "/api/dev/agent/locator",
      {
        window: this.page.windowLabel,
        query: this.query,
        index: this.index,
        filters: this.predicates,
        operation,
        name,
        args,
        options: {
          force: options.force === true,
          trial: options.trial === true,
          scroll: options.scroll || "auto",
          timeout: options.timeout ?? this.page.defaultTimeout,
        },
        requirements,
        strict: true,
      },
      { signal: options.signal }
    )
    const result = payload.locator
    if (!result?.ok)
      throw new TauriDebugLocatorError(
        result?.code || "locator_failed",
        result?.error || "locator operation failed",
        result?.retryable === true
      )
    if (operation === "action" && result.navigation && options.trial !== true) {
      await this.page.waitForLoadState(options.waitUntil || "load", {
        timeout: options.timeout ?? this.page.defaultTimeout,
        signal: options.signal,
        previousDocumentId: result.previousDocumentId,
        previousUrl: result.previousUrl,
        requireNavigation: true,
      })
    }
    return result.value
  }

  async _act(action, args = {}, options = {}, requirements = {}) {
    const timeout = options.timeout ?? this.page.defaultTimeout
    const deadline = Date.now() + timeout
    let lastError
    do {
      try {
        return await this._atomic("action", action, args, options, requirements)
      } catch (error) {
        lastError = error
        if (!error.retryable) throw error
        if (Date.now() >= deadline)
          throw new TauriDebugTimeoutError(
            `locator action ${action} timed out after ${timeout}ms: ${error.message}`
          )
        await sleep(50, options.signal)
      }
    } while (Date.now() <= deadline)
    throw lastError
  }

  async _inspect(operation, args = {}, options = {}) {
    const timeout = options.timeout ?? this.page.defaultTimeout
    const deadline = Date.now() + timeout
    let lastError
    do {
      try {
        return await this._atomic("inspect", operation, args, options)
      } catch (error) {
        lastError = error
        if (!error.retryable) throw error
        if (Date.now() >= deadline)
          throw new TauriDebugTimeoutError(
            `locator inspection ${operation} timed out after ${timeout}ms: ${error.message}`
          )
        await sleep(50, options.signal)
      }
    } while (Date.now() <= deadline)
    throw lastError
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
      await sleep(options.delay)
    }
  }

  async dragTo(target, options = {}) {
    if (!(target instanceof TauriLocator) || target.page !== this.page)
      throw new TypeError("dragTo target must be a locator from the same TauriPage")
    if (target.predicates.length)
      throw new TauriDebugUnsupportedError("dragTo with client-side locator filters")
    const targetIndex = target.index === null ? 0 : target.index
    if (targetIndex < 0) throw new TauriDebugUnsupportedError("dragTo with locator.last()")
    await target._resolve({ timeout: options.timeout ?? this.page.defaultTimeout, visible: true })
    return this._act("dragTo", { targetQuery: target.query, targetIndex }, options, {
      visible: true,
      enabled: true,
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
    return this._indexed(await this._nodes()).length
  }
  async all() {
    if (this.index !== null) return (await this.count()) === 0 ? [] : [this]
    return Array.from({ length: await this.count() }, (_, index) => this.nth(index))
  }
  async allTextContents() {
    return this._indexed(await this._nodes()).map((node) => node.text)
  }
  async allInnerTexts() {
    return this.allTextContents()
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
    const timeout = options.timeout ?? this.page.defaultTimeout
    const deadline = Date.now() + timeout
    let lastValue
    do {
      if (options.signal?.aborted)
        throw options.signal.reason || new Error("locator.waitForFunction aborted")
      lastValue = await this.evaluate(pageFunction, arg, options)
      if (lastValue) return lastValue
      if (Date.now() >= deadline) break
      await sleep(typeof options.polling === "number" ? options.polling : 100, options.signal)
    } while (true)
    throw new TauriDebugTimeoutError(
      `locator.waitForFunction timed out after ${timeout}ms; last value: ${JSON.stringify(lastValue)}`
    )
  }

  ariaSnapshot(options = {}) {
    return this._inspect("ariaSnapshot", { options }, options)
  }

  async isVisible() {
    return this._indexed(await this._nodes()).some((node) => node.visible)
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
    const timeout = options.timeout ?? this.page.defaultTimeout
    const deadline = Date.now() + timeout
    let lastCount = 0
    do {
      const nodes = this._indexed(await this._nodes({ includeHidden: true }))
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
      if (Date.now() >= deadline) break
      await sleep(100)
    } while (true)
    throw new Error(
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
  } = {}) {
    this.endpoint = endpoint
    this.windowLabel = window
    this.fetchImpl = fetchImpl
    this.defaultTimeout = defaultTimeout
    this._consoleCursor = 0
    this._networkCursor = 0
    this.keyboard = new TauriKeyboard(this)
    this.mouse = new TauriMouse(this)
  }

  _request(route, options = {}) {
    return request(route, { ...options, endpoint: this.endpoint, fetchImpl: this.fetchImpl })
  }
  _post(route, body, options = {}) {
    return this._request(route, { ...options, method: "POST", body })
  }
  _helperCall(method, ...args) {
    const serializedArgs = args.map((arg) => JSON.stringify(arg)).join(",")
    return this.evaluate(`window.__cogniaAgentDebug.${method}(${serializedArgs})`)
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
    return health.helper?.capabilities || {}
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

  async evaluate(pageFunction, arg) {
    const payload = await this._post("/api/dev/agent/evaluate", {
      window: this.windowLabel,
      expression: expressionFor(pageFunction, arg),
    })
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

  _pageState() {
    return this.evaluate(() => window.__cogniaAgentDebug.health())
  }

  async reload(options = {}) {
    const before = await this._pageState()
    await this._post("/api/dev/agent/reload", { window: this.windowLabel })
    await this.waitForLoadState(options.waitUntil || "load", {
      ...options,
      previousDocumentId: before.documentId,
      requireNewDocument: true,
    })
  }
  async goto(url, options = {}) {
    const before = await this._pageState()
    await this._post("/api/dev/agent/navigate", { window: this.windowLabel, url })
    await this.waitForLoadState(options.waitUntil || "load", {
      ...options,
      previousDocumentId: before.documentId,
      previousUrl: before.url,
      requireNavigation: true,
    })
    return { url: await this.url() }
  }
  async goBack(options = {}) {
    const before = await this._pageState()
    await this.evaluate(() => {
      setTimeout(() => history.back(), 0)
      return true
    })
    await this.waitForLoadState(options.waitUntil || "load", {
      ...options,
      previousDocumentId: before.documentId,
      previousUrl: before.url,
      requireNavigation: true,
    })
  }
  async goForward(options = {}) {
    const before = await this._pageState()
    await this.evaluate(() => {
      setTimeout(() => history.forward(), 0)
      return true
    })
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
    const timeout = options.timeout ?? this.defaultTimeout
    await this.waitForFunction(
      (matcher) => {
        if (matcher.regex) return new RegExp(matcher.regex, matcher.flags).test(location.href)
        return location.href.includes(matcher)
      },
      serializeMatcher(pattern),
      { timeout }
    )
  }
  async waitForFunction(pageFunction, arg, options = {}) {
    if (typeof pageFunction === "string" && typeof arg === "number" && arguments.length === 2) {
      options = { timeout: arg }
      arg = undefined
    }
    const timeout = options.timeout ?? this.defaultTimeout
    const deadline = Date.now() + timeout
    let lastValue
    do {
      lastValue = await this.evaluate(pageFunction, arg)
      if (lastValue) return lastValue
      if (Date.now() >= deadline) break
      await sleep(typeof options.polling === "number" ? options.polling : 100)
    } while (true)
    throw new Error(
      `page.waitForFunction timed out after ${timeout}ms; last value: ${JSON.stringify(lastValue)}`
    )
  }
  async waitForLoadState(state = "load", options = {}) {
    const timeout = options.timeout ?? this.defaultTimeout
    const deadline = Date.now() + timeout
    let idleSince = null
    do {
      if (options.signal?.aborted)
        throw options.signal.reason || new Error(`page.waitForLoadState(${state}) aborted`)
      const health = await this._pageState()
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
        idleSince ??= Date.now()
        if (Date.now() - idleSince >= 500) return
      } else idleSince = null
      if (Date.now() >= deadline) break
      await sleep(100)
    } while (true)
    throw new Error(`page.waitForLoadState(${state}) timed out after ${timeout}ms`)
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
    const result = await this.readConsole({ after: this._consoleCursor })
    this._consoleCursor = result.nextCursor
    return result.entries
  }
  async networkEvents() {
    const result = await this.readNetwork({ after: this._networkCursor })
    this._networkCursor = result.nextCursor
    return result.entries
  }
  async _readDiagnostics(kind, options = {}) {
    const params = new URLSearchParams({
      window: this.windowLabel,
      after: String(options.after ?? 0),
      limit: String(options.limit ?? 500),
    })
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
