;(() => {
  if (window.__cogniaAgentDebug?.version === 3) return
  const legacyAgentDebug = window.__cogniaAgentDebug || null

  const core = window.__cogniaAutomationCore
  if (!core) throw new Error("Cognia automation core is unavailable")

  const MAX_EVENTS = 500
  const MAX_NODES = 500
  const MAX_FRAME_DEPTH = 8
  const state = {
    documentId:
      globalThis.crypto?.randomUUID?.() ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    generation: 0,
    refs: new Map(),
    console: [],
    network: [],
    consoleSequence: 0,
    networkSequence: 0,
    pendingRequests: 0,
    networkRoutes: new Map(),
    dialogs: [],
    dialogOptions: { defaultConfirm: true, defaultPromptText: "" },
    dialogHandlerInstalled: false,
    mouse: { x: 0, y: 0, buttons: 0 },
    modifiers: new Set(),
  }

  const capabilities = Object.freeze({
    apiVersion: 3,
    transport: "tauri-webview-eval",
    locatorAutoWait: true,
    locatorStrictness: true,
    actionability: ["attached", "visible", "enabled", "editable"],
    stablePositionCheck: true,
    receivesEventsCheck: true,
    semanticLocators: true,
    atomicLocators: true,
    openShadowDom: true,
    sameOriginFrames: true,
    shadowDomScope: "open-only",
    frameScope: "same-origin-only",
    navigationIdentity: "document-id-and-url",
    multiWindow: true,
    nativeScreenshot: true,
    consoleCapture: "buffered",
    diagnosticCursors: true,
    networkCapture: "fetch-and-xhr",
    networkMocking: "fetch-only",
    dialogs: true,
    fileUpload: true,
    keyboard: "dom-events",
    mouse: "dom-events",
    trustedEvents: false,
    syntheticInputLimits: ["untrusted-events", "no-native-hit-testing", "no-cdp"],
    video: false,
    cdp: false,
  })

  const pushBounded = (target, entry) => {
    target.push(entry)
    if (target.length > MAX_EVENTS) target.splice(0, target.length - MAX_EVENTS)
  }

  const pushDiagnostic = (target, sequenceKey, entry) => {
    state[sequenceKey] += 1
    pushBounded(target, { id: state[sequenceKey], ...entry })
  }

  const readEvents = (target, currentSequence, after = 0, limit = MAX_EVENTS) => {
    const cursor = Number.isSafeInteger(Number(after)) && Number(after) >= 0 ? Number(after) : 0
    const boundedLimit = Math.max(1, Math.min(Number(limit) || MAX_EVENTS, MAX_EVENTS))
    const oldestId = target[0]?.id ?? cursor + 1
    const entries = target.filter((entry) => entry.id > cursor).slice(0, boundedLimit)
    return {
      entries: [...entries],
      nextCursor: entries.at(-1)?.id ?? Math.max(cursor, currentSequence),
      dropped: Math.max(0, oldestId - cursor - 1),
    }
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
  const normalize = core.normalize
  const textMatches = core.textMatches
  const currentPendingRequests = () =>
    Number(legacyAgentDebug?.health?.()?.pendingRequests ?? state.pendingRequests)

  if (!legacyAgentDebug) {
    for (const level of ["debug", "info", "log", "warn", "error"]) {
      const original = console[level]?.bind(console)
      if (!original) continue
      console[level] = (...args) => {
        pushDiagnostic(state.console, "consoleSequence", {
          timestamp: timestamp(),
          level,
          args: serialize(args),
        })
        original(...args)
      }
    }

    window.addEventListener("error", (event) => {
      pushDiagnostic(state.console, "consoleSequence", {
        timestamp: timestamp(),
        level: "error",
        args: [
          {
            message: event.message,
            source: event.filename,
            line: event.lineno,
            column: event.colno,
          },
        ],
      })
    })
    window.addEventListener("unhandledrejection", (event) => {
      pushDiagnostic(state.console, "consoleSequence", {
        timestamp: timestamp(),
        level: "error",
        args: [{ type: "unhandledrejection", reason: serialize(event.reason) }],
      })
    })
  }

  const syncLegacyDiagnostics = (method, target, sequenceKey) => {
    if (typeof legacyAgentDebug?.[method] !== "function") return
    for (const entry of legacyAgentDebug[method]() || []) pushDiagnostic(target, sequenceKey, entry)
  }

  const globMatches = (url, pattern) => {
    if (!pattern) return false
    if (!pattern.includes("*")) return url.includes(pattern)
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
    return new RegExp(`^${escaped}$`).test(url) || new RegExp(escaped).test(url)
  }

  const originalFetch = window.fetch?.bind(window)
  if (originalFetch && !legacyAgentDebug) {
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
        pushDiagnostic(state.network, "networkSequence", {
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
        pushDiagnostic(state.network, "networkSequence", {
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
  if (NativeXhr && !legacyAgentDebug) {
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
        pushDiagnostic(state.network, "networkSequence", {
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

  const implicitRole = core.implicitRole
  const accessibleName = core.accessibleName
  const isVisible = core.isVisible
  const isDisabled = core.isDisabled
  const isEditable = core.isEditable

  const queryAcrossRoots = (
    root,
    selector,
    depth = 0,
    result = [],
    scope = { limitations: [] }
  ) => {
    if (depth > MAX_FRAME_DEPTH) {
      scope.limitations.push("maximum frame/shadow depth exceeded")
      return result
    }
    let elements = []
    try {
      elements = Array.from(root.querySelectorAll(selector))
    } catch (error) {
      throw new Error(`invalid selector: ${String(error)}`)
    }
    result.push(...elements)
    let all = []
    try {
      all = Array.from(root.querySelectorAll("*"))
    } catch {
      return result
    }
    for (const element of all) {
      if (element.shadowRoot)
        queryAcrossRoots(element.shadowRoot, selector, depth + 1, result, scope)
      if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
        try {
          if (element.contentDocument)
            queryAcrossRoots(element.contentDocument, selector, depth + 1, result, scope)
          else scope.limitations.push("cross-origin frame")
        } catch {
          scope.limitations.push("cross-origin frame")
        }
      }
    }
    return Array.from(new Set(result))
  }

  const descendants = (root, scope) => queryAcrossRoots(root, "*", 0, [], scope)
  const applyStep = (roots, step, scope) => {
    let candidates = []
    for (const root of roots) {
      if (step.kind === "css") {
        candidates.push(...queryAcrossRoots(root, step.selector, 0, [], scope))
      } else if (step.kind === "attribute") {
        candidates.push(...descendants(root, scope))
      } else {
        candidates.push(...descendants(root, scope))
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
    } else if (step.kind === "attribute") {
      candidates = candidates.filter((element) =>
        textMatches(element.getAttribute(step.name), step.value, step.exact)
      )
    }
    return candidates
  }

  const resolveQuery = (query, root = document, scope = { limitations: [] }) => {
    if (query?.kind === "filtered")
      return applyFilters(resolveQuery(query.query, root, scope), query.filters, scope)
    if (query?.kind === "and") {
      const right = new Set(resolveQuery(query.right, root, scope))
      return resolveQuery(query.left, root, scope).filter((element) => right.has(element))
    }
    if (query?.kind === "or") {
      return Array.from(
        new Set([
          ...resolveQuery(query.left, root, scope),
          ...resolveQuery(query.right, root, scope),
        ])
      )
    }
    const steps = query?.steps?.length ? query.steps : []
    let roots = [root]
    for (const step of steps) roots = applyStep(roots, step, scope)
    return roots
  }

  const applyFilters = (elements, filters = [], scope = { limitations: [] }) =>
    elements.filter((element) =>
      filters.every((filter) => {
        const text = `${accessibleName(element)} ${normalize(element.textContent)}`
        if (filter.kind === "hasText") return textMatches(text, filter.value)
        if (filter.kind === "hasNotText") return !textMatches(text, filter.value)
        if (filter.kind === "visible") return isVisible(element) === Boolean(filter.value)
        if (filter.kind === "has")
          return (
            applyFilters(resolveQuery(filter.query, element, scope), filter.filters, scope).length >
            0
          )
        if (filter.kind === "hasNot")
          return (
            applyFilters(resolveQuery(filter.query, element, scope), filter.filters, scope)
              .length === 0
          )
        return true
      })
    )

  const resolveCandidates = (options = {}, scope = { limitations: [] }) => {
    const query =
      options.query?.steps?.length || options.query?.kind
        ? options.query
        : options.selector
          ? { steps: [{ kind: "css", selector: options.selector }] }
          : options.role
            ? {
                steps: [
                  {
                    kind: "role",
                    role: options.role,
                    name: options.name,
                    exact: options.nameExact,
                  },
                ],
              }
            : options.name
              ? { steps: [{ kind: "text", text: options.name, exact: options.nameExact }] }
              : {
                  steps: [
                    {
                      kind: "css",
                      selector:
                        "button,a[href],input,textarea,select,[role],[contenteditable='true'],h1,h2,h3,h4,h5,h6,img,li,p",
                    },
                  ],
                }
    return applyFilters(resolveQuery(query, document, scope), options.filters, scope)
  }

  const indexed = (elements, index) => {
    if (index == null) return elements
    const resolved = index < 0 ? elements.length + index : index
    return elements[resolved] ? [elements[resolved]] : []
  }

  const nodeFor = (element, ref = null) => {
    const rect = element.getBoundingClientRect()
    const role = implicitRole(element)
    const node = {
      ...(ref ? { ref } : {}),
      role: role || "text",
      name: accessibleName(element),
      tag: element.tagName.toLowerCase(),
      text: normalize(element.textContent).slice(0, 500),
      visible: isVisible(element),
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
    return node
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
      const role = implicitRole(element)
      const interactive = Boolean(
        role && !["heading", "img", "listitem", "paragraph"].includes(role)
      )
      if (!interactive && !options.includeText && role !== "heading" && !options.query) continue
      if (role === "listitem" && options.includeText && !core.directText(element)) continue
      if (!role && options.includeText && !core.directText(element)) continue
      const ref = `g${generation}e${nodes.length + 1}`
      state.refs.set(ref, element)
      nodes.push(nodeFor(element, ref))
    }
    return {
      generation,
      documentId: state.documentId,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      nodes,
      truncated: nodes.length >= MAX_NODES,
      pendingRequests: currentPendingRequests(),
    }
  }

  const refElement = (ref) => {
    const element = state.refs.get(ref)
    if (!element || !element.isConnected) throw new Error(`stale or unknown element ref: ${ref}`)
    return element
  }

  const ariaSnapshot = (root, options = {}) => {
    const lines = []
    const maxDepth = Math.max(0, Math.min(Number(options.depth ?? 5), 12))
    const visit = (element, depth) => {
      if (depth > maxDepth || !isVisible(element)) return
      const role = implicitRole(element)
      const name = accessibleName(element)
      const direct = core.directText(element)
      if (role || direct) {
        const label = name || direct
        const box = options.boxes ? element.getBoundingClientRect() : null
        lines.push(
          `${"  ".repeat(depth)}- ${role || "text"}${label ? ` ${JSON.stringify(label)}` : ""}${
            box
              ? ` [box=${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}]`
              : ""
          }`
        )
      }
      for (const child of element.children || []) visit(child, depth + 1)
      if (element.shadowRoot?.mode === "open")
        for (const child of element.shadowRoot.children || []) visit(child, depth + 1)
    }
    visit(root, 0)
    return lines.join("\n")
  }

  const inspectElement = async (element, operation, args = {}) => {
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
      case "ariaSnapshot":
        return ariaSnapshot(element, args.options)
      default:
        throw new Error(`unsupported inspection: ${operation}`)
    }
  }

  const inspect = (ref, operation, args = {}) => inspectElement(refElement(ref), operation, args)

  const actElement = async (element, action, args = {}) => {
    if (
      isDisabled(element) &&
      !["focus", "blur", "scrollIntoView", "dispatchEvent"].includes(action)
    )
      throw new Error("element is disabled")
    let value = null
    switch (action) {
      case "click":
        element.click()
        break
      case "dblclick":
        for (const detail of [1, 2]) {
          for (const type of ["mousedown", "mouseup", "click"])
            element.dispatchEvent(
              new MouseEvent(type, { bubbles: true, cancelable: true, view: window, detail })
            )
        }
        element.dispatchEvent(
          new MouseEvent("dblclick", {
            bubbles: true,
            cancelable: true,
            view: window,
            detail: 2,
          })
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
        core.setValue(element, String(args.value ?? ""), false)
        break
      case "type":
        element.focus()
        core.setValue(element, String(args.value ?? ""), true)
        break
      case "press": {
        const chord = core.parseKeyChord(args.key || "Enter")
        element.focus()
        const event = { ...chord, bubbles: true, cancelable: true }
        element.dispatchEvent(new KeyboardEvent("keydown", event))
        if (String(chord.key).length === 1 && !chord.ctrlKey && !chord.altKey && !chord.metaKey)
          element.dispatchEvent(new KeyboardEvent("keypress", event))
        element.dispatchEvent(new KeyboardEvent("keyup", event))
        break
      }
      case "check":
      case "uncheck": {
        const desired = action === "check"
        if (Boolean(element.checked) !== desired) element.click()
        if (Boolean(element.checked) !== desired)
          throw new Error(`${action} did not reach the requested checked state`)
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
        if (
          requested.some(
            (requestedValue) =>
              !Array.from(element.options || []).some(
                (option) =>
                  option.selected &&
                  (option.value === requestedValue || option.label === requestedValue)
              )
          )
        )
          throw new Error("select did not match every requested option")
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
    if (!["click", "dblclick"].includes(action))
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { action, value }
  }

  const act = async (ref, action, args = {}) => ({
    ...(await actElement(refElement(ref), action, args)),
    ref,
  })

  const locatorError = (code, error, retryable = false) => ({
    ok: false,
    code,
    error,
    retryable,
  })

  const locator = async (request = {}) => {
    const scope = { limitations: [] }
    let elements = applyFilters(
      resolveQuery(request.query, document, scope),
      request.filters,
      scope
    )
    elements = indexed(elements, request.index)
    if (request.strict !== false && request.index == null && elements.length > 1) {
      return locatorError(
        "strict_mode_violation",
        `strict locator resolved to ${elements.length} elements`
      )
    }
    const element = elements[0]
    if (request.operation === "query") {
      return { ok: true, nodes: elements.slice(0, MAX_NODES).map((entry) => nodeFor(entry)) }
    }
    if (!element && scope.limitations.length)
      return locatorError(
        "unsupported_scope",
        `${Array.from(new Set(scope.limitations)).join(", ")} is unsupported by synthetic Tauri input; use Windows CDP or the configured remote-Chromium browser backend`
      )
    if (!element) return locatorError("not_found", "locator did not resolve", true)

    if (request.operation === "inspect") {
      try {
        return {
          ok: true,
          value: await inspectElement(element, request.name, request.args),
          documentId: state.documentId,
        }
      } catch (error) {
        return locatorError("inspection_failed", String(error))
      }
    }

    if (request.operation === "action") {
      const requirements = request.requirements || {}
      const options = request.options || {}
      const previousDocumentId = state.documentId
      const previousUrl = location.href
      try {
        if (options.scroll !== "none")
          element.scrollIntoView?.({ block: "center", inline: "center" })
        if (options.force !== true) {
          if (requirements.visible && !isVisible(element))
            return locatorError("not_visible", "element is not visible", true)
          if (requirements.enabled && isDisabled(element))
            return locatorError("not_enabled", "element is disabled", true)
          if (requirements.editable && !isEditable(element))
            return locatorError("not_editable", "element is not editable", true)
          if (requirements.stable && !(await core.isStable(element)))
            return locatorError("not_stable", "element position is not stable", true)
          if (requirements.receivesEvents && !core.receivesEvents(element))
            return locatorError("not_receives_events", "element does not receive events", true)
        }
        if (options.trial)
          return {
            ok: true,
            value: null,
            documentId: state.documentId,
            previousDocumentId,
            previousUrl,
            url: location.href,
            navigation: false,
          }
        const result = await actElement(element, request.name, request.args)
        return {
          ok: true,
          value: result.value ?? result,
          documentId: state.documentId,
          previousDocumentId,
          previousUrl,
          url: location.href,
          navigation: state.documentId !== previousDocumentId || location.href !== previousUrl,
        }
      } catch (error) {
        return locatorError("action_failed", String(error))
      }
    }
    return locatorError("unsupported_locator_operation", String(request.operation))
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
      if ("value" in element || element.isContentEditable) core.setValue(element, text, true)
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
    if (typeof legacyAgentDebug?.installDialogHandler === "function")
      return legacyAgentDebug.installDialogHandler(options)
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
    version: 3,
    capabilities,
    snapshot,
    locator,
    inspect,
    act,
    keyboard,
    mouse,
    serialize,
    installDialogHandler,
    getDialogs: () =>
      typeof legacyAgentDebug?.getDialogs === "function"
        ? legacyAgentDebug.getDialogs()
        : [...state.dialogs],
    clearDialogs: () => {
      if (typeof legacyAgentDebug?.clearDialogs === "function")
        return legacyAgentDebug.clearDialogs()
      state.dialogs.length = 0
      return true
    },
    addNetworkRoute: (pattern, response) => {
      if (typeof legacyAgentDebug?.addNetworkRoute === "function")
        return legacyAgentDebug.addNetworkRoute(pattern, response)
      state.networkRoutes.set(String(pattern), response || {})
      return true
    },
    removeNetworkRoute: (pattern) =>
      typeof legacyAgentDebug?.removeNetworkRoute === "function"
        ? legacyAgentDebug.removeNetworkRoute(pattern)
        : state.networkRoutes.delete(String(pattern)),
    clearNetworkRoutes: () => {
      if (typeof legacyAgentDebug?.clearNetworkRoutes === "function")
        return legacyAgentDebug.clearNetworkRoutes()
      state.networkRoutes.clear()
      return true
    },
    getNetworkRequests: () =>
      typeof legacyAgentDebug?.getNetworkRequests === "function"
        ? legacyAgentDebug.getNetworkRequests()
        : [...state.network],
    clearNetworkRequests: () => {
      if (typeof legacyAgentDebug?.clearNetworkRequests === "function")
        return legacyAgentDebug.clearNetworkRequests()
      state.network.length = 0
      return true
    },
    drainConsole: () => drain(state.console),
    drainNetwork: () => drain(state.network),
    readConsole: (after, limit) => {
      syncLegacyDiagnostics("drainConsole", state.console, "consoleSequence")
      return readEvents(state.console, state.consoleSequence, after, limit)
    },
    readNetwork: (after, limit) => {
      syncLegacyDiagnostics("drainNetwork", state.network, "networkSequence")
      return readEvents(state.network, state.networkSequence, after, limit)
    },
    health: () => ({
      version: 3,
      readyState: document.readyState,
      url: location.href,
      documentId: state.documentId,
      generation: state.generation,
      pendingRequests: currentPendingRequests(),
      capabilities,
    }),
  })
})()
