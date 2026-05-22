# Cognia zsh shell integration.
#
# Hooks `precmd` / `preexec` via zsh's add-zsh-hook framework and decorates
# `PROMPT` with prompt-start (A) and prompt-end (B) markers. The shim at
# the user's effective `$ZDOTDIR` (created by
# `src-tauri/src/terminal/integration.rs::build_zsh`) re-sources their
# original `.zshrc` before invoking this file, so nothing user-visible is
# lost.

if [[ -z "$COGNIA_TERM_NONCE" ]]; then
  return 0
fi

__cognia_term_emit() {
  printf '\033]633;%s;%s\a' "$1" "$COGNIA_TERM_NONCE"
}

__cognia_term_emit_with() {
  printf '\033]633;%s;%s;%s\a' "$1" "$COGNIA_TERM_NONCE" "$2"
}

__cognia_term_preexec() {
  __cognia_term_emit C
}

__cognia_term_precmd() {
  local last_exit=$?
  __cognia_term_emit_with D "$last_exit"
  __cognia_term_emit_with P "Cwd=$PWD"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __cognia_term_precmd
add-zsh-hook preexec __cognia_term_preexec

# %{...%} brackets non-printing prompt escapes — zsh's equivalent of
# bash's \[...\]. Required so the line editor's column math stays correct.
PROMPT=$'%{\033]633;A;'${COGNIA_TERM_NONCE}$'\a%}'${PROMPT}$'%{\033]633;B;'${COGNIA_TERM_NONCE}$'\a%}'
