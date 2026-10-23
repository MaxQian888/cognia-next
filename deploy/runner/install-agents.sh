#!/usr/bin/env bash
# Full compatibility installer shared by cognia-server `runtime-full` and
# cognia-runner `full` (ADR-0059 W6 / D9). Exact default versions are owned by
# deploy/bundle, also consumed by the selected Runner target.
#
# Full compatibility only. npm defaults share the bundle's master pins;
# selected Runner builds instead install a pruned integrity-locked npm tree.
# Cursor remains an optional, unverified vendor installer in Full only.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_json="${COGNIA_AGENT_PACKAGE_JSON:-${script_dir}/../bundle/npm/package.json}"
pins_json="${COGNIA_AGENT_PINS_JSON:-${script_dir}/../bundle/agent-versions.json}"

pin() {
  node -e '
    const version = process.argv[3] || JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).dependencies[process.argv[2]];
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
      console.error("install-agents: " + process.argv[2] + " requires an exact version, found " + version);
      process.exit(1);
    }
    process.stdout.write(version);
  ' "$package_json" "$1" "${2:-}"
}

CLAUDE_CODE_VERSION="$(pin @anthropic-ai/claude-code "${CLAUDE_CODE_VERSION:-}")"
CLAUDE_CODE_ACP_VERSION="$(pin @agentclientprotocol/claude-agent-acp "${CLAUDE_CODE_ACP_VERSION:-}")"
CODEX_VERSION="$(pin @openai/codex "${CODEX_VERSION:-}")"
CODEX_ACP_VERSION="$(pin @agentclientprotocol/codex-acp "${CODEX_ACP_VERSION:-}")"
GEMINI_CLI_VERSION="$(pin @google/gemini-cli "${GEMINI_CLI_VERSION:-}")"
COPILOT_CLI_VERSION="$(pin @github/copilot "${COPILOT_CLI_VERSION:-}")"
QWEN_CODE_VERSION="$(pin @qwen-code/qwen-code "${QWEN_CODE_VERSION:-}")"
PI_ACP_VERSION="$(pin pi-acp "${PI_ACP_VERSION:-}")"
PI_CODING_AGENT_VERSION="$(pin @earendil-works/pi-coding-agent "${PI_CODING_AGENT_VERSION:-}")"
OPENCODE_VERSION="$(pin opencode-ai "${OPENCODE_VERSION:-}")"
# Full-only legacy CLI; no runtime selects Cline. npm registry checked 2026-10-21.
CLINE_VERSION="$(pin cline "${CLINE_VERSION:-3.0.73}")"
: "${INSTALL_CURSOR_AGENT:=1}"
: "${INSTALL_KIRO_CLI:=1}"
: "${INSTALL_DROID_CLI:=1}"

npm install -g --ignore-scripts --no-audit --no-fund \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "@agentclientprotocol/claude-agent-acp@${CLAUDE_CODE_ACP_VERSION}" \
  "@openai/codex@${CODEX_VERSION}" \
  "@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}" \
  "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
  "@github/copilot@${COPILOT_CLI_VERSION}" \
  "@qwen-code/qwen-code@${QWEN_CODE_VERSION}" \
  "@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}" \
  "pi-acp@${PI_ACP_VERSION}" \
  "opencode-ai@${OPENCODE_VERSION}" \
  "cline@${CLINE_VERSION}"

# npm 11 requires an explicit script policy, including global rebuilds.
# Rebuild only the two native launcher installers owned by the master pins;
# transitive package scripts stay disabled rather than receiving blanket trust.
allowed_scripts=()
while IFS= read -r package; do
  allowed_scripts+=("$package")
done < <(node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); for(const name of Object.keys(p.installScripts ?? {})) console.log(name)' "$pins_json")
if [ "${#allowed_scripts[@]}" -gt 0 ]; then
  allow_policy="$(IFS=,; printf '%s' "${allowed_scripts[*]}")"
  npm rebuild -g --foreground-scripts --allow-scripts="$allow_policy" "${allowed_scripts[@]}"
fi

if [ "${INSTALL_CURSOR_AGENT}" = "1" ]; then
  # Cursor's CLI has no npm distribution; its installer drops `cursor-agent`
  # into ~/.local/bin. Tolerate failure — the vendor endpoint is outside our
  # control and every other agent remains usable. The install tree must be
  # world-readable: the symlink alone is not enough if the image later runs
  # as a non-root uid.
  if curl -fsSL https://cursor.com/install | bash; then
    ln -sf /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent || true
    chmod -R a+rX /root/.local 2>/dev/null || true
  else
    echo "install-agents: cursor-agent installer failed — continuing without it" >&2
  fi
fi

# Unlike Cursor, Kiro and Droid publish immutable assets with master-pinned
# SHA256 values. Fail the Full build on a failed verification or download.
install_vendor() {
  local runtime="$1" kind="$2" arch artifact url checksum executable
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "install-agents: unsupported architecture $(uname -m)" >&2; return 1 ;;
  esac
  url="$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log(p.runtimes.find(r=>r.id===process.argv[2])[process.argv[3]].assets["glibc-"+process.argv[4]].url)' "$pins_json" "$runtime" "$kind" "$arch")"
  checksum="$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log(p.runtimes.find(r=>r.id===process.argv[2])[process.argv[3]].assets["glibc-"+process.argv[4]].sha256)' "$pins_json" "$runtime" "$kind" "$arch")"
  artifact="$(mktemp)"
  curl -fsSL "$url" -o "$artifact"
  printf '%s  %s\n' "$checksum" "$artifact" | sha256sum -c -
  mkdir -p "/opt/cognia/vendor/$runtime"
  if [ "$kind" = archive ]; then
    tar -xzf "$artifact" -C "/opt/cognia/vendor/$runtime"
    executable="$(find "/opt/cognia/vendor/$runtime" -type f -name "$runtime" -print -quit)"
    test -n "$executable"
  else
    executable="/opt/cognia/vendor/$runtime/$runtime"
    cp "$artifact" "$executable"
  fi
  chmod -R a+rX "/opt/cognia/vendor/$runtime"
  chmod a+x "$executable"
  ln -sf "$executable" "/usr/local/bin/$runtime"
  "$executable" --version
  rm -f "$artifact"
}

if [ "${INSTALL_KIRO_CLI}" = "1" ]; then install_vendor kiro-cli archive; fi
if [ "${INSTALL_DROID_CLI}" = "1" ]; then install_vendor droid binary; fi

# Keep old ACP npx package names working through the canonical frozen binary.
# The adapter is copied by both Full Dockerfiles; standalone script users may
# retain native npm's dispatch by omitting that adapter.
shim_script="${COGNIA_AGENT_SHIM_SCRIPT:-${script_dir}/install-selected.mjs}"
if [ -f "$shim_script" ]; then
  COGNIA_GLOBAL_NODE_MODULES="$(npm root -g)" node "$shim_script" install-full "$pins_json" "$package_json"
fi

npm cache clean --force
