;(() => {
  if (window.__cogniaAgentDebug?.version === 2) return

  const MAX_EVENTS = 500
  const MAX_NODES = 500
  const state = {
    generation: 0,
    refs: new Map(),
    console: [],
    network: [],
    pendingRequests: 0,
    networkRoutes: new Map(),
    dialogs: [],
    dialogOptions: { defaultConfirm: true, defaultPromptText: "" },
    dialogHandlerInstalled: false,
    mouse: { x: 0, y: 0, buttons: 0 },
    modifiers: new Set(),
  }

  const capabilities = Object.freeze({
    apiVersion: 2,
    transport: "tauri-webview-eval",
    locatorAutoWait: true,
    locatorStrictness: true,
    actionability: ["attached", "visible", "enabled", "editable"],
    stablePositionCheck: false,
    receivesEventsCheck: false,
    semanticLocators: true,
    multiWindow: true,
    nativeScreenshot: true,
    consoleCapture: "buffered",
    networkCapture: "fetch-and-xhr",
    networkMocking: "fetch-only",
    dialogs: true,
    fileUpload: true,
    keyboard: "dom-events",
    mouse: "dom-events",
    trustedEvents: false,
    video: false,
    cdp: false,
  })

  const pushBounded = (target, entry) => {
    target.push(entry)
    if (target.length > MAX_EVENTS) target.splice(0, target.length - MAX_EVENTS)
  }

  const serialize = (value, depth = 0, seen = new WeakSet()) => {
    if (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value
    if (typeof value === "bigint") return `${value}n`
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
    if (typeof value !== "object") return String(value)
    if (depth >= 4) return "[MaxDepth]"
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    if (value instanceof Error)
      return { name: value.name, message: value.message, stack: value.stack }
    if (Array.isArray(value))
      return value.slice(0, 50).map((item) => serialize(item, depth + 1, seen))
    const result = {}
    for (const key of Object.keys(value).slice(0, 50)) {
      try {
        result[key] = serialize(value[key], depth + 1, seen)
      } catch (error) {
        result[key] = `[Unserializable: ${String(error)}]`
      }
    }
    return result
  }

  const timestamp = () => new Date().toISOString()
  const normalize = (value) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
  const textMatches = (actual, expected, exact = false) => {
    const haystack = normalize(actual)
    if (expected && typeof expected === "object" && typeof expected.regex === "string") {
      return new RegExp(expected.regex, String(expected.flags || "").replace(/[gy]/g, "")).test(
        haystack
      )
    }
    const needle = normalize(expected)
    return exact
      ? haystack === needle
      : haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
  }

  for (const level of ["debug", "info", "log", "warn", "error"]) {
    const original = console[level]?.bind(console)
    if (!original) continue
    console[level] = (...args) => {
      pushBounded(state.console, { timestamp: timestamp(), level, args: serialize(args) })
      original(...args)
    }
  }

  window.addEventListener("error", (event) => {
    pushBounded(state.console, {
      timestamp: timestamp(),
      level: "error",
      args: [
        { message: event.message, source: event.filename, line: event.lineno, column: event.colno },
      ],
    })
  })
  window.addEventListener("unhandledrejection", (event) => {
    pushBounded(state.console, {
      timestamp: timestamp(),
      level: "error",
      args: [{ type: "unhandledrejection", reason: serialize(event.reason) }],
    })
  })

  const globMatches = (url, pattern) => {
    if (!pattern) return false
    if (!pattern.includes("*")) return url.includes(pattern)
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
    return new RegExp(`^${escaped}$`).test(url) || new RegExp(escaped).test(url)
  }

  const originalFetch = window.fetch?.bind(window)
  if (originalFetch) {
    window.fetch = async (...args) => {
      const input = args[0]
      const init = args[1]
      const url = typeof input === "string" ? input : input?.url || String(input)
      const method = String(init?.method || input?.method || "GET").toUpperCase()
      const startedAt = performance.now()
      state.pendingRequests += 1
      try {
        const route = Array.from(state.networkRoutes.entries()).find(([pattern]) =>
          globMatches(url, pattern)
        )
        const response = route
          ? new Response(route[1].body ?? "", {
              status: route[1].status ?? 200,
              headers: {
                "Content-Type": route[1].contentType ?? "application/json",
                ...(route[1].headers || {}),
              },
            })
          : await originalFetch(...args)
        pushBounded(state.network, {
          timestamp: timestamp(),
          method,
          url,
          status: response.status,
          ok: response.ok,
          mocked: Boolean(route),
          durationMs: Math.round(performance.now() - startedAt),
        })
        return response
      } catch (error) {
        pushBounded(state.network, {
          timestamp: timestamp(),
          method,
          url,
          status: 0,
          ok: false,
          durationMs: Math.round(performance.now() - startedAt),
          error: String(error),
        })
        throw error
      } finally {
        state.pendingRequests -= 1
      }
    }
  }

  const NativeXhr = window.XMLHttpRequest
  if (NativeXhr) {
    const open = NativeXhr.prototype.open
    const send = NativeXhr.prototype.send
    NativeXhr.prototype.open = function (method, url, ...rest) {
      this.__cogniaAgentRequest = { method: String(method).toUpperCase(), url: String(url) }
      return open.call(this, method, url, ...rest)
    }
    NativeXhr.prototype.send = function (...args) {
      const request = this.__cogniaAgentRequest || { method: "GET", url: "unknown" }
      const startedAt = performance.now()
      state.pendingRequests += 1
      const finish = () => {
        pushBounded(state.network, {
          timestamp: timestamp(),
          method: request.method,
          url: request.url,
          status: this.status || 0,
          ok: this.status >= 200 && this.status < 400,
          mocked: false,
          durationMs: Math.round(performance.now() - startedAt),
        })
        state.pendingRequests = Math.max(0, state.pendingRequests - 1)
      }
      this.addEventListener("loadend", finish, { once: true })
      return send.apply(this, args)
    }
  }

  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase()
    if (tag === "button") return "button"
    if (tag === "a" && element.hasAttribute("href")) return "link"
    if (tag === "textarea") return "textbox"
    if (tag === "select") return "combobox"
    if (/^h[1-6]$/.test(tag)) return "heading"
    if (tag === "img") return "img"
    if (tag === "li") return "listitem"
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase()
      if (["button", "submit", "reset"].includes(type)) return "button"
      if (type === "checkbox") return "checkbox"
      if (type === "radio") return "radio"
      if (type === "range") return "slider"
      return "textbox"
    }
    return element.getAttribute("role") || null
  }

  const accessibleName = (element) => {
    const labelledBy = element.getAttribute("aria-labelledby")
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .trim()
      if (text) return normalize(text)
    }
    const aria = element.getAttribute("aria-label")?.trim()
    if (aria) return aria
    if (element.labels?.length) {
      const text = Array.from(element.labels)
        .map((label) => label.textContent || "")
        .join(" ")
        .trim()
      if (text) return normalize(text)
    }
    return normalize(
      element.getAttribute("alt") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        element.textContent ||
        ""
    ).slice(0, 240)
  }

  const isVisible = (element) => {
    for (let current = element; current instanceof Element; current = current.parentElement) {
      const style = getComputedStyle(current)
      if (
        current.hasAttribute("hidden") ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      )
        return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  const isDisabled = (element) =>
    Boolean(element.disabled || element.getAttribute("aria-disabled") === "true")
  const isEditable = (element) => {
    if (isDisabled(element) || element.readOnly) return false
    return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable
  }

  const descendants = (root) => Array.from(root.querySelectorAll("*"))
  const applyStep = (roots, step) => {
    let candidates = []
    for (const root of roots) {
      if (step.kind === "css") {
        try {
          candidates.push(...root.querySelectorAll(step.selector))
        } catch (error) {
          throw new Error(`invalid selector: ${String(error)}`)
        }
      } else {
        candidates.push(...descendants(root))
      }
    }
    candidates = Array.from(new Set(candidates))
    if (step.kind === "role") {
      candidates = candidates.filter((element) => {
        const role = element.getAttribute("role") || implicitRole(element)
        if (role !== step.role) return false
        if (!step.includeHidden && !isVisible(element)) return false
        if (step.name !== undefined && !textMatches(accessibleName(element), step.name, step.exact))
          return false
        if (
          step.checked !== undefined &&
          Boolean(element.checked ?? element.getAttribute("aria-checked") === "true") !==
            step.checked
        )
          return false
        if (step.disabled !== undefined && isDisabled(element) !== step.disabled) return false
        if (
          step.expanded !== undefined &&
          (element.getAttribute("aria-expanded") === "true") !== step.expanded
        )
          return false
        if (
          step.pressed !== undefined &&
          (element.getAttribute("aria-pressed") === "true") !== step.pressed
        )
          return false
        if (
          step.selected !== undefined &&
          Boolean(element.selected ?? element.getAttribute("aria-selected") === "true") !==
            step.selected
        )
          return false
        if (
          step.level !== undefined &&
          Number(element.getAttribute("aria-level") || element.tagName.match(/^H([1-6])$/)?.[1]) !==
            step.level
        )
          return false
        return true
      })
    } else if (step.kind === "text") {
      candidates = candidates.filter((element) => {
        const ownText = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent || "")
          .join(" ")
        const text =
          normalize(ownText) ||
          (element.children.length === 0 ? normalize(element.textContent) : "")
        return text && textMatches(text, step.text, step.exact)
      })
    } else if (step.kind === "label") {
      candidates = candidates.filter(
        (element) =>
          ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) &&
          textMatches(accessibleName(element), step.text, step.exact)
      )
    }
    return candidates
  }

  const resolveCandidates = (options = {}) => {
    const steps = options.query?.steps?.length
      ? options.query.steps
      : options.selector
        ? [{ kind: "css", selector: options.selector }]
        : options.role
          ? [{ kind: "role", role: options.role, name: options.name, exact: options.nameExact }]
          : options.name
            ? [{ kind: "text", text: options.name, exact: options.nameExact }]
            : [
                {
                  kind: "css",
                  selector:
                    "button,a[href],input,textarea,select,[role],[contenteditable='true'],h1,h2,h3,h4,h5,h6,img,li,p",
                },
              ]
    let roots = [document]
    for (const step of steps) roots = applyStep(roots, step)
    return roots
  }

  const snapshot = (options = {}) => {
    state.generation += 1
    state.refs.clear()
    const generation = state.generation
    const nodes = []
    for (const element of resolveCandidates(options)) {
      if (nodes.length >= MAX_NODES) break
      const visible = isVisible(element)
      if (!visible && !options.includeHidden && !options.query?.steps?.at(-1)?.includeHidden)
        continue
      const role = element.getAttribute("role") || implicitRole(element)
      const interactive = Boolean(
        role && !["heading", "img", "listitem", "paragraph"].includes(role)
      )
      if (!interactive && !options.includeText && role !== "heading" && !options.query) continue
      const ref = `g${generation}e${nodes.length + 1}`
      state.refs.set(ref, element)
      const rect = element.getBoundingClientRect()
      const node = {
        ref,
        role: role || "text",
        name: accessibleName(element),
        tag: element.tagName.toLowerCase(),
        text: normalize(element.textContent).slice(0, 500),
        visible,
        disabled: isDisabled(element),
        editable: isEditable(element),
        focused: document.activeElement === element,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      }
      if ("value" in element && typeof element.value === "string")
        node.value = element.value.slice(0, 500)
      if ("checked" in element) node.checked = Boolean(element.checked)
      if ("selected" in element) node.selected = Boolean(element.selected)
      if (element.hasAttribute("href")) node.href = element.href
      if (element.hasAttribute("aria-expanded"))
        node.expanded = element.getAttribute("aria-expanded") === "true"
      if (role === "heading")
        node.level =
          Number(element.getAttribute("aria-level") || element.tagName.slice(1)) || undefined
      nodes.push(node)
    }
    return {
      generation,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      nodes,
      truncated: nodes.length >= MAX_NODES,
      pendingRequests: state.pendingRequests,
    }
  }

  const refElement = (ref) => {
    const element = state.refs.get(ref)
    if (!element || !element.isConnected) throw new Error(`stale or unknown element ref: ${ref}`)
    return element
  }

  const setNativeValue = (element, value) => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
    if (setter) setter.call(element, value)
    else element.value = value
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
  }

  const inspect = async (ref, operation, args = {}) => {
    const element = refElement(ref)
    switch (operation) {
      case "textContent":
        return element.textContent
      case "innerText":
        return element.innerText
      case "innerHTML":
        return element.innerHTML
      case "inputValue":
        return element.value ?? ""
      case "getAttribute":
        return element.getAttribute(String(args.name))
      case "boundingBox": {
        if (!isVisible(element)) return null
        const rect = element.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      case "getComputedStyle":
        return getComputedStyle(element).getPropertyValue(String(args.property))
      case "evaluate":
        return serialize(await (0, eval)(`(${String(args.functionSource)})`)(element, args.arg))
      default:
        throw new Error(`unsupported inspection: ${operation}`)
    }
  }

  const act = async (ref, action, args = {}) => {
    const element = refElement(ref)
    if (
      isDisabled(element) &&
      !["focus", "blur", "scrollIntoView", "dispatchEvent"].includes(action)
    )
      throw new Error(`element is disabled: ${ref}`)
    let value = null
    switch (action) {
      case "click":
        element.click()
        break
      case "dblclick":
        element.dispatchEvent(
          new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window })
        )
        break
      case "focus":
        element.focus()
        break
      case "blur":
        element.blur()
        break
      case "hover":
        element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, view: window }))
        element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window }))
        break
      case "fill":
        setNativeValue(element, String(args.value ?? ""))
        break
      case "type":
        element.focus()
        setNativeValue(element, `${element.value || ""}${String(args.value ?? "")}`)
        break
      case "press": {
        const key = String(args.key || "Enter")
        element.focus()
        element.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
        )
        element.dispatchEvent(
          new KeyboardEvent("keypress", { key, bubbles: true, cancelable: true })
        )
        element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }))
        break
      }
      case "check":
      case "uncheck": {
        const desired = action === "check"
        if (Boolean(element.checked) !== desired) element.click()
        break
      }
      case "select": {
        const requested = Array.isArray(args.values)
          ? args.values.map(String)
          : [String(args.value ?? "")]
        for (const option of element.options || [])
          option.selected = requested.includes(option.value) || requested.includes(option.label)
        element.dispatchEvent(new Event("input", { bubbles: true }))
        element.dispatchEvent(new Event("change", { bubbles: true }))
        value = Array.from(element.selectedOptions || []).map((option) => option.value)
        break
      }
      case "scrollIntoView":
        element.scrollIntoView({ block: "center", inline: "center" })
        break
      case "dispatchEvent":
        element.dispatchEvent(
          new CustomEvent(String(args.type), {
            bubbles: true,
            cancelable: true,
            detail: args.eventInit,
          })
        )
        break
      case "dragTo": {
        const target = resolveCandidates({ query: args.targetQuery })[Number(args.targetIndex || 0)]
        if (!target) throw new Error("dragTo target did not resolve")
        const transfer = new DataTransfer()
        element.dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer })
        )
        target.dispatchEvent(
          new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer })
        )
        target.dispatchEvent(
          new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer })
        )
        target.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer })
        )
        element.dispatchEvent(
          new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: transfer })
        )
        break
      }
      case "setInputFiles": {
        if (!(element instanceof HTMLInputElement) || element.type !== "file")
          throw new Error("setInputFiles requires an input[type=file]")
        const transfer = new DataTransfer()
        for (const file of args.files || []) {
          const bytes = Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0))
          transfer.items.add(
            new File([bytes], file.name, { type: file.mimeType || "application/octet-stream" })
          )
        }
        element.files = transfer.files
        element.dispatchEvent(new Event("input", { bubbles: true }))
        element.dispatchEvent(new Event("change", { bubbles: true }))
        value = element.files.length
        break
      }
      default:
        throw new Error(`unsupported action: ${action}`)
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { action, ref, value }
  }

  const keyboard = async (operation, args = {}) => {
    const element = document.activeElement || document.body
    const key = String(args.key || "")
    const eventOptions = {
      key,
      bubbles: true,
      cancelable: true,
      ctrlKey: state.modifiers.has("Control"),
      shiftKey: state.modifiers.has("Shift"),
      altKey: state.modifiers.has("Alt"),
      metaKey: state.modifiers.has("Meta"),
    }
    if (operation === "down") {
      state.modifiers.add(key)
      element.dispatchEvent(new KeyboardEvent("keydown", eventOptions))
    } else if (operation === "up") {
      element.dispatchEvent(new KeyboardEvent("keyup", eventOptions))
      state.modifiers.delete(key)
    } else if (operation === "press") {
      element.dispatchEvent(new KeyboardEvent("keydown", eventOptions))
      element.dispatchEvent(new KeyboardEvent("keypress", eventOptions))
      element.dispatchEvent(new KeyboardEvent("keyup", eventOptions))
    } else if (["type", "insertText"].includes(operation)) {
      const text = String(args.text ?? "")
      if ("value" in element) setNativeValue(element, `${element.value || ""}${text}`)
      else if (element.isContentEditable) {
        element.textContent = `${element.textContent || ""}${text}`
        element.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
        )
      }
    } else throw new Error(`unsupported keyboard operation: ${operation}`)
    return true
  }

  const mouse = async (operation, args = {}) => {
    if (Number.isFinite(args.x)) state.mouse.x = Number(args.x)
    if (Number.isFinite(args.y)) state.mouse.y = Number(args.y)
    const target = document.elementFromPoint(state.mouse.x, state.mouse.y) || document.body
    const button = args.button === "right" ? 2 : args.button === "middle" ? 1 : 0
    const event = (type, detail = 0) =>
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: state.mouse.x,
          clientY: state.mouse.y,
          button,
          buttons: state.mouse.buttons,
          detail,
        })
      )
    if (operation === "move") event("mousemove")
    else if (operation === "down") {
      state.mouse.buttons = 1 << button
      event("mousedown")
    } else if (operation === "up") {
      event("mouseup")
      state.mouse.buttons = 0
    } else if (operation === "click") {
      event("mousedown", 1)
      event("mouseup", 1)
      event("click", 1)
    } else if (operation === "dblclick") {
      event("click", 1)
      event("click", 2)
      event("dblclick", 2)
    } else if (operation === "wheel")
      target.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: Number(args.deltaX || 0),
          deltaY: Number(args.deltaY || 0),
        })
      )
    else throw new Error(`unsupported mouse operation: ${operation}`)
    return true
  }

  const installDialogHandler = (options = {}) => {
    state.dialogOptions = { ...state.dialogOptions, ...options }
    if (state.dialogHandlerInstalled) return true
    const native = {
      alert: window.alert.bind(window),
      confirm: window.confirm.bind(window),
      prompt: window.prompt.bind(window),
    }
    window.alert = (message) => {
      pushBounded(state.dialogs, {
        type: "alert",
        message: String(message),
        timestamp: timestamp(),
      })
    }
    window.confirm = (message) => {
      pushBounded(state.dialogs, {
        type: "confirm",
        message: String(message),
        timestamp: timestamp(),
      })
      return state.dialogOptions.defaultConfirm
    }
    window.prompt = (message, defaultValue = "") => {
      pushBounded(state.dialogs, {
        type: "prompt",
        message: String(message),
        default: String(defaultValue),
        timestamp: timestamp(),
      })
      return state.dialogOptions.defaultPromptText ?? String(defaultValue)
    }
    state.dialogHandlerInstalled = true
    state.nativeDialogs = native
    return true
  }

  const drain = (target) => target.splice(0, target.length)
  window.__cogniaAgentDebug = Object.freeze({
    version: 2,
    capabilities,
    snapshot,
    inspect,
    act,
    keyboard,
    mouse,
    serialize,
    installDialogHandler,
    getDialogs: () => [...state.dialogs],
    clearDialogs: () => {
      state.dialogs.length = 0
      return true
    },
    addNetworkRoute: (pattern, response) => {
      state.networkRoutes.set(String(pattern), response || {})
      return true
    },
    removeNetworkRoute: (pattern) => state.networkRoutes.delete(String(pattern)),
    clearNetworkRoutes: () => {
      state.networkRoutes.clear()
      return true
    },
    getNetworkRequests: () => [...state.network],
    clearNetworkRequests: () => {
      state.network.length = 0
      return true
    },
    drainConsole: () => drain(state.console),
    drainNetwork: () => drain(state.network),
    health: () => ({
      version: 2,
      readyState: document.readyState,
      url: location.href,
      generation: state.generation,
      pendingRequests: state.pendingRequests,
      capabilities,
    }),
  })
})()
