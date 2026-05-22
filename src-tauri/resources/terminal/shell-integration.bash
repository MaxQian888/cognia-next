# Cognia bash shell integration.
#
# Emits OSC 633 sequences (`ESC ] 633 ; <C> ; <nonce> [; <arg>] BEL`) that
# `src-tauri/src/terminal/osc633.rs::Osc633Parser` parses. The renderer
# uses the resulting `IntegrationEvent`s to decorate tabs (running ⇄
# exit 0 ⇄ exit non-zero) and update the per-tab cwd badge.
#
# We're invoked through `bash --rcfile <this-script>`, which replaces
# `~/.bashrc` as the interactive rc. The first block below re-sources the
# user's rc files so their customisations still apply.

if [ -f /etc/bash.bashrc ]; then
  . /etc/bash.bashrc
fi
if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

# No nonce → nothing to gate sequences on; bail silently. The user still
# gets a normal interactive shell.
if [ -z "$COGNIA_TERM_NONCE" ]; then
  return 2>/dev/null || true
fi

__cognia_term_emit() {
  # $1 = command letter (A/B/C/D/P)
  printf '\033]633;%s;%s\a' "$1" "$COGNIA_TERM_NONCE"
}

__cognia_term_emit_with() {
  # $1 = command letter, $2 = extra payload (exit code, Cwd=…)
  printf '\033]633;%s;%s;%s\a' "$1" "$COGNIA_TERM_NONCE" "$2"
}

# Reentry guard: the DEBUG trap fires for every simple command, including
# commands inside PROMPT_COMMAND. Without the flag we'd emit a stray
# `C` for each function call the precmd runs.
__cognia_term_in_prompt=0

__cognia_term_preexec() {
  if [ "$__cognia_term_in_prompt" = "1" ]; then return; fi
  __cognia_term_emit C
}

__cognia_term_precmd() {
  local last_exit=$?
  __cognia_term_in_prompt=1
  __cognia_term_emit_with D "$last_exit"
  __cognia_term_emit_with P "Cwd=$PWD"
  __cognia_term_in_prompt=0
}

trap '__cognia_term_preexec' DEBUG

if [ -n "$PROMPT_COMMAND" ]; then
  PROMPT_COMMAND="__cognia_term_precmd; $PROMPT_COMMAND"
else
  PROMPT_COMMAND="__cognia_term_precmd"
fi

# Decorate PS1 with the prompt-start (A) and prompt-end (B) markers.
# `\[...\]` brackets the non-printing escapes so bash's line-editor still
# computes the correct prompt width.
__cognia_term_ps1_a=$'\033]633;A;'${COGNIA_TERM_NONCE}$'\a'
__cognia_term_ps1_b=$'\033]633;B;'${COGNIA_TERM_NONCE}$'\a'
PS1="\\[${__cognia_term_ps1_a}\\]${PS1}\\[${__cognia_term_ps1_b}\\]"

unset __cognia_term_ps1_a
unset __cognia_term_ps1_b
