;(() => {
  if (window.__cogniaAutomationCore?.version === 1) return

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
      if (type === "hidden") return null
      return "textbox"
    }
    return null
  }

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
        element.textContent ||
        ""
    ).slice(0, 240)
  }

  const isVisible = (element) => {
    for (
      let current = element;
      current instanceof Element;
      current = current.parentElement || current.getRootNode?.()?.host
    ) {
      const style = getComputedStyle(current)
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
    const next = append ? `${element.value || element.textContent || ""}${value}` : String(value)
    if (element.isContentEditable || element.getAttribute?.("contenteditable") === "true") {
      element.focus()
      element.textContent = next
      element.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: String(value), inputType: "insertText" })
      )
      return
    }
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
    if (setter) setter.call(element, next)
    else element.value = next
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
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

  const isStable = async (element) => {
    const before = element.getBoundingClientRect()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return element.isConnected && sameRect(before, element.getBoundingClientRect())
  }

  const receivesEvents = (element) => {
    const rect = element.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const hitTest = element.ownerDocument?.elementFromPoint
    if (typeof hitTest !== "function") return true
    const hit = hitTest.call(element.ownerDocument, x, y)
    return Boolean(hit && (hit === element || element.contains(hit)))
  }

  window.__cogniaAutomationCore = Object.freeze({
    version: 1,
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
