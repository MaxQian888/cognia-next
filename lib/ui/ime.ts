/**
 * Whether a keydown belongs to an IME composition rather than to the field.
 *
 * Typing Chinese, Japanese or Korean goes through an input method: the Enter
 * that picks a candidate is a composition keystroke, not "submit". A field
 * that saves, renames or sends on Enter without asking this commits a
 * half-typed word (or the raw pinyin) the moment the user confirms it.
 *
 * `isComposing` alone is not enough on WebKit — Safari, and so the Tauri
 * macOS webview — which reports the confirming Enter after `compositionend`
 * with `isComposing: false` but the legacy `keyCode` 229 ("IME is processing
 * this key"). Checking both is the standard, engine-independent test.
 *
 * Accepts a React synthetic event (reads `nativeEvent`) or a DOM
 * `KeyboardEvent`.
 */
export interface ImeKeyEventLike {
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}

export const IME_PROCESS_KEY_CODE = 229

export function isImeComposing(event: ImeKeyEventLike): boolean {
  const native = event.nativeEvent ?? event
  if (native.isComposing || event.isComposing) return true
  return (native.keyCode ?? event.keyCode) === IME_PROCESS_KEY_CODE
}
