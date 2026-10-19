;(() => {
  if (window.__cogniaAutomationCore?.version === 3) return

  const normalize = (value) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()

  const cleanRegex = (value) =>
    new RegExp(String(value.regex), String(value.flags || "").replace(/[gy]/g, ""))

  const textMatches = (actual, expected, exact = false) => {
    const haystack = normalize(actual)
    if (expected && typeof expected === "object" && typeof expected.regex === "string") {
      return cleanRegex(expected).test(haystack)
    }
    const needle = normalize(expected)
    return exact
      ? haystack === needle
      : haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
  }

  const directText = (element) =>
    normalize(
      Array.from(element.childNodes || [])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
    )

  const implicitRole = (element) => {
    const explicit = element.getAttribute?.("role")
    if (explicit) return explicit
    const tag = element.tagName.toLowerCase()
    if (tag === "button" || tag === "summary") return "button"
    if (tag === "a" && element.hasAttribute("href")) return "link"
    if (tag === "textarea") return "textbox"
    if (tag === "select") return element.multiple ? "listbox" : "combobox"
    if (/^h[1-6]$/.test(tag)) return "heading"
    if (tag === "img") return "img"
    if (tag === "li") return "listitem"
    if (tag === "option") return "option"
    if (tag === "progress") return "progressbar"
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase()
      if (["button", "submit", "reset"].includes(type)) return "button"
      if (type === "checkbox") return "checkbox"
      if (type === "radio") return "radio"
      if (type === "range") return "slider"
      if (type === "number") return "spinbutton"
      if (type === "search") return "searchbox"
      if (type === "hidden") return null
      return "textbox"
    }
    return null
  }

  const nameFromContents = (element) =>
    Array.from(element.childNodes || [])
      .map((node) => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent || ""
        if (node.nodeType !== Node.ELEMENT_NODE) return ""
        const style = node.ownerDocument.defaultView.getComputedStyle(node)
        if (
          node.getAttribute("aria-hidden") === "true" ||
          node.hasAttribute("hidden") ||
          ["SCRIPT", "STYLE"].includes(node.tagName) ||
          style.display === "none" ||
          style.visibility === "hidden"
        )
          return ""
        return node.getAttribute("aria-label") || node.getAttribute("alt") || nameFromContents(node)
      })
      .join("")

  const accessibleName = (element) => {
    const labelledBy = element.getAttribute?.("aria-labelledby")
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => element.ownerDocument?.getElementById(id)?.textContent || "")
        .join(" ")
      if (normalize(text)) return normalize(text)
    }
    const aria = element.getAttribute?.("aria-label")
    if (normalize(aria)) return normalize(aria)
    if (element.labels?.length) {
      const text = Array.from(element.labels)
        .map((label) => label.textContent || "")
        .join(" ")
      if (normalize(text)) return normalize(text)
    }
    const type = element.getAttribute?.("type")?.toLowerCase()
    if (element.tagName === "INPUT" && ["button", "submit", "reset"].includes(type)) {
      return normalize(element.value)
    }
    return normalize(
      element.getAttribute?.("alt") ||
        element.getAttribute?.("title") ||
        element.getAttribute?.("placeholder") ||
        nameFromContents(element) ||
        ""
    ).slice(0, 240)
  }

  const isVisible = (element) => {
    for (
      let current = element;
      current?.nodeType === Node.ELEMENT_NODE;
      current = current.parentElement || current.getRootNode?.()?.host
    ) {
      const style = current.ownerDocument.defaultView.getComputedStyle(current)
      if (
        current.hasAttribute("hidden") ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      ) {
        return false
      }
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  const isDisabled = (element) =>
    Boolean(
      element.disabled ||
      element.closest?.("[aria-disabled='true']") ||
      element.closest?.("fieldset:disabled")
    )

  const isEditable = (element) => {
    if (isDisabled(element) || element.readOnly) return false
    return (
      ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) ||
      element.isContentEditable ||
      element.getAttribute?.("contenteditable") === "true"
    )
  }

  const setValue = (element, value, append = false) => {
    const view = element.ownerDocument.defaultView
    const next = append ? `${element.value || element.textContent || ""}${value}` : String(value)
    if (element.isContentEditable || element.getAttribute?.("contenteditable") === "true") {
      element.focus()
      element.textContent = next
      element.dispatchEvent(
        new view.InputEvent("input", {
          bubbles: true,
          data: String(value),
          inputType: "insertText",
        })
      )
      return
    }
    const prototype =
      element instanceof view.HTMLTextAreaElement
        ? view.HTMLTextAreaElement.prototype
        : element instanceof view.HTMLSelectElement
          ? view.HTMLSelectElement.prototype
          : view.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
    if (setter) setter.call(element, next)
    else element.value = next
    element.dispatchEvent(new view.Event("input", { bubbles: true }))
    element.dispatchEvent(new view.Event("change", { bubbles: true }))
  }

  const parseKeyChord = (raw) => {
    const parts = String(raw || "").split("+")
    if (!parts.length || parts.some((part) => !part)) throw new Error(`invalid key chord: ${raw}`)
    const options = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
    let key = null
    for (const part of parts) {
      const lower = part.toLowerCase()
      if (["ctrl", "control"].includes(lower)) options.ctrlKey = true
      else if (lower === "shift") options.shiftKey = true
      else if (["alt", "option"].includes(lower)) options.altKey = true
      else if (["meta", "cmd", "command"].includes(lower)) options.metaKey = true
      else if (key !== null) throw new Error(`more than one main key in chord: ${raw}`)
      else key = part.length === 1 ? part : ({ esc: "Escape", return: "Enter" }[lower] ?? part)
    }
    if (key === null) throw new Error(`key chord has no main key: ${raw}`)
    return { ...options, key }
  }

  const sameRect = (left, right) =>
    ["x", "y", "width", "height"].every((key) => Math.abs(left[key] - right[key]) < 0.5)

  const isStable = async (element, { signal, timeout } = {}) => {
    if (signal?.aborted) return false
    const before = element.getBoundingClientRect()
    const completed = await new Promise((resolve) => {
      let frame
      let timer
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        cancelAnimationFrame(frame)
        clearTimeout(timer)
        signal?.removeEventListener("abort", aborted)
        resolve(value)
      }
      const aborted = () => finish(false)
      signal?.addEventListener("abort", aborted, { once: true })
      if (timeout !== undefined)
        timer = setTimeout(() => finish(false), Math.max(0, Math.ceil(timeout)))
      frame = requestAnimationFrame(() => {
        if (settled) return
        frame = requestAnimationFrame(() => finish(true))
      })
    })
    return completed && element.isConnected && sameRect(before, element.getBoundingClientRect())
  }

  const receivesEvents = (element) => {
    const rect = element.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const hitTest = element.ownerDocument?.elementFromPoint
    if (typeof hitTest !== "function") return true
    let hit = hitTest.call(element.ownerDocument, x, y)
    const visitedRoots = new Set()
    while (hit?.shadowRoot && !visitedRoots.has(hit.shadowRoot)) {
      const root = hit.shadowRoot
      visitedRoots.add(root)
      if (typeof root.elementFromPoint !== "function") return false
      hit = root.elementFromPoint(x, y)
    }
    for (
      let current = hit;
      current;
      current = current.parentElement || current.getRootNode?.()?.host
    )
      if (current === element) return true
    return false
  }

  window.__cogniaAutomationCore = Object.freeze({
    version: 3,
    normalize,
    textMatches,
    directText,
    implicitRole,
    accessibleName,
    isVisible,
    isDisabled,
    isEditable,
    setValue,
    parseKeyChord,
    isStable,
    receivesEvents,
  })
})()
