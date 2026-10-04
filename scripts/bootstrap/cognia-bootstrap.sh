#!/usr/bin/env bash
# Native standalone Bash Agent. Requires Bash 3.2+, jq 1.6+, curl and Unix tools.
# No application runtime, compiled Cognia binary, Python, Node or remote sourcing.
# jq programs and child-shell commands intentionally defer dollar expansion.
# shellcheck disable=SC2016,SC2329
set -o pipefail
umask 077

MODE=${1:-help}
[[ $# -gt 0 ]] && shift
CONFIG_PATH='' CONFIG_ENV='' WORKSPACE='' TASK='' TASK_FILE='' SESSION='' STATE='' OUTPUT=bootstrap.json
INVOCATION_CWD=$PWD
HAS_TASK=0 HAS_TASK_FILE=0 NO_SESSION=0 FORCE=0 QUIET=0 NONINTERACTIVE=0 THEN=0
CLI_MODEL='' CLI_BASE='' CLI_ENV=COGNIA_BOOTSTRAP_API_KEY CLI_ENV_SET=0 CLI_MAX='' CLI_SYSTEM='' CLI_STREAM=''
PROVIDER='' PRESET='' RECIPE='' JSON_OUTPUT=0 MODELS_PATH=/models
PRESET_FILES=()
CONTEXT_FILES=()
CONTEXT_PENDING=0
OVERRIDES=() HANDOFF=() CHILD_ENV=() SHELL_ARGS=() LOCKS=()
ERROR='' STEPS=0 CANCELLED=0 TERMINATED=0 ACTIVE_PID='' WORKER_PID='' WORKER_OPEN=0
DEADLINE=0 TMP='' HISTORY='' CHECKS='[]' REUSED=false

usage() {
  cat <<'HELP'
Native standalone Cognia Agent (Bash + curl + jq)
Usage: cognia-bootstrap.sh configure [--output FILE] [--non-interactive]
       cognia-bootstrap.sh run|chat|init|doctor|models [--config FILE] [options]
       cognia-bootstrap.sh presets [--json]
       cognia-bootstrap.sh init --config-env NAME --then -- PROGRAM ARG...
Options: --provider ID --preset ID --recipe ID --preset-file FILE (repeatable)
         --json (presets/doctor/models) --models-path /models
         --cwd PATH --task TEXT|- | --task-file FILE --context-file FILE (repeatable)
         --model ID --base-url URL --api-key-env NAME
         --max-tokens N --system-prompt TEXT --stream true|false
         --set dotted.path=JSON|/json/pointer=JSON --session FILE --no-session
         --quiet --state FILE (init) --force (init/configure)
Chat commands: /status /model [ID] /models /history [N] /export PATH
               /save-config PATH /compact /clear /help /exit /quit
HELP
}

die() { ERROR=$1; return 1; }
is_integer() { [[ $1 =~ ^[0-9]+$ ]]; }
stop_pid() {
  [[ -n $1 ]] || return 0
  kill -TERM -- "-$1" 2>/dev/null || kill -TERM "$1" 2>/dev/null || :
  sleep 0.05
  kill -KILL -- "-$1" 2>/dev/null || kill -KILL "$1" 2>/dev/null || :
  wait "$1" 2>/dev/null || :
}
stop_shell() {
  stop_pid "$WORKER_PID"
  WORKER_PID=
  if [[ $WORKER_OPEN == 1 ]]; then exec 7>&-; WORKER_OPEN=0; fi
}
interrupt() { CANCELLED=1; stop_pid "$ACTIVE_PID"; ACTIVE_PID=; stop_shell; }
terminate() { TERMINATED=1; interrupt; }
cleanup() {
  local lock
  stop_pid "$ACTIVE_PID"
  stop_shell
  for lock in "${LOCKS[@]}"; do
    [[ -d $lock && ! -L $lock && $(cat "$lock/pid" 2>/dev/null) == "$$" ]] || continue
    rm -f "$lock/pid"; rmdir "$lock" 2>/dev/null || :
  done
  [[ -z $TMP || ! -d $TMP ]] || rm -rf "$TMP"
}
trap interrupt INT
trap terminate TERM
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case $1 in
    --help|-h) usage; exit 0;;
    --version) printf 'cognia-bootstrap.sh 0.1.0\n'; exit 0;;
    --json) JSON_OUTPUT=1; shift;;
    --no-session) NO_SESSION=1; shift;;
    --force) FORCE=1; shift;;
    --quiet) QUIET=1; shift;;
    --non-interactive) NONINTERACTIVE=1; shift;;
    --then) THEN=1; shift;;
    --) shift; HANDOFF=("$@"); break;;
    --config|--config-env|--cwd|--task|--task-file|--context-file|--session|--state|--output|--model|--base-url|--api-key-env|--max-tokens|--system-prompt|--stream|--set|--provider|--preset|--recipe|--preset-file|--models-path)
      [[ $# -ge 2 ]] || { printf 'Missing option value.\n' >&2; exit 2; }
      case $1 in
        --config) CONFIG_PATH=$2;; --config-env) CONFIG_ENV=$2;; --cwd) WORKSPACE=$2;;
        --task) TASK=$2; HAS_TASK=1;; --session) SESSION=$2;; --state) STATE=$2;; --output) OUTPUT=$2;;
        --task-file) TASK_FILE=$2; HAS_TASK_FILE=1;; --context-file) CONTEXT_FILES+=("$2");;
        --model) CLI_MODEL=$2;; --base-url) CLI_BASE=$2;; --api-key-env) CLI_ENV=$2; CLI_ENV_SET=1;;
        --max-tokens) CLI_MAX=$2;; --system-prompt) CLI_SYSTEM=$2;; --stream) CLI_STREAM=$2;;
        --provider) PROVIDER=$2;; --preset) PRESET=$2;; --recipe) RECIPE=$2;;
        --preset-file) PRESET_FILES+=("$2");; --models-path) MODELS_PATH=$2;;
        --set) OVERRIDES+=("$2");;
      esac
      shift 2;;
    *) printf 'Unknown option. Use --help.\n' >&2; exit 2;;
  esac
done
case $MODE in help|--help|-h) usage; exit 0;; --version) printf 'cognia-bootstrap.sh 0.1.0\n'; exit 0;; run|chat|init|configure|presets|doctor|models) ;; *) usage >&2; exit 2;; esac
for dependency in jq curl awk sed mktemp mkfifo env od tr head tail wc stat date; do
  command -v "$dependency" >/dev/null 2>&1 || { printf 'Required utility unavailable: %s\n' "$dependency" >&2; exit 2; }
done
if command -v sha256sum >/dev/null 2>&1; then HASH=(sha256sum); else HASH=(openssl dgst -sha256); fi
TMP=$(mktemp -d "${TMPDIR:-/tmp}/cognia-bootstrap.XXXXXXXX") || exit 2
HISTORY=$TMP/history.json
printf '[]\n' > "$HISTORY"
printf '{}\n' > "$TMP/config.json"

cat > "$TMP/presets.json" <<'PRESET_CATALOG'
{
  "version": 1,
  "providers": [
    {"id":"deepseek","label":"DeepSeek","config":{"model":{"baseUrl":"https://api.deepseek.com","model":"deepseek-flash","apiKeyEnv":"DEEPSEEK_API_KEY","auth":"bearer"}}},
    {"id":"openai","label":"OpenAI","config":{"model":{"baseUrl":"https://api.openai.com/v1","model":"gpt-4.1-mini","apiKeyEnv":"OPENAI_API_KEY","auth":"bearer"}}},
    {"id":"openrouter","label":"OpenRouter","config":{"model":{"baseUrl":"https://openrouter.ai/api/v1","model":"openrouter/auto","apiKeyEnv":"OPENROUTER_API_KEY","auth":"bearer"}}},
    {"id":"ollama","label":"Ollama","config":{"model":{"baseUrl":"http://localhost:11434/v1","model":"local-model","apiKeyEnv":"COGNIA_BOOTSTRAP_API_KEY","auth":"none"}}},
    {"id":"lmstudio","label":"LM Studio","config":{"model":{"baseUrl":"http://localhost:1234/v1","model":"local-model","apiKeyEnv":"COGNIA_BOOTSTRAP_API_KEY","auth":"none"}}}
  ],
  "presets": [
    {"id":"coding","config":{"task":"Inspect the workspace, implement the requested change, and run focused verification.","tools":{"shell":true,"editor":true},"limits":{"maxSteps":48},"model":{"maxTokens":8192}}},
    {"id":"debug","config":{"task":"Reproduce the reported issue, investigate one hypothesis at a time, fix the root cause, and verify the behavior.","tools":{"shell":true,"editor":true},"limits":{"maxSteps":64},"model":{"maxTokens":8192}}},
    {"id":"chat","config":{"task":"Answer the user's question clearly and accurately. Ask for missing context when necessary.","tools":{"shell":false,"editor":false},"limits":{"maxSteps":8},"model":{"maxTokens":4096}}},
    {"id":"quick","config":{"task":"Complete the requested small task with minimal changes and focused verification.","tools":{"shell":true,"editor":true},"limits":{"maxSteps":12,"totalTimeoutSecs":180},"model":{"maxTokens":2048}}},
    {"id":"explain","config":{"task":"Explain the supplied material with concrete examples and clearly state assumptions. Workspace tools are disabled; ask the user to supply any missing material.","tools":{"shell":false,"editor":false},"limits":{"maxSteps":8},"model":{"maxTokens":8192}}}
  ],
  "recipes": [
    {"id":"node-pnpm","config":{"task":"Initialize the pnpm workspace and resolve failures until the readiness checks pass.","setupCommand":"pnpm install --frozen-lockfile","checks":[{"name":"dependencies","command":"test -d node_modules"}],"reuse":{"inputs":["package.json","pnpm-lock.yaml"],"outputs":["node_modules"]},"limits":{"commandTimeoutSecs":300,"totalTimeoutSecs":900}},"powershell":{"checks":[{"name":"dependencies","command":"if (-not (Test-Path -LiteralPath 'node_modules' -PathType Container)) { throw 'Dependencies are missing' }"}]}},
    {"id":"python-uv","config":{"task":"Initialize the uv project and resolve failures until the readiness checks pass.","setupCommand":"uv sync --frozen","checks":[{"name":"virtualenv","command":"test -x .venv/bin/python && .venv/bin/python --version"}],"reuse":{"inputs":["pyproject.toml","uv.lock"],"outputs":[".venv"]},"limits":{"commandTimeoutSecs":300,"totalTimeoutSecs":900}},"powershell":{"checks":[{"name":"virtualenv","command":"$python = if ($IsWindows) { '.venv/Scripts/python.exe' } else { '.venv/bin/python' }; if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Virtual environment is missing' }; & $python --version"}]}},
    {"id":"rust","config":{"task":"Fetch locked Rust dependencies and resolve failures until the readiness checks pass.","setupCommand":"cargo fetch --locked","checks":[{"name":"compile","command":"cargo check --locked --offline"}],"reuse":{"inputs":["Cargo.toml","Cargo.lock"],"outputs":["target"]},"limits":{"commandTimeoutSecs":300,"totalTimeoutSecs":900}}},
    {"id":"go","config":{"task":"Download Go module dependencies and resolve failures until the readiness checks pass.","setupCommand":"go mod download","checks":[{"name":"modules","command":"go mod verify"}],"reuse":{"inputs":["go.mod","go.sum"],"outputs":[]},"limits":{"commandTimeoutSecs":300,"totalTimeoutSecs":900}}}
  ]
}
PRESET_CATALOG

# jq modules are private invocation files containing original local source.
cat > "$TMP/contract.jq" <<'JQ'
def defaults:
{version:1,task:"Inspect the workspace and complete the requested task.",systemPrompt:null,setupCommand:null,checks:[],secretEnv:[],reuse:{inputs:[],outputs:[]},
 model:{baseUrl:"https://api.deepseek.com",model:"deepseek-chat",apiKeyEnv:"COGNIA_BOOTSTRAP_API_KEY",requestTimeoutSecs:60,stream:false,showThinking:false,maxTokens:null,temperature:null,topP:null,seed:null,reasoningEffort:null,thinking:null,extraBody:{},headers:{},headersEnv:{},auth:"bearer",apiKeyHeader:null,endpointPath:null},
 tools:{shell:true,editor:true,profile:"native",shellExecutable:"/bin/bash",shellArgs:["--noprofile","--norc"],environment:{},maxFileBytes:4194304},
 limits:{maxSteps:32,totalTimeoutSecs:600,commandTimeoutSecs:60,maxOutputBytes:16000,maxContextBytes:128000,maxResponseBytes:1048576},
 context:{contextWindowTokens:1000000,autoCompact:true,compactThresholdTokens:null,compactRetainTokens:null,compactMaxTokens:8192,compactRetries:1,maxOverflowRetries:1,pruneToolResults:true,pruneThresholdBytes:8192,pruneHeadBytes:4096,pruneTailBytes:1024}};
def ensure($test;$code): if $test then . else error($code) end;
def int($lo;$hi): type=="number" and floor==. and . >= $lo and . <= $hi;
def txt($max): type=="string" and utf8bytelength <= $max and (contains("\u0000")|not);
def nonempty($max): txt($max) and test("\\S");
def envname: type=="string" and test("^[A-Za-z_][A-Za-z0-9_]{0,127}$");
def sensitive: test("authorization|cookie|key|token|secret|password|passwd|credential";"i");
def unsafeenv: sensitive or (ascii_upcase|test("^(BASH_FUNC_|LD_|DYLD_)|^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|SSH_AUTH_SOCK)$"));
def secretkey: ascii_downcase|IN("api_key","apikey","authorization","password","access_token","api_token","token","secret","credentials","cookie");
def providerok($depth):
 if type=="object" then all(to_entries[];(.key|secretkey|not) and (.value|providerok($depth)))
 elif type=="array" then all(.[];providerok($depth))
 elif type=="string" then (try {nested:fromjson} catch {}) as $v | if $v|has("nested") then $depth < 8 and ($v.nested|providerok($depth+1)) else true end
 else true end;
def header: type=="string" and test("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$") and (ascii_downcase|IN("host","content-length","transfer-encoding","content-type","connection","proxy-authorization")|not);
def relative: type=="string" and length>0 and (contains("\u0000")|not) and all(split("/")[]; IN("",".","..")|not);
def threshold: .compactThresholdTokens // (.contextWindowTokens*0.8|floor);
def retain: .compactRetainTokens // (.contextWindowTokens*0.16|floor);
def validate:
 . as $raw | defaults as $d |
 ensure(type=="object" and ((keys-($d|keys))|length)==0;"invalid-config") |
 ensure(has("version") and has("task") and (.model|type=="object" and has("baseUrl") and has("model"));"invalid-config") |
 ensure(all(["model","tools","context","limits","reuse"][]; . as $k | ($raw[$k] // {}) | type=="object" and ((keys-($d[$k]|keys))|length)==0);"invalid-config") |
 ($d * .) |
 ensure(.version==1 and (.task|nonempty(32000)) and (.model.model|nonempty(256)) and (.model.model|test("[\\x00-\\x1f]")|not);"invalid-config") |
 ensure(.model.apiKeyEnv|envname;"invalid-credential-env") |
 ensure(.model.baseUrl|type=="string" and test("^https://[^/?#@]+(?:/[^?#]*)?$|^http://(?:localhost|127(?:\\.[0-9]{1,3}){3}|\\[::1\\])(?::[0-9]+)?(?:/[^?#]*)?$") and (test("[\\x00-\\x20]")|not);"invalid-model-url") |
 ensure(.model.endpointPath==null or (.model.endpointPath|txt(2048) and (ltrimstr("/")|split("/")|all(.[]; length>0 and .!="." and .!="..")) and (test("[?#%\\\\\\x00-\\x20]")|not));"invalid-model-endpoint") |
 ensure(.systemPrompt==null or (.systemPrompt|nonempty(65536));"invalid-system-prompt") |
 ensure(.setupCommand==null or (.setupCommand|nonempty(32000));"invalid-setup") |
 ensure(.model.auth|IN("bearer","header","none");"invalid-model-options") |
 ensure(all([.model.stream,.model.showThinking,.tools.shell,.tools.editor,.context.autoCompact,.context.pruneToolResults][]; type=="boolean");"invalid-config") |
 ensure(.model.maxTokens==null or (.model.maxTokens|int(1;16777216));"invalid-model-options") |
 ensure(.model.seed==null or (.model.seed|int(-9007199254740991;9007199254740991));"invalid-model-options") |
 ensure(.model.temperature==null or (.model.temperature|type=="number" and .>=0 and .<=2);"invalid-model-options") |
 ensure(.model.topP==null or (.model.topP|type=="number" and .>=0 and .<=1);"invalid-model-options") |
 ensure(.model.reasoningEffort==null or (.model.reasoningEffort|nonempty(128) and (test("[\\x00-\\x1f]")|not));"invalid-model-options") |
 ensure(.model.thinking==null or (.model.thinking|type=="object" and providerok(0));"invalid-model-options") |
 ensure(.model.extraBody|type=="object" and length<=64 and (tojson|utf8bytelength)<=65536 and providerok(0) and all(keys[]; IN("model","messages","tools","stream","tool_choice","max_tokens","temperature","top_p","seed","reasoning_effort","thinking","headers","endpoint","base_url")|not);"invalid-model-options") |
 .model as $m |
 ensure(($m.headers|type)=="object" and ($m.headersEnv|type)=="object" and (($m.headers|length)+($m.headersEnv|length))<=64;"invalid-model-headers") |
 ensure(all($m.headers|to_entries[];(.key|header and (sensitive|not)) and (.value|txt(8192) and (test("[^\\x20-\\x7e]")|not))) and all($m.headersEnv|to_entries[];(.key|header) and (.value|envname));"invalid-model-headers") |
 ensure([($m.headers|keys[]),($m.headersEnv|keys[])] as $keys | ($keys|map(ascii_downcase)|unique|length)==($keys|length);"invalid-model-headers") |
 ensure($m.auth!="header" or ($m.apiKeyHeader|header);"invalid-model-headers") |
 ensure($m.auth=="none" or ([($m.headers|keys[]),($m.headersEnv|keys[])]|map(ascii_downcase)|index(if $m.auth=="header" then $m.apiKeyHeader|ascii_downcase else "authorization" end))==null;"invalid-model-headers") |
 ensure(.secretEnv|type=="array" and length<=128 and (unique|length)==length and all(.[];envname);"invalid-secret-env") |
 .secretEnv as $secrets | .tools as $t |
 ensure($t.profile|IN("native","dsh");"invalid-tool-options") |
 ensure(($t.shellExecutable|nonempty(4096) and (test("[\\x00-\\x1f]")|not)) and ($t.shellArgs|type=="array" and length<=32 and all(.[];txt(4096))) and ($t.maxFileBytes|int(1024;16777216));"invalid-tool-options") |
 ensure($t.environment|type=="object" and length<=128 and all(to_entries[]; .key as $k | ($k|envname and (unsafeenv|not)) and $k!=$m.apiKeyEnv and ($secrets|index($k))==null and ([$m.headersEnv[]]|index($k))==null and (.value|txt(8192) and (startswith("() {")|not)));"invalid-tool-options") |
 ensure((.limits.maxSteps|int(1;256)) and (.limits.totalTimeoutSecs|int(1;86400)) and (.limits.commandTimeoutSecs|int(1;3600)) and (.limits.maxOutputBytes|int(256;1048576)) and (.limits.maxContextBytes|int(4096;8388608)) and (.limits.maxResponseBytes|int(1024;8388608)) and (.model.requestTimeoutSecs|int(1;600));"invalid-limits") |
 ensure(.context|(.contextWindowTokens|int(128;16777216)) and (.compactMaxTokens|int(1;1048576)) and (.compactRetries|int(0;10)) and (.maxOverflowRetries|int(0;10)) and (.pruneThresholdBytes|int(256;8388608)) and (.pruneHeadBytes|int(0;8388608)) and (.pruneTailBytes|int(0;8388608)) and (threshold>0 and threshold<=.contextWindowTokens and retain>=0 and retain<threshold) and (.pruneHeadBytes+.pruneTailBytes)<.pruneThresholdBytes;"invalid-context-options") |
 ensure(.checks|type=="array" and length<=64 and ([.[].name]|unique|length)==length and all(.[];type=="object" and (keys|sort)==["command","name"] and (.name|nonempty(128) and test("^[A-Za-z0-9_ .-]+$")) and (.command|nonempty(32000)));"invalid-checks") |
 ensure(all(.reuse[];type=="array" and length<=128 and (unique|length)==length and all(.[];relative));"invalid-reuse-paths");
def setoverride($expr):
 ($expr|index("=")) as $eq | if $eq==null then error("invalid-override") else
 ($expr[0:$eq]) as $path | ($expr[$eq+1:]|fromjson) as $value |
 (if $path|startswith("/") then $path[1:]|split("/")|map(gsub("~1";"/")|gsub("~0";"~")) else $path|split(".") end) as $parts |
 ensure($parts|all(.[];length>0);"invalid-override") |
 reduce range(0;$parts|length) as $i ({path:[],root:.}; . as $state | .path += [if ($state.root|getpath($state.path)|type)=="array" then $parts[$i]|tonumber else $parts[$i] end]) |
 . as $state | .root|setpath($state.path;$value) end;
def normalizecall($name):
 ensure(type=="object";"invalid-tool-call") |
 if $name=="shell" or $name=="bash" then
 ensure(((keys-["command","timeoutSecs"]|length)==0) and (.command|nonempty(32000)) and (.timeoutSecs==null or (.timeoutSecs|int(1;3600)));"invalid-tool-call")
 else
 ensure($name=="editor" or $name=="str_replace_editor";"invalid-tool-call") |
 ensure(.path|nonempty(4096);"invalid-tool-call") |
 if $name=="str_replace_editor" then
 ensure((keys-["command","path","file_text","old_str","new_str","insert_line","view_range"]|length)==0 and (.path|startswith("/"));"invalid-tool-call") |
 . as $a | {path:.path,dsh:true,action:({view:"view",create:"create",str_replace:"replace",insert:"insert"}[.command])} |
 if .action=="view" and $a.view_range!=null then
 ensure($a.view_range|type=="array" and length==2 and (.[0]|int(1;9007199254740991)) and (.[1]==-1 or (.[1]|int($a.view_range[0];9007199254740991)));"invalid-tool-call") |
 .startLine=$a.view_range[0] | if $a.view_range[1]!=-1 then .endLine=$a.view_range[1] else . end
 elif .action=="create" then .content=$a.file_text
 elif .action=="replace" then .oldText=$a.old_str|.newText=(if $a|has("new_str") then $a.new_str else "" end)
 elif .action=="insert" then .line=$a.insert_line|.newText=$a.new_str else . end
 else . end |
 ensure(.action|IN("view","create","replace","insert");"invalid-tool-call") |
 . as $a | ({view:["startLine","endLine"],create:["content"],replace:["oldText","newText"],insert:["line","newText"]}[.action]+["path","action","dsh"]) as $allowed |
 ensure((keys-$allowed|length)==0;"invalid-tool-call") |
 if .action=="view" then ensure((.startLine==null or (.startLine|int(1;9007199254740991))) and (.endLine==null or (.endLine|int(($a.startLine//1);9007199254740991)));"invalid-tool-call")
 elif .action=="create" then ensure(.content|txt(16777216);"invalid-tool-call")
 elif .action=="replace" then ensure((.oldText|txt(16777216) and length>0) and (.newText|txt(16777216));"invalid-tool-call")
 else ensure((.newText|txt(16777216)) and (.line|int(if $a.dsh then 0 else 1 end;9007199254740991));"invalid-tool-call") end end;
def schemas:
 . as $t | [
 if .shell then {type:"function",function:{name:(if .profile=="dsh" then "bash" else "shell" end),description:"Run a bounded command in a persistent shell; cwd, environment and functions persist.",parameters:{type:"object",properties:{command:{type:"string"},timeoutSecs:{type:"integer",minimum:1,maximum:3600}},required:["command"],additionalProperties:false}}} else empty end,
 if .editor then {type:"function",function:{name:(if .profile=="dsh" then "str_replace_editor" else "editor" end),description:"Workspace-confined editor. Create never overwrites. Replacement must be unique. DSH inserts after insert_line; native inserts before a one-based line.",parameters:{type:"object",properties:(if .profile=="dsh" then {command:{enum:["view","create","str_replace","insert"]},path:{type:"string",description:"Absolute path within the workspace. Relative paths are invalid. The workspace root is provided in the system context."},file_text:{type:"string"},old_str:{type:"string"},new_str:{type:"string"},insert_line:{type:"integer"},view_range:{type:"array",items:{type:"integer"}}} else {action:{enum:["view","create","replace","insert"]},path:{type:"string"},content:{type:"string"},oldText:{type:"string"},newText:{type:"string"},line:{type:"integer"},startLine:{type:"integer"},endLine:{type:"integer"}} end),required:[(if .profile=="dsh" then "command" else "action" end),"path"],additionalProperties:false}}} else empty end];
def validanswer($tools;$summary):
 ensure(type=="object" and (.role//"assistant")=="assistant" and (.content==null or (.content|type)=="string") and (.reasoning_content==null or (.reasoning_content|type)=="string");"invalid-model-response") |
 ensure((.tool_calls//[])|type=="array" and length<=256;"invalid-model-response") |
 ensure(($summary|not) or ((.tool_calls//[])|length)==0;"invalid-model-response") |
 . as $answer | ensure(([($answer.tool_calls//[])[].id]|unique|length)==(($answer.tool_calls//[])|length);"invalid-tool-call") |
 ensure(all((.tool_calls//[])[];type=="object" and .type=="function" and (.id|nonempty(256)) and (.function|type)=="object" and (.function.name as $name|[$tools|schemas|.[].function.name]|index($name))!=null and (.function.arguments|type)=="string" and (.function.name as $name|.function.arguments|fromjson|normalizecall($name)|type=="object"));"invalid-tool-call") |
 ensure(((.tool_calls//[])|length)>0 or (.content|nonempty(8388608));"invalid-model-response") |
 {role:"assistant",content:.content} + (if .reasoning_content then {reasoning_content:.reasoning_content} else {} end) + (if .tool_calls then {tool_calls:.tool_calls} else {} end);
def sessionturn:
 ensure(length>0 and .[0].role=="user" and .[-1].role=="assistant" and ((.[-1].tool_calls//[])|length)==0;"invalid-session") |
 reduce .[] as $m ({pending:[]};
 if $m.role=="tool" then ensure((.pending|index($m.tool_call_id))!=null and ($m.content|type)=="string";"invalid-session")|.pending-=[$m.tool_call_id]
 elif $m.role=="user" or $m.role=="assistant" then
 ensure((.pending|length)==0 and ($m.content==null or ($m.content|type)=="string");"invalid-session") |
 if $m.role=="assistant" then
 ensure(all(($m.tool_calls//[])[];.type=="function" and (.id|nonempty(256)) and (.function.name as $n|.function.arguments|fromjson|normalizecall($n)|type=="object"));"invalid-session") |
 .pending=[($m.tool_calls//[])[].id] | ensure((.pending|unique|length)==(.pending|length);"invalid-session") else . end
 else error("invalid-session") end) | ensure((.pending|length)==0;"invalid-session");
def stream:
 reduce .[] as $e ({message:{role:"assistant",content:""},calls:{},finished:false,done:false};
 if $e=="[DONE]" then .done=true
 else ensure(.done|not;"invalid-model-stream") |
 if $e.error then error(if ($e|tojson|test("context.{0,40}(length|window|limit)|maximum context";"i")) then "model-context-overflow" else "model-request-failed" end) else . end |
 reduce ($e.choices//[])[] as $c (.;
 ensure(($c.index//0)==0 and (.finished|not);"invalid-model-stream") |
 .message.content += ($c.delta.content//"") |
 if $c.delta.reasoning_content then .message.reasoning_content=((.message.reasoning_content//"")+$c.delta.reasoning_content) else . end |
 reduce ($c.delta.tool_calls//[])[] as $t (.;
 ensure(($t.index|int(0;255)) and ($t.type==null or $t.type=="function");"invalid-model-stream") |
 ($t.index|tostring) as $i | .calls[$i] = (.calls[$i]//{id:"",type:"function",function:{name:"",arguments:""}}) |
 .calls[$i].id += ($t.id//"") | .calls[$i].function.name += ($t.function.name//"") | .calls[$i].function.arguments += ($t.function.arguments//"")) |
 if $c.finish_reason then ensure($c.finish_reason|IN("stop","tool_calls");"model-response-incomplete") | .finished=true else . end) end) |
 ensure(.done and .finished;"model-response-incomplete") |
 ensure(([.calls|keys[]|tonumber]|sort)==[range(0;.calls|length)];"invalid-model-stream") |
 .message + (if (.calls|length)>0 then {tool_calls:[.calls|to_entries|sort_by(.key|tonumber)|.[].value]} else {} end);
JQ

cat > "$TMP/privacy.jq" <<'JQ'
def normal: gsub("\u001b\\[[0-9;?]*[ -/]*[@-~]|\u001b\\][^\u0007\u001b]*(?:\u0007|\u001b\\\\)|\u001b[@-Z\\\\-_]";"")|gsub("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]";"");
# An all-zero hex offset is not a card number, despite its zero checksum.
def luhn: gsub("[^0-9]";"")|test("[1-9]") and (explode|reverse|to_entries|map((.value-48) as $d|if .key%2==1 then (if $d>=5 then $d*2-9 else $d*2 end) else $d end)|add|.%10==0);
def scan:
 (test("[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}|\\b[0-9]{3}-[0-9]{2}-[0-9]{4}\\b|\\b[0-9]{17}[0-9x]\\b|\\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{16,}|[sr]k_(?:live|test)_[a-z0-9]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[abprs]-[a-z0-9-]{10,}|xapp-[a-z0-9-]{10,}|aiza[a-z0-9_-]{20,}|akia[a-z0-9]{16})\\b|\\beyj[a-z0-9_-]+\\.[a-z0-9_-]+\\.[a-z0-9_-]+\\b|-----begin (?:[a-z0-9]+ )*private key-----|\\b(?:aws[_-]?secret[_-]?access[_-]?key|aws[_-]?secret|secret[_-]?access[_-]?key|api[_-]?key|apikey|secret|token|bearer|password)\\b\\s*[:=]\\s*[\"']?[^\\s\"']{20,}|\\b[a-z][a-z0-9+.-]*://[^\\s:/@]+:[^\\s:/@]+@|\\b(?:[a-z]{1,2}[0-9]{7,8}|e[0-9]{8}|g[0-9]{8}|eh[0-9]{7}|ej[0-9]{7})\\b|\\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\\b|\\b(?:[0-9a-f]{1,4}:){2,}:(?:[0-9a-f]{1,4}:?)*[0-9a-f]{1,4}\\b";"i")|not) and
 (test("\\b(?:ASIA[A-Z0-9]{16}|EAA[A-Za-z0-9]{20,}|[0-9]{6,10}:(?:AA[A-Za-z0-9_-]{30,}|[A-Za-z0-9_-]{34,35}))\\b|(?:^|[^A-Za-z0-9_.:/])1//[0-9A-Za-z_-]{20,}\\b")|not) and
 (test("\\b(?:\\+[0-9]{1,3}[ -]?)?(?:1[0-9]{10}|[0-9]{3}[ -]?[0-9]{3,4}[ -]?[0-9]{4}|[0-9]{10,11})\\b|(?:driver[_\\s-]?license|driver[_\\s-]?lic|dl[\\s#]?|driving[_\\s-]?license|驾驶证|驾照)[^0-9]{0,20}[0-9]{12}";"i")|not) and
 ([match("\\bbearer\\s+([A-Za-z0-9._~+/=-]{16,})";"ig")|.captures[0].string|test("[0-9]|.[A-Z]")]|any|not) and
 ([match("\\b([A-Z][A-Z0-9_]*_(?:PRIVATE_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|CREDENTIAL)|AWS_ACCESS_KEY_ID|HF_TOKEN)\"?\\s*[=:]\\s*[\"']?([^\\s\"']+)";"g")|.captures[1].string|length>=8 and (test("^(?:\\$|%|\\{\\{|process\\.env|import\\.meta\\.env|os\\.environ|os\\.getenv|getenv\\(|env\\()|<(?:EMAIL|PHONE|ID_CARD|BANK_CARD|NAME|IP|API_KEY|JWT|PEM_KEY|PASSPORT|DRIVER_LICENSE|CREDENTIAL_PATH)_[0-9]{3,}>")|not)]|any|not) and
 ([match("\\b(?:[0-9]{1,3}\\.){3}[0-9]{1,3}\\b";"g")|.string|split(".")|map(tonumber)|select(max<=255)|.[0] as $a|.[1] as $b|($a==0 or $a==10 or $a==127 or $a==255 or ($a==169 and $b==254) or ($a==172 and $b>=16 and $b<=31) or ($a==192 and $b==168))|not]|any|not) and
 ([match("\\b[0-9](?:[ -]?[0-9]){12,18}\\b";"g")|.string|luhn]|any|not);
def safe($secrets;$depth):
 if type=="string" then . as $text | (try {nested:fromjson} catch {}) as $v |
 # JSON short control escapes are syntax, not passport prefixes (e.g. an
 # escaped newline before an od offset). Decoded values are still scanned.
 (if $v|has("nested") then $text|gsub("\\\\[nrtbf]";" ") else $text end) as $scantext |
 all([$scantext,($scantext|normal)][];scan) and
 all([$text,($text|normal)][]; . as $s|all($secrets[]; . as $secret | $secret=="" or ($s|contains($secret)|not))) and
 (if $v|has("nested") then $depth<8 and ($v.nested|safe($secrets;$depth+1)) else true end)
 elif type=="object" then all(to_entries[];(.key|safe($secrets;$depth)) and (.value|safe($secrets;$depth)))
 elif type=="array" then all(.[];safe($secrets;$depth)) else true end;
JQ

jq_contract() { jq -L "$TMP" 'include "contract"; '"$1" "${@:2}"; }
json_update() {
  jq_contract "$1" "${@:2}" "$TMP/config.json" > "$TMP/config.next" 2> "$TMP/jq.error" || { ERROR=$(sed -n 's/^jq: error.*: \([a-z][a-z-]*\)$/\1/p' "$TMP/jq.error" | head -n 1); [[ -n $ERROR ]] || ERROR=invalid-config; return 1; }
  mv "$TMP/config.next" "$TMP/config.json"
}
cfg() { jq -r "$1" "$TMP/config.json"; }
bytes() { wc -c < "$1" | tr -d ' '; }
guard() {
  jq -e -L "$TMP" --slurpfile secrets "$TMP/secrets.json" 'include "privacy"; safe($secrets[0];0) and (tojson|safe($secrets[0];0))' "$1" >/dev/null 2>&1 || die outbound-pii-blocked
}
budget() {
  [[ $CANCELLED == 0 ]] || die cancelled || return
  [[ $DEADLINE == 0 || $SECONDS -lt $DEADLINE ]] || die time-budget-exhausted
}
safe_path() {
  local input=$1 cursor=/ part oldifs=$IFS
  [[ $input == /* ]] || input=$WORKSPACE/$input
  [[ ! $input =~ [[:cntrl:]] ]] || die editor-invalid-path || return
  [[ $input == "$WORKSPACE" || $input == "$WORKSPACE/"* ]] || die editor-outside-workspace || return
  IFS=/; read -r -a parts <<< "$input"; IFS=$oldifs
  for part in "${parts[@]}"; do
    [[ -n $part ]] || continue
    [[ $part != . && $part != .. ]] || die editor-invalid-path || return
    cursor=${cursor%/}/$part
    [[ ! -L $cursor ]] || die editor-symlink || return
  done
  SAFE_PATH=$input
}
absolute() { if [[ $1 == /* ]]; then printf '%s' "$1"; else printf '%s/%s' "$WORKSPACE" "$1"; fi; }
lock_file() {
  local lock=$1.lock.d owner
  [[ ! -L $1 && ! -L $lock && -d ${1%/*} && ( ! -e $1 || -f $1 ) ]] || die invalid-state-file || return
  while ! mkdir -m 700 "$lock" 2>/dev/null; do
    budget || return
    [[ -d $lock && ! -L $lock ]] || die invalid-lock-file || return
    owner=$(cat "$lock/pid" 2>/dev/null)
    if is_integer "$owner" && ! kill -0 "$owner" 2>/dev/null; then
      rm -f "$lock/pid"; rmdir "$lock" 2>/dev/null || :
    fi
    sleep .05
  done
  printf '%s\n' "$$" > "$lock/pid"
  LOCKS+=("$lock")
}
atomic_file() {
  local target=$1 source=$2 temp
  [[ ! -L $target && ( ! -e $target || -f $target ) && -d ${target%/*} ]] || die invalid-file || return
  temp=$(mktemp "${target%/*}/.cognia.XXXXXXXX") || die file-write-failed || return
  if ! cat "$source" > "$temp" || ! chmod 600 "$temp" || ! mv -f "$temp" "$target"; then rm -f "$temp"; die file-write-failed; return; fi
}
publish_file() {
  local target source=$2 temp
  safe_path "$1" || return
  target=$SAFE_PATH
  [[ ! -e $target && ! -L $target && -d ${target%/*} ]] || die invalid-export-path || return
  temp=$(mktemp "${target%/*}/.cognia.XXXXXXXX") || die file-write-failed || return
  # A same-directory hard link publishes complete bytes without replacing a file.
  if ! cat "$source" > "$temp" || ! chmod 600 "$temp" || ! link "$temp" "$target" 2>/dev/null; then
    rm -f "$temp"; die file-write-failed; return
  fi
  rm -f "$temp"
}
read_input_file() {
  local path=$1 maximum=$2 target=$3
  [[ $path == /* ]] || path=$INVOCATION_CWD/$path
  [[ -f $path && ! -L $path ]] || die invalid-input-file || return
  head -c "$((maximum+4))" "$path" > "$TMP/input.raw" || die invalid-input-file || return
  if [[ $(head -c 3 "$TMP/input.raw") == $'\xef\xbb\xbf' ]]; then
    tail -c +4 "$TMP/input.raw" > "$TMP/input.bytes"
  else cp "$TMP/input.raw" "$TMP/input.bytes"; fi
  [[ $(bytes "$TMP/input.bytes") -le $maximum ]] || die input-file-too-large || return
  # Validate Unicode scalar UTF-8 explicitly: some system iconv versions accept
  # out-of-range scalars. Reject overlong forms, surrogates and values > U+10FFFF.
  od -An -v -tu1 "$TMP/input.bytes" | awk '
    {for(i=1;i<=NF;i++) {
      b=$i
      if(remaining) {
        if(b<lower || b>upper) exit 1
        remaining--; lower=128; upper=191
      } else if(b<128) continue
      else if(b>=194 && b<=244) {
        remaining=(b<224 ? 1 : (b<240 ? 2 : 3)); lower=128; upper=191
        if(b==224) lower=160
        if(b==237) upper=159
        if(b==240) lower=144
        if(b==244) upper=143
      } else exit 1
    }}
    END {if(remaining) exit 1}
  ' || die invalid-input-encoding || return
  cp "$TMP/input.bytes" "$target" || die invalid-input-file || return
  jq -Rs -e 'contains("\u0000")|not' "$target" >/dev/null || die invalid-input-file || return
}
load_context_files() {
  local path
  printf '[]' > "$TMP/context.files"
  for path in "${CONTEXT_FILES[@]}"; do
    read_input_file "$path" "$FILE_MAX" "$TMP/context.content" || return
    jq -c --arg path "$path" --rawfile content "$TMP/context.content" '.+[{path:$path,content:$content}]' "$TMP/context.files" > "$TMP/context.next" || die invalid-input-file || return
    [[ $(bytes "$TMP/context.next") -le $CONTEXT_MAX ]] || die context-budget-exhausted || return
    guard "$TMP/context.next" || return
    mv "$TMP/context.next" "$TMP/context.files"
    CONTEXT_PENDING=1
  done
}
configured_task() {
  # Preserve file tasks' trailing newlines across Bash command substitution.
  CONFIGURED_TASK=$(jq -jr '.task' "$TMP/config.json"; printf '\001')
  CONFIGURED_TASK=${CONFIGURED_TASK%$'\001'}
}
emit_record() {
  local status=$1 message=$2 code=${3:-}
  jq -cn --arg status "$status" --arg message "$message" --arg code "$code" --argjson steps "$STEPS" --argjson checks "$CHECKS" --argjson reused "$REUSED" '{version:1,status:$status,steps:$steps,message:$message,checks:$checks,reused:$reused}+(if $code!="" then {errorCode:$code} else {} end)'
}

load_config() {
  local item name value path convert expression raw patch_index=0 cached_patches=()
  if [[ -n $CONFIG_PATH || -n $CONFIG_ENV ]]; then
    [[ -n $CONFIG_PATH && -z $CONFIG_ENV || -z $CONFIG_PATH && -n $CONFIG_ENV ]] || die invalid-config-source || return
    if [[ -n $CONFIG_ENV ]]; then
      [[ $CONFIG_ENV =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die invalid-config-env || return
      printf '%s' "${!CONFIG_ENV}" > "$TMP/config.json"
    else
      [[ -f $CONFIG_PATH ]] || die invalid-config || return
      head -c 1048577 "$CONFIG_PATH" > "$TMP/config.json"
    fi
    [[ $(bytes "$TMP/config.json") -le 1048576 ]] || die config-too-large || return
  elif [[ $MODE == configure || $MODE == doctor || $MODE == models || -n $PROVIDER || -n $PRESET || -n $RECIPE || ${#PRESET_FILES[@]} -gt 0 ]]; then
    jq_contract 'defaults' -n > "$TMP/config.json" || die invalid-config || return
  else die invalid-config-source; return; fi
  json_update 'ensure(type=="object";"invalid-config") | defaults * .' || return
  if [[ -n $PROVIDER ]]; then
    json_update '[$catalog[0].providers[]|select(.id==$id)] as $p | ensure($p|length==1;"invalid-provider") | .model=(defaults.model * $p[0].config.model)' --slurpfile catalog "$TMP/presets.json" --arg id "$PROVIDER" || return
  fi
  if [[ -n $PRESET ]]; then
    json_update '[$catalog[0].presets[]|select(.id==$id)] as $p | ensure($p|length==1;"invalid-preset") | . * $p[0].config' --slurpfile catalog "$TMP/presets.json" --arg id "$PRESET" || return
  fi
  # Resolve the execution dialect with later custom-file and explicit overrides.
  # The resolved patch is applied before these overrides so they retain precedence.
  cp "$TMP/config.json" "$TMP/resolved.json"
  for path in "${PRESET_FILES[@]}"; do
    [[ -f $path ]] || die invalid-preset-file || return
    patch_index=$((patch_index+1))
    head -c 1048577 "$path" > "$TMP/preset-$patch_index.json"
    cached_patches+=("$TMP/preset-$patch_index.json")
    [[ $(bytes "$TMP/preset-$patch_index.json") -le 1048576 ]] || die config-too-large || return
    jq -e -s 'length==1 and (.[0]|type)=="object"' "$TMP/preset-$patch_index.json" >/dev/null 2>&1 || die invalid-preset-file || return
    jq --slurpfile patch "$TMP/preset-$patch_index.json" '. * $patch[0]' "$TMP/resolved.json" > "$TMP/resolved.next" || die invalid-preset-file || return
    mv "$TMP/resolved.next" "$TMP/resolved.json"
  done
  for expression in "${OVERRIDES[@]}"; do
    jq_contract 'setoverride($expr)' --arg expr "$expression" "$TMP/resolved.json" > "$TMP/resolved.next" 2>/dev/null || die invalid-override || return
    mv "$TMP/resolved.next" "$TMP/resolved.json"
  done
  if [[ -n $RECIPE ]]; then
    json_update '[$catalog[0].recipes[]|select(.id==$id)] as $p | ensure($p|length==1;"invalid-recipe") | . * $p[0].config * (if ($resolved[0].tools.shellExecutable|split("/")[-1]|ascii_downcase|IN("pwsh","pwsh.exe","powershell","powershell.exe")) then ($p[0].powershell//{}) else {} end)' --slurpfile catalog "$TMP/presets.json" --slurpfile resolved "$TMP/resolved.json" --arg id "$RECIPE" || return
  fi
  for path in "${cached_patches[@]}"; do
    json_update '. * $patch[0]' --slurpfile patch "$path" || return
  done
  while IFS='|' read -r name path convert; do
    for item in "$name" "COGNIA_BOOTSTRAP_${name#DSH_}"; do
      case $item in COGNIA_BOOTSTRAP_MODEL_NAME) item=COGNIA_BOOTSTRAP_MODEL;; esac
      [[ ${!item+x} ]] || continue
      value=${!item}
      if [[ $convert == str ]]; then raw=$(jq -cn --arg v "$value" '$v');
      elif [[ $convert == bool ]]; then case $value in true|1) raw=true;; false|0) raw=false;; *) die invalid-override; return;; esac
      elif [[ -z $value && $path == context.compact*Tokens ]]; then raw=null
      else raw=$value; fi
      json_update 'setoverride($expr)' --arg expr "$path=$raw" || return
    done
  done <<'MAPPING'
BASE_URL|model.baseUrl|str
MODEL_NAME|model.model|str
DSH_API_KEY_ENV|model.apiKeyEnv|str
DSH_MAX_TOKENS|model.maxTokens|int
DSH_MAX_STEPS|limits.maxSteps|int
DSH_COMMAND_TIMEOUT|limits.commandTimeoutSecs|int
DSH_API_TIMEOUT|model.requestTimeoutSecs|int
DSH_STREAM|model.stream|bool
DSH_SHOW_THINKING|model.showThinking|bool
DSH_SYSTEM_PROMPT|systemPrompt|str
DSH_CONTEXT_WINDOW|context.contextWindowTokens|int
DSH_AUTO_COMPACT|context.autoCompact|bool
DSH_COMPACT_THRESHOLD|context.compactThresholdTokens|int
DSH_COMPACT_RETAIN|context.compactRetainTokens|int
DSH_COMPACT_MAX_TOKENS|context.compactMaxTokens|int
DSH_COMPACT_RETRIES|context.compactRetries|int
DSH_MAX_OVERFLOW_RETRIES|context.maxOverflowRetries|int
MAPPING
  for name in DSH_REASONING_EFFORT COGNIA_BOOTSTRAP_REASONING_EFFORT; do
    if [[ ${!name+x} ]]; then
      value=${!name}
      json_update '.model.reasoningEffort=(if $v=="none" then null else $v end)|.model.thinking={type:(if $v=="none" then "disabled" else "enabled" end)}' --arg v "$value" || return
    fi
  done
  [[ -z $CLI_MODEL ]] || json_update '.model.model=$v' --arg v "$CLI_MODEL" || return
  [[ -z $CLI_BASE ]] || json_update '.model.baseUrl=$v' --arg v "$CLI_BASE" || return
  [[ $CLI_ENV_SET == 0 ]] || json_update '.model.apiKeyEnv=$v' --arg v "$CLI_ENV" || return
  [[ -z $CLI_MAX ]] || json_update '.model.maxTokens=$v' --argjson v "$CLI_MAX" || return
  [[ -z $CLI_SYSTEM ]] || json_update '.systemPrompt=$v' --arg v "$CLI_SYSTEM" || return
  [[ -z $CLI_STREAM ]] || json_update '.model.stream=$v' --argjson v "$CLI_STREAM" || return
  if [[ $HAS_TASK_FILE == 1 ]]; then
    read_input_file "$TASK_FILE" 32000 "$TMP/task" || return
    jq -Rs -e -L "$TMP" 'include "contract"; nonempty(32000)' "$TMP/task" >/dev/null || die invalid-task || return
    json_update '.task=$task' --rawfile task "$TMP/task" || return
    HAS_TASK=1
  elif [[ $HAS_TASK == 1 ]]; then
    if [[ $TASK == - ]]; then head -c 32001 > "$TMP/task"; else printf '%s' "$TASK" > "$TMP/task"; fi
    json_update '.task=$task' --rawfile task "$TMP/task" || return
  fi
  for expression in "${OVERRIDES[@]}"; do json_update 'setoverride($expr)' --arg expr "$expression" || return; done
  json_update validate || return
  TOTAL=$(cfg '.limits.totalTimeoutSecs'); DEADLINE=$((SECONDS+TOTAL))
  MAX_STEPS=$(cfg '.limits.maxSteps'); CMD_TIMEOUT=$(cfg '.limits.commandTimeoutSecs'); OUTPUT_MAX=$(cfg '.limits.maxOutputBytes')
  CONTEXT_MAX=$(cfg '.limits.maxContextBytes'); RESPONSE_MAX=$(cfg '.limits.maxResponseBytes'); FILE_MAX=$(cfg '.tools.maxFileBytes')
  API_TIMEOUT=$(cfg '.model.requestTimeoutSecs'); AUTH=$(cfg '.model.auth'); API_ENV=$(cfg '.model.apiKeyEnv'); STREAM=$(cfg '.model.stream')
  SHELL_EXEC=$(cfg '.tools.shellExecutable')
  while IFS= read -r -d '' item; do SHELL_ARGS+=("$item"); done < <(jq -j '.tools.shellArgs[]|.,"\u0000"' "$TMP/config.json")
  jq_contract '. as $c | env | to_entries | map(select((.key|unsafeenv) or .key==$c.model.apiKeyEnv or (.key as $k|$c.secretEnv|index($k))!=null or (.key as $k|[$c.model.headersEnv[]]|index($k))!=null)|.value) | map(select(length>0))|unique' "$TMP/config.json" > "$TMP/secrets.json" || die invalid-environment || return
  while IFS= read -r -d '' item; do CHILD_ENV+=("$item"); done < <(jq -j -L "$TMP" --arg configenv "$CONFIG_ENV" 'include "contract"; . as $c | ((env|with_entries(select((.key|unsafeenv|not) and .key!=$c.model.apiKeyEnv and .key!=$configenv and (.key as $k|$c.secretEnv|index($k))==null and (.key as $k|[$c.model.headersEnv[]]|index($k))==null and (.value|startswith("() {")|not)))) + $c.tools.environment) | to_entries[] | (.key+"="+.value),"\u0000"' "$TMP/config.json")
}

configure() {
  local name value
  if [[ $NONINTERACTIVE == 0 ]]; then
    for name in baseUrl model apiKeyEnv; do
      printf '%s [%s]: ' "$name" "$(cfg ".model.$name")" >&2
      IFS= read -r value || return 1
      [[ -z $value ]] || json_update '.model[$k]=$v' --arg k "$name" --arg v "$value" || return
    done
    json_update validate || return
  fi
  [[ $OUTPUT == /* ]] || OUTPUT=$PWD/$OUTPUT
  [[ ! -e $OUTPUT || $FORCE == 1 ]] || die config-already-exists || return
  atomic_file "$OUTPUT" "$TMP/config.json" || return
  printf 'Configuration saved. Set the configured credential environment variable.\n' >&2
}

start_shell() {
  [[ -n $WORKER_PID ]] && kill -0 "$WORKER_PID" 2>/dev/null && return 0
  stop_shell
  rm -f "$TMP/input.fifo"; mkfifo "$TMP/input.fifo" || die shell-start-failed || return
  # Monitor mode gives this background job its own process group on macOS/Linux.
  set -m
  env -i "${CHILD_ENV[@]}" "$SHELL_EXEC" "${SHELL_ARGS[@]}" < "$TMP/input.fifo" > /dev/null 2>&1 &
  WORKER_PID=$!
  set +m
  exec 7> "$TMP/input.fifo"
  WORKER_OPEN=1
}
tool_result() {
  jq -cn --rawfile output "$TMP/tool.output" --argjson code "$1" --argjson timeout "${2:-false}" --argjson reset "${3:-false}" '{output:$output,exitCode:$code,timedOut:$timeout,cancelled:false,shellReset:$reset}' > "$TMP/tool.result"
}
capture_preview() {
  local source=$1 length
  length=$(bytes "$source")
  if [[ $length -le $OUTPUT_MAX ]]; then cat "$source" > "$TMP/tool.output"; else
    head -c "$((OUTPUT_MAX/2))" "$source" > "$TMP/tool.output"
    printf '\n[output preview truncated]\n' >> "$TMP/tool.output"
    tail -c "$((OUTPUT_MAX/2))" "$source" >> "$TMP/tool.output"
  fi
}
run_shell() {
  local command=$1 timeout=${2:-$CMD_TIMEOUT} fresh=${3:-false} trusted=${4:-false} finish code id output status escaped extras=() item name
  budget || return
  [[ $timeout -le $CMD_TIMEOUT ]] || timeout=$CMD_TIMEOUT
  id=$(od -An -N8 -tx1 /dev/urandom|tr -d ' \n'); output=$TMP/output-$id; status=$TMP/status-$id
  : > "$output"
  if [[ $fresh == true ]]; then
    if [[ $trusted == true ]]; then
      while IFS= read -r name; do
        [[ $name != "$API_ENV" && ${!name+x} ]] || continue
        if jq -e --arg n "$name" '[.model.headersEnv[]]|index($n)!=null' "$TMP/config.json" >/dev/null; then continue; fi
        if jq -e -n -L "$TMP" --arg n "$name" 'include "contract"; $n|ascii_upcase|test("^(BASH_FUNC_|LD_|DYLD_)|^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|NODE_OPTIONS|PYTHONPATH|PYTHONHOME)$")' >/dev/null; then continue; fi
        extras+=("$name=${!name}")
      done < <(jq -r '.secretEnv[]' "$TMP/config.json")
    fi
    set -m
    env -i "${CHILD_ENV[@]}" "${extras[@]}" "$SHELL_EXEC" "${SHELL_ARGS[@]}" -c "$command" >> "$output" 2>&1 &
    ACTIVE_PID=$!
    set +m
  else
    start_shell || return
    escaped=${command//\'/\'\\\'\'}; escaped="'$escaped'"
    printf 'eval %s >> %q 2>&1\n__cognia_status=$?\nprintf "%%s" "$__cognia_status" > %q\n' "$escaped" "$output" "$status" >&7 || die shell-write-failed || return
  fi
  finish=$((SECONDS+timeout))
  while :; do
    if ! budget; then [[ $fresh == true ]] && { stop_pid "$ACTIVE_PID"; ACTIVE_PID=; }; stop_shell; return 1; fi
    if [[ -f $status ]]; then code=$(cat "$status"); break; fi
    if [[ $fresh == true ]] && ! kill -0 "$ACTIVE_PID" 2>/dev/null; then
      wait "$ACTIVE_PID" 2>/dev/null; code=$?; stop_pid "$ACTIVE_PID"; ACTIVE_PID=; break
    fi
    if [[ $fresh != true ]] && ! kill -0 "$WORKER_PID" 2>/dev/null; then
      wait "$WORKER_PID" 2>/dev/null; code=$?; stop_shell; capture_preview "$output"; tool_result "$code" false true; rm -f "$output" "$status"; return 0
    fi
    if [[ $SECONDS -ge $finish ]]; then
      if [[ $fresh == true ]]; then stop_pid "$ACTIVE_PID"; ACTIVE_PID=; else stop_shell; fi
      capture_preview "$output"; printf '\nShell state reset after command timeout.\n' >> "$TMP/tool.output"
      tool_result null true true; rm -f "$output" "$status"; return 0
    fi
    # Bound disk retention even when commands emit unlimited output. Append-mode
    # writers keep their descriptor while the preview is compacted in place.
    if [[ $(bytes "$output") -gt $((OUTPUT_MAX*8)) ]]; then
      head -c "$((OUTPUT_MAX/2))" "$output" > "$TMP/preview-$id"
      printf '\n[output preview truncated]\n' >> "$TMP/preview-$id"
      tail -c "$((OUTPUT_MAX/2))" "$output" >> "$TMP/preview-$id"
      cat "$TMP/preview-$id" > "$output"; rm -f "$TMP/preview-$id"
    fi
    sleep .05
  done
  capture_preview "$output"; tool_result "$code" false false
  rm -f "$output" "$status"
}

edit_file() {
  local action path parent name temp before after
  action=$(jq -r '.action' "$TMP/call.args"); path=$(jq -r '.path' "$TMP/call.args")
  safe_path "$path" || return
  path=$SAFE_PATH; parent=${path%/*}; name=${path##*/}
  [[ -d $parent ]] || die editor-parent-missing || return
  if [[ $action == view && -d $path ]]; then
    [[ $(jq 'has("startLine") or has("endLine")' "$TMP/call.args") == false ]] || die editor-directory-range || return
    (cd "$path" && find . -mindepth 1 -maxdepth 2 \( -name '.*' -o -name node_modules -o -name __pycache__ \) -prune -o -print) 2>/dev/null | sed 's|^./||' | LC_ALL=C sort | head -n 10000 > "$TMP/tool.output"
    tool_result 0; return
  fi
  if [[ $action != create ]]; then
    [[ -f $path && ! -L $path && $(bytes "$path") -le $FILE_MAX ]] || die editor-invalid-file || return
    before=$("${HASH[@]}" < "$path")
    cp "$path" "$TMP/editor.original" || die editor-read-failed || return
  else
    [[ ! -e $path && ! -L $path ]] || die editor-file-exists || return
    : > "$TMP/editor.original"
    before=
  fi
  jq -j --slurpfile a "$TMP/call.args" --rawfile old "$TMP/editor.original" -n '
    $a[0] as $a |
    if $a.action=="view" then
      ($old|split("\n")) as $all |
      (if $a.dsh then $all else (if $old|endswith("\n") then $all[0:-1] else $all end) end) as $lines |
      ($a.startLine//1) as $start|($a.endLine//($lines|length)) as $end |
      if $start>($lines|length) or $end>($lines|length) then error("editor-line-out-of-range") else
      [range($start-1;$end)|. as $i|if $a.dsh then "\($i+1)\t\($lines[$i])\n" else $lines[$i]+(if $i<($all|length)-1 then "\n" else "" end) end]|join("") end
    elif $a.action=="create" then $a.content
    elif $a.action=="replace" then
      ($old|indices($a.oldText)) as $matches | if ($matches|length)!=1 then error("editor-replacement-not-unique") else $matches[0] as $i|$old[0:$i]+$a.newText+$old[$i+($a.oldText|length):] end
    elif $a.dsh then ($old|split("\n")) as $lines | if $a.line>($lines|length) then error("editor-line-out-of-range") else ($lines[0:$a.line]+[$a.newText]+$lines[$a.line:])|join("\n") end
    else
      ([0]+[range(0;$old|length)|select($old[.:.+1]=="\n")|.+1]) as $starts |
      (if $starts[-1]!=($old|length) then $starts+[($old|length)] else $starts end) as $offsets |
      if $a.line>($offsets|length) then error("editor-line-out-of-range") else $offsets[$a.line-1] as $i|$old[0:$i]+$a.newText+$old[$i:] end
    end' > "$TMP/editor.updated" 2>/dev/null || die editor-operation-failed || return
  if [[ $action == view ]]; then capture_preview "$TMP/editor.updated"; tool_result 0; return; fi
  [[ $(bytes "$TMP/editor.updated") -le $FILE_MAX ]] || die editor-file-too-large || return
  safe_path "$path" || return
  [[ ! -L $parent && -d $parent ]] || die editor-parent-changed || return
  temp=$(mktemp "$parent/.cognia.XXXXXXXX") || die editor-write-failed || return
  cat "$TMP/editor.updated" > "$temp" || { rm -f "$temp"; die editor-write-failed; return; }
  if [[ $action == create ]]; then
    ln "$temp" "$path" 2>/dev/null || { rm -f "$temp"; die editor-file-exists; return; }
    rm -f "$temp"
  else
    after=$("${HASH[@]}" < "$path")
    [[ $before == "$after" && ! -L $path ]] || { rm -f "$temp"; die editor-file-changed; return; }
    if [[ $(uname -s) == Darwin ]]; then chmod "$(stat -f %Lp "$path")" "$temp"; else chmod "$(stat -c %a "$path")" "$temp"; fi
    mv -f "$temp" "$path" || { rm -f "$temp"; die editor-write-failed; return; }
  fi
  printf 'File updated.' > "$TMP/tool.output"; tool_result 0
}

execute_call() {
  local name command timeout id
  name=$(jq -r '.function.name' "$TMP/call.json"); id=$(jq -r '.id' "$TMP/call.json")
  jq_contract '.function.arguments|fromjson|normalizecall($name)' --arg name "$name" "$TMP/call.json" > "$TMP/call.args" 2>/dev/null || die invalid-tool-call || return
  if [[ $name == shell || $name == bash ]]; then
    command=$(jq -r '.command' "$TMP/call.args"); timeout=$(jq -r '.timeoutSecs//empty' "$TMP/call.args")
    run_shell "$command" "${timeout:-$CMD_TIMEOUT}" || return
  elif ! edit_file; then
    printf '%s' "$ERROR" > "$TMP/tool.output"; tool_result null; ERROR=
  fi
  guard "$TMP/tool.result" || return
  if [[ $MODE == chat && $QUIET == 0 ]]; then printf '[tool] %s: ' "$name" >&2; jq -r '.output' "$TMP/tool.result" >&2; fi
  jq --slurpfile result "$TMP/tool.result" --arg id "$id" '.+[{role:"tool",tool_call_id:$id,content:($result[0]|tojson)}]' "$HISTORY" > "$TMP/history.next" && mv "$TMP/history.next" "$HISTORY"
}

run_checks() {
  local check name command r
  CHECKS='[]'
  while IFS= read -r check; do
    name=$(printf '%s' "$check"|jq -r '.name'); command=$(printf '%s' "$check"|jq -r '.command')
    run_shell "$command" "$CMD_TIMEOUT" true || return 2
    guard "$TMP/tool.result" || return 2
    r=$(jq -c --arg name "$name" '{name:$name,passed:(.exitCode==0 and (.timedOut|not)),exitCode:.exitCode,timedOut:.timedOut}' "$TMP/tool.result")
    CHECKS=$(jq -cn --argjson c "$CHECKS" --argjson r "$r" '$c+[$r]')
  done < <(jq -c '.checks[]' "$TMP/config.json")
  jq -e -n --argjson c "$CHECKS" '$c|all(.[];.passed)' >/dev/null
}

ensure_credential() {
  local credential='' character started terminal_state failed=0
  [[ $AUTH != none && -z ${!API_ENV} ]] || return 0
  [[ $MODE == chat && -t 0 ]] || die missing-credential || return
  terminal_state=$(stty -g) || die credential-input-failed || return
  stty -echo || die credential-input-failed || return
  printf 'API key (hidden, this process only): ' >&2
  # Bash 3.2 can defer SIGINT during an unbounded hidden read. Poll single
  # characters so cancellation and budgets apply without dropping partial keys.
  while :; do
    if ! budget; then failed=1; break; fi
    started=$SECONDS
    if IFS= read -r -s -n 1 -t 1 character; then
      [[ -n $character ]] || break
      case $character in $'\177'|$'\b') credential=${credential%?};; *) credential=$credential$character;; esac
    else
      if ! budget; then failed=1; break; fi
      if [[ $SECONDS -le $started ]]; then die missing-credential; failed=1; break; fi
    fi
  done
  stty "$terminal_state" || die credential-input-failed || return
  printf '\n' >&2
  [[ $failed == 0 ]] || return 1
  [[ -n $credential && $credential != *$'\r'* && $credential != *$'\n'* ]] || die missing-credential || return
  printf -v "$API_ENV" '%s' "$credential"; export "${API_ENV?}"
  jq --arg v "$credential" '.+[$v]|unique' "$TMP/secrets.json" > "$TMP/secrets.next"; mv "$TMP/secrets.next" "$TMP/secrets.json"
}

request_headers() {
  local header name value authheader
  ensure_credential || return
  jq '.model.headers' "$TMP/config.json" > "$TMP/header.guard"; guard "$TMP/header.guard" || return
  printf 'Content-Type: application/json\n' > "$TMP/headers"
  while IFS= read -r header; do name=$(printf '%s' "$header"|jq -r '.key'); value=$(printf '%s' "$header"|jq -r '.value'); printf '%s: %s\n' "$name" "$value" >> "$TMP/headers"; done < <(jq -c '.model.headers|to_entries[]' "$TMP/config.json")
  while IFS= read -r header; do
    name=$(printf '%s' "$header"|jq -r '.key'); value=$(printf '%s' "$header"|jq -r '.value'); value=${!value}
    [[ -n $value && $value != *$'\n'* && $value != *$'\r'* ]] || die missing-credential || return
    printf '%s: %s\n' "$name" "$value" >> "$TMP/headers"
  done < <(jq -c '.model.headersEnv|to_entries[]' "$TMP/config.json")
  if [[ $AUTH != none ]]; then
    value=${!API_ENV}; [[ -n $value && $value != *$'\n'* && $value != *$'\r'* ]] || die missing-credential || return
    if [[ $AUTH == header ]]; then authheader=$(cfg '.model.apiKeyHeader'); else authheader=Authorization; value="Bearer $value"; fi
    printf '%s: %s\n' "$authheader" "$value" >> "$TMP/headers"
  fi
}

models() {
  local endpoint timeout status exitcode
  jq -en --arg path "$MODELS_PATH" '$path|startswith("/") and (startswith("//")|not) and (test("[?#%\\\\\\x00-\\x20]")|not) and (.[1:]|split("/")|all(.[];length>0 and .!="." and .!=".."))' >/dev/null 2>&1 || die invalid-models-path || return
  endpoint=$(cfg '.model.baseUrl'); endpoint=${endpoint%/}$MODELS_PATH
  jq -cn --arg endpoint "$endpoint" '$endpoint' > "$TMP/models.endpoint"
  guard "$TMP/models.endpoint" || return
  request_headers || return
  guard "$TMP/models.endpoint" || return
  budget || return
  timeout=$API_TIMEOUT; [[ $((DEADLINE-SECONDS)) -ge $timeout ]] || timeout=$((DEADLINE-SECONDS))
  : > "$TMP/models.response"; : > "$TMP/models.status"
  set -m
  curl --disable --silent --show-error --proto '=http,https' --max-time "$timeout" --connect-timeout "$timeout" --max-filesize "$RESPONSE_MAX" --request GET --header "@$TMP/headers" --output "$TMP/models.response" --write-out '%{http_code}' "$endpoint" > "$TMP/models.status" 2> "$TMP/http.error" &
  ACTIVE_PID=$!
  set +m
  while kill -0 "$ACTIVE_PID" 2>/dev/null; do
    if ! budget; then stop_pid "$ACTIVE_PID"; ACTIVE_PID=; return 1; fi
    if [[ $(bytes "$TMP/models.response") -gt $RESPONSE_MAX ]]; then stop_pid "$ACTIVE_PID"; ACTIVE_PID=; die model-response-too-large; return; fi
    sleep .05
  done
  wait "$ACTIVE_PID" 2>/dev/null; exitcode=$?; ACTIVE_PID=
  budget || return
  [[ $exitcode == 0 ]] || die model-request-failed || return
  [[ $(bytes "$TMP/models.response") -le $RESPONSE_MAX ]] || die model-response-too-large || return
  status=$(cat "$TMP/models.status")
  [[ $status == 2?? ]] || die model-request-failed || return
  guard "$TMP/models.response" || return
  jq -e -s -L "$TMP" 'include "contract"; if length==1 and (.[0]|type)=="object" and (.[0].data|type)=="array" and all(.[0].data[]; type=="object" and (.id|nonempty(256)) and (.id|test("[\\x00-\\x1f\\x7f]")|not)) then [.[0].data[].id]|unique|sort else error("invalid-model-list") end' "$TMP/models.response" > "$TMP/models.ids" 2>/dev/null || die invalid-model-list || return
  if [[ $JSON_OUTPUT == 1 ]]; then cat "$TMP/models.ids"; else jq -r '.[]' "$TMP/models.ids"; fi
}

shell_is_powershell() {
  case ${SHELL_EXEC##*/} in [Pp][Ww][Ss][Hh]|[Pp][Ww][Ss][Hh].[Ee][Xx][Ee]|[Pp][Oo][Ww][Ee][Rr][Ss][Hh][Ee][Ll][Ll]|[Pp][Oo][Ww][Ee][Rr][Ss][Hh][Ee][Ll][Ll].[Ee][Xx][Ee]) return 0;; *) return 1;; esac
}

doctor_check() {
  jq --arg name "$1" --argjson ok "$2" --arg message "$3" '.+[{name:$name,ok:$ok,message:$message}]' "$TMP/doctor.json" > "$TMP/doctor.next"
  mv "$TMP/doctor.next" "$TMP/doctor.json"
}

doctor() {
  local name value valid workspace
  printf '[]' > "$TMP/doctor.json"
  doctor_check configuration true 'Configuration is valid.'
  workspace=${WORKSPACE:-${COGNIA_BOOTSTRAP_CWD:-${DSH_CWD:-$PWD}}}
  if [[ -d $workspace && -x $workspace ]]; then doctor_check workspace true 'Workspace is accessible.'; else doctor_check workspace false 'Workspace is not an accessible directory.'; fi
  if shell_is_powershell; then doctor_check shell false 'The Bash runtime requires a POSIX shell. Use the PowerShell runtime for PowerShell execution.'
  elif command -v "$SHELL_EXEC" >/dev/null 2>&1; then doctor_check shell true 'Configured shell is available.'
  else doctor_check shell false 'Configured shell is unavailable.'; fi
  while IFS= read -r name; do
    value=${!name}; valid=false
    [[ -n $value && $value != *$'\n'* && $value != *$'\r'* ]] && valid=true
    doctor_check "credential:$name" "$valid" "Environment variable $name must contain a nonempty single-line value."
  done < <(jq -r '([.model.headersEnv[]]+(if .model.auth!="none" then [.model.apiKeyEnv] else [] end))|unique[]' "$TMP/config.json")
  if [[ $(cfg '.model.model') == local-model ]]; then doctor_check model false 'Select an installed model with models and --model.'; else doctor_check model true 'A model ID is configured; availability has not been queried.'; fi
  jq '{ok:all(.[];.ok),checks:.}' "$TMP/doctor.json" > "$TMP/doctor.result"
  if [[ $JSON_OUTPUT == 1 ]]; then cat "$TMP/doctor.result"; else jq -r '.checks[]|"[\(if .ok then "ok" else "failed" end)] \(.name): \(.message)"' "$TMP/doctor.result"; fi
  jq -e '.ok' "$TMP/doctor.result" >/dev/null
}

chat_status() {
  jq --arg session "$SESSION" '{provider:.model.baseUrl,model:.model.model,tools:{shell:.tools.shell,editor:.tools.editor,profile:.tools.profile},session:(if $session=="" then "disabled" else "enabled" end)}' "$TMP/config.json" > "$TMP/chat.status"
  guard "$TMP/chat.status" || return
  cat "$TMP/chat.status"
}

set_chat_model() {
  local model=$1
  jq -cn --arg model "$model" '$model' > "$TMP/chat.model"
  guard "$TMP/chat.model" || return
  json_update '.model.model=$model|validate' --arg model "$model" || return
  printf 'Model: %s\n' "$model"
}

model_request() {
  local summary=${1:-false} timeout endpoint base suffix status exitcode attempt
  budget || return
  [[ $(bytes "$TMP/request.history") -le $CONTEXT_MAX ]] || die context-budget-exhausted || return
  jq -n -L "$TMP" --slurpfile c "$TMP/config.json" --slurpfile h "$TMP/request.history" --argjson summary "$summary" '
    include "contract"; $c[0].model as $m|
    ($m.extraBody+{model:$m.model,messages:($h[0]|map(del(._cogniaSession))),stream:$m.stream})+
    (if $summary then {max_tokens:$c[0].context.compactMaxTokens} else {tools:($c[0].tools|schemas)} end)+
    (reduce [["maxTokens","max_tokens"],["temperature","temperature"],["topP","top_p"],["seed","seed"],["reasoningEffort","reasoning_effort"],["thinking","thinking"]][] as $pair ({};if $m[$pair[0]]!=null and ($summary|not) or $pair[0]!="maxTokens" and $m[$pair[0]]!=null then .[$pair[1]]=$m[$pair[0]] else . end))' > "$TMP/request.json" || die invalid-model-options || return
  guard "$TMP/request.json" || return
  request_headers || return
  guard "$TMP/request.json" || return
  base=$(cfg '.model.baseUrl'); base=${base%/}; suffix=$(cfg '.model.endpointPath//"chat/completions"'); suffix=${suffix#/}
  if [[ $(cfg '.model.endpointPath==null') == true && $base == */chat/completions ]]; then endpoint=$base; else endpoint=$base/$suffix; fi
  for attempt in 0 1 2; do
    budget || return
    timeout=$API_TIMEOUT; [[ $((DEADLINE-SECONDS)) -ge $timeout ]] || timeout=$((DEADLINE-SECONDS))
    : > "$TMP/response"; : > "$TMP/http.status"
    set -m
    curl --disable --silent --show-error --proto '=http,https' --max-time "$timeout" --connect-timeout "$timeout" --max-filesize "$RESPONSE_MAX" --request POST --header "@$TMP/headers" --data-binary "@$TMP/request.json" --output "$TMP/response" --write-out '%{http_code}' "$endpoint" > "$TMP/http.status" 2> "$TMP/http.error" &
    ACTIVE_PID=$!
    set +m
    while kill -0 "$ACTIVE_PID" 2>/dev/null; do
      if ! budget; then stop_pid "$ACTIVE_PID"; ACTIVE_PID=; return 1; fi
      if [[ $(bytes "$TMP/response") -gt $RESPONSE_MAX ]]; then stop_pid "$ACTIVE_PID"; ACTIVE_PID=; die model-response-too-large; return; fi
      sleep .05
    done
    wait "$ACTIVE_PID" 2>/dev/null; exitcode=$?; ACTIVE_PID=
    budget || return
    [[ $exitcode == 0 ]] || die model-request-failed || return
    status=$(cat "$TMP/http.status")
    if [[ $status == 429 || $status == 5?? ]]; then if [[ $attempt -lt 2 ]]; then sleep .5; continue; fi; fi
    if [[ $status != 2?? ]]; then
      if [[ $status == 400 || $status == 413 || $status == 422 ]] && LC_ALL=C grep -Eiq 'context.{0,40}(length|window|limit)|maximum context' "$TMP/response"; then die model-context-overflow; else die model-request-failed; fi; return
    fi
    if [[ $STREAM == true ]]; then
      awk 'function emit(){if(payload=="[DONE]")print "\"[DONE]\"";else if(payload!="")print payload;payload=""} {sub(/\r$/,"");if($0==""){emit();next}if(/^data:/){sub(/^data: ?/,"");payload=payload (payload==""?"":"\n") $0}} END{emit()}' "$TMP/response" > "$TMP/sse.jsonl"
      jq_contract 'stream' -s "$TMP/sse.jsonl" > "$TMP/answer.raw" 2>/dev/null || die model-response-incomplete || return
    else
      jq -e 'if (.choices|type)=="array" and (.choices|length)==1 and (.choices[0].finish_reason=="stop" or .choices[0].finish_reason=="tool_calls") then .choices[0].message else error("invalid-model-response") end' "$TMP/response" > "$TMP/answer.raw" 2>/dev/null || die invalid-model-response || return
    fi
    jq_contract 'validanswer($c[0].tools;$summary)' --slurpfile c "$TMP/config.json" --argjson summary "$summary" "$TMP/answer.raw" > "$TMP/answer.json" 2>/dev/null || die invalid-tool-call || return
    guard "$TMP/answer.json" || return
    if [[ $(cfg '.model.showThinking') == true ]]; then jq -r 'select(.reasoning_content!=null)|"[thinking] "+.reasoning_content' "$TMP/answer.json" >&2; fi
    return 0
  done
}

prune_history() {
  jq --slurpfile c "$TMP/config.json" '$c[0].context as $x|if $x.pruneToolResults then map(if .role=="tool" then (.content|fromjson) as $r|if ($r.output|utf8bytelength)>$x.pruneThresholdBytes then .content=($r|.output=(.output[0:$x.pruneHeadBytes]+"\n[tool output middle pruned]\n"+(if $x.pruneTailBytes>0 then .output[-$x.pruneTailBytes:] else "" end))|tojson) else . end else . end) else . end' "$HISTORY" > "$TMP/history.next" && mv "$TMP/history.next" "$HISTORY"
}
compact_history() {
  local cut before attempt retries
  cut=$(jq -L "$TMP" --slurpfile c "$TMP/config.json" 'include "contract"; . as $h|[to_entries[]|select(.value.role=="user" and (.value._cogniaSession=="turn-start" or .value._cogniaSession==null))|.key] as $positions|if ($positions|length)>=2 then reduce ($positions[1:-1]|reverse[]) as $i ($positions[-1];if ($h[$i:]|tojson|utf8bytelength)/3 < ($c[0].context|retain) then $i else . end) else -1 end' "$HISTORY")
  [[ $cut -gt 1 ]] || die context-budget-exhausted || return
  before=$(bytes "$HISTORY")
  jq --argjson cut "$cut" '[{role:"system",content:"Summarize the earlier engineering conversation into a concise factual checkpoint, preserving decisions, paths, errors and remaining work. Do not call tools."},{role:"user",content:(.[1:$cut]|map(del(._cogniaSession))|tojson)}]' "$HISTORY" > "$TMP/summary.history"
  cp "$TMP/summary.history" "$TMP/request.history"
  printf '[compacting]\n' >&2
  retries=$(cfg '.context.compactRetries'); attempt=0
  while ! model_request true; do
    [[ $ERROR != cancelled && $ERROR != time-budget-exhausted && $attempt -lt $retries ]] || return 1
    attempt=$((attempt+1)); ERROR=
  done
  jq --argjson cut "$cut" --slurpfile answer "$TMP/answer.json" '[.[0],{role:"system",content:("<compacted-summary>\n"+$answer[0].content+"\n</compacted-summary>")}]+.[$cut:]' "$HISTORY" > "$TMP/history.next" || die context-compaction-failed || return
  [[ $(bytes "$TMP/history.next") -lt $before ]] || die context-compaction-failed || return
  mv "$TMP/history.next" "$HISTORY"
}
save_session() {
  [[ -n $SESSION ]] || return 0
  guard "$HISTORY" || return
  jq -r '.[]|.role+"\t"+tojson' "$HISTORY" > "$TMP/session.next"
  atomic_file "$SESSION" "$TMP/session.next"
}
load_session() {
  local line role body metadata pending=0 hasmeta=0 count=0
  [[ -n $SESSION ]] || return 0
  lock_file "$SESSION" || return
  [[ -f $SESSION ]] || return 0
  [[ $(bytes "$SESSION") -le 16777216 ]] || die session-too-large || return
  grep -q '_cogniaSession' "$SESSION" && hasmeta=1
  printf '[]' > "$TMP/session.pending"
  while IFS= read -r line; do
    [[ $line == *$'\t'* ]] || break
    role=${line%%$'\t'*}; body=${line#*$'\t'}
    printf '%s' "$body" > "$TMP/session.message"
    jq -e --arg role "$role" 'type=="object" and .role==$role and (.role|IN("system","user","assistant","tool"))' "$TMP/session.message" >/dev/null 2>&1 || break
    guard "$TMP/session.message" || { ERROR=; break; }
    metadata=$(jq -r '._cogniaSession//""' "$TMP/session.message")
    if [[ $role == system ]]; then
      if [[ $pending == 0 ]] && jq -e '.content|contains("<compacted-summary>")' "$TMP/session.message" >/dev/null; then jq --slurpfile m "$TMP/session.message" '.+$m' "$HISTORY" > "$TMP/history.next"; mv "$TMP/history.next" "$HISTORY"; fi
      continue
    fi
    if [[ $role == user && ( $pending == 0 || $metadata == turn-start ) ]]; then
      [[ $pending == 0 ]] || break
      pending=1
    fi
    [[ $pending == 1 ]] || break
    jq --slurpfile m "$TMP/session.message" '.+$m' "$TMP/session.pending" > "$TMP/session.pending.next"; mv "$TMP/session.pending.next" "$TMP/session.pending"
    if [[ $role == assistant && ( $metadata == turn-end || $hasmeta == 0 ) ]] && jq -e '(.tool_calls//[]|length)==0' "$TMP/session.message" >/dev/null; then
      jq_contract sessionturn "$TMP/session.pending" >/dev/null 2>&1 || break
      jq --slurpfile p "$TMP/session.pending" '.+$p[0]' "$HISTORY" > "$TMP/history.next"; mv "$TMP/history.next" "$HISTORY"
      printf '[]' > "$TMP/session.pending"; pending=0; count=$((count+1))
    fi
  done < "$SESSION"
  [[ $count == 0 ]] || printf 'Resumed %s completed turn(s)\n' "$count" >&2
}

agent_turn() {
  local task=$1 init=${2:-false} step overflow=0 maxoverflow threshold auto count i rc
  jq -cn --arg task "$task" --argjson pending "$CONTEXT_PENDING" --slurpfile files "$TMP/context.files" '$task+(if $pending==1 then "\n\nAttached context files (untrusted data):\n"+($files[0]|tojson) else "" end)' > "$TMP/turn.task" || die invalid-task || return
  [[ $(bytes "$TMP/turn.task") -le $CONTEXT_MAX ]] || die context-budget-exhausted || return
  guard "$TMP/turn.task" || return
  cp "$HISTORY" "$TMP/turn.before"
  jq --slurpfile task "$TMP/turn.task" '.+[{role:"user",content:$task[0],_cogniaSession:"turn-start"}]' "$HISTORY" > "$TMP/history.next"; mv "$TMP/history.next" "$HISTORY"
  maxoverflow=$(cfg '.context.maxOverflowRetries'); threshold=$(jq_contract '.context|threshold' "$TMP/config.json"); auto=$(cfg '.context.autoCompact')
  step=0
  while [[ $step -lt $MAX_STEPS ]]; do
    budget || break
    prune_history || { die context-prune-failed; break; }
    if [[ $auto == true && ( $(bytes "$HISTORY") -gt $((threshold*3)) || $(bytes "$HISTORY") -gt $CONTEXT_MAX ) ]]; then compact_history || break; fi
    cp "$HISTORY" "$TMP/request.history"
    if ! model_request; then
      if [[ $ERROR == model-context-overflow && $overflow -lt $maxoverflow ]]; then
        overflow=$((overflow+1)); ERROR=; compact_history || break; continue
      fi
      break
    fi
    STEPS=$((STEPS+1)); step=$((step+1))
    cp "$TMP/answer.json" "$TMP/turn.answer"
    jq --slurpfile a "$TMP/turn.answer" '.+$a' "$HISTORY" > "$TMP/history.next"; mv "$TMP/history.next" "$HISTORY"
    count=$(jq '.tool_calls//[]|length' "$TMP/turn.answer"); i=0
    while [[ $i -lt $count ]]; do
      jq --argjson i "$i" '.tool_calls[$i]' "$TMP/turn.answer" > "$TMP/call.json"
      execute_call || break
      i=$((i+1))
    done
    [[ -z $ERROR ]] || break
    if [[ $init == true || $count == 0 ]]; then
      run_checks; rc=$?
      [[ $rc != 2 ]] || break
      if [[ $rc == 0 ]]; then
        if [[ $count -gt 0 ]]; then jq '.+[{role:"assistant",content:"Environment readiness checks passed."}]' "$HISTORY" > "$TMP/history.next"; mv "$TMP/history.next" "$HISTORY"; fi
        jq '.[-1]._cogniaSession="turn-end"' "$HISTORY" > "$TMP/history.next"; mv "$TMP/history.next" "$HISTORY"
        save_session || break
        CONTEXT_PENDING=0
        jq -r '.[-1].content' "$HISTORY" > "$TMP/final.message"
        return 0
      fi
      if [[ $count == 0 ]]; then jq --arg checks "$CHECKS" '.+[{role:"user",content:("Readiness checks still fail: "+$checks+". Continue repair.")}]' "$HISTORY" > "$TMP/history.next"; mv "$TMP/history.next" "$HISTORY"; fi
    fi
  done
  [[ -n $ERROR ]] || ERROR='step-budget-exhausted'
  cp "$TMP/turn.before" "$HISTORY"
  return 1
}

fingerprint() {
  local path
  printf '%s\n' "$WORKSPACE" > "$TMP/fingerprint.input"
  jq -S -c . "$TMP/config.json" >> "$TMP/fingerprint.input"
  while IFS= read -r path; do
    safe_path "$path" || return
    [[ -f $SAFE_PATH && ! -L $SAFE_PATH && $(bytes "$SAFE_PATH") -le 16777216 ]] || die invalid-reuse-input || return
    printf '%s\0' "$path" >> "$TMP/fingerprint.input"; "${HASH[@]}" < "$SAFE_PATH" >> "$TMP/fingerprint.input"
  done < <(jq -r '.reuse.inputs[]' "$TMP/config.json")
  FINGERPRINT=$("${HASH[@]}" < "$TMP/fingerprint.input"); FINGERPRINT=$(printf '%s' "$FINGERPRINT"|awk '{for(i=1;i<=NF;i++)if(length($i)==64)print $i}')
}
outputs_exist() {
  local path
  while IFS= read -r path; do safe_path "$path" || return; [[ -f $SAFE_PATH || -d $SAFE_PATH ]] || return 1; done < <(jq -r '.reuse.outputs[]' "$TMP/config.json")
}
save_state() {
  [[ -n $STATE ]] || return 0
  if fingerprint; then jq -cn --arg hash "$FINGERPRINT" '{version:1,fingerprint:$hash}' > "$TMP/state.next"; atomic_file "$STATE" "$TMP/state.next"; else ERROR=; fi
}
initialize() {
  local previous='' invalidated=0 setup rc
  [[ $(cfg '.checks|length') -gt 0 ]] || die readiness-checks-required || return
  if [[ -n $STATE ]]; then
    STATE=$(absolute "$STATE"); lock_file "$STATE" || return
    if [[ -f $STATE ]]; then
      previous=$(jq -r '.fingerprint//""' "$STATE" 2>/dev/null); invalidated=1
      if fingerprint && [[ -n $previous && $previous == "$FINGERPRINT" ]] && outputs_exist; then REUSED=true; invalidated=0; fi
      ERROR=
    fi
  fi
  if [[ $FORCE == 0 && $invalidated == 0 ]]; then
    run_checks; rc=$?
    if [[ $rc == 0 ]]; then save_state; return; elif [[ $rc == 2 ]]; then return 1; fi
  fi
  REUSED=false
  setup=$(cfg '.setupCommand//""')
  if [[ -n $setup ]]; then
    run_shell "$setup" "$CMD_TIMEOUT" true true || return
    guard "$TMP/tool.result" || return
    run_checks; rc=$?
    if [[ $rc == 0 ]]; then save_state; return; elif [[ $rc == 2 ]]; then return 1; fi
  fi
  configured_task
  agent_turn "$CONFIGURED_TASK" true || return
  save_state
}

chat_history() {
  local count=${1:-10}
  [[ $count =~ ^[0-9]+$ && ${#count} -le 3 ]] || die invalid-history-count || return
  jq -e -n --arg count "$count" '$count|tonumber|.>=1 and .<=100' >/dev/null || die invalid-history-count || return
  jq --arg count "$count" '[.[]|select(.role!="system")|del(._cogniaSession)]|.[-($count|tonumber):]' "$HISTORY" > "$TMP/chat.history" || die invalid-history || return
  [[ $(bytes "$TMP/chat.history") -le $OUTPUT_MAX ]] || die history-output-too-large || return
  guard "$TMP/chat.history" || return
  cat "$TMP/chat.history"
}
chat_export() {
  [[ -n $1 ]] || die invalid-export-path || return
  guard "$HISTORY" || return
  jq -r '.[]|.role+"\t"+tojson' "$HISTORY" > "$TMP/export.session" || die invalid-history || return
  [[ $(bytes "$TMP/export.session") -le 16777216 ]] || die session-too-large || return
  publish_file "$1" "$TMP/export.session" || return
  printf 'Transcript exported.\n'
}
chat_save_config() {
  [[ -n $1 ]] || die invalid-export-path || return
  jq_contract validate "$TMP/config.json" > "$TMP/export.config" 2>/dev/null || die invalid-config || return
  guard "$TMP/export.config" || return
  publish_file "$1" "$TMP/export.config" || return
  printf 'Configuration saved.\n'
}
chat() {
  local task pending=$HAS_TASK
  while [[ $TERMINATED == 0 ]]; do
    CANCELLED=0; ERROR=; STEPS=0
    if [[ $pending == 1 ]]; then configured_task; task=$CONFIGURED_TASK; pending=0; else
      printf '> '
      IFS= read -r task || { [[ $CANCELLED == 1 && $TERMINATED == 0 ]] && continue; break; }
    fi
    DEADLINE=$((SECONDS+TOTAL))
    case $task in
      /exit|/quit) break;; '') continue;;
      /status) chat_status || printf '[%s]\n' "$ERROR" >&2;;
      /model) jq '.model.model' "$TMP/config.json" > "$TMP/chat.model"; if guard "$TMP/chat.model"; then jq -r '.' "$TMP/chat.model"; else printf '[%s]\n' "$ERROR" >&2; fi;;
      /model\ *) set_chat_model "${task#/model }" || printf '[%s]\n' "$ERROR" >&2;;
      /models) models || printf '[%s]\n' "$ERROR" >&2;;
      /history) chat_history || printf '[%s]\n' "$ERROR" >&2;;
      /history\ *) chat_history "${task#/history }" || printf '[%s]\n' "$ERROR" >&2;;
      /export) chat_export '' || printf '[%s]\n' "$ERROR" >&2;;
      /export\ *) chat_export "${task#/export }" || printf '[%s]\n' "$ERROR" >&2;;
      /save-config) chat_save_config '' || printf '[%s]\n' "$ERROR" >&2;;
      /save-config\ *) chat_save_config "${task#/save-config }" || printf '[%s]\n' "$ERROR" >&2;;
      /help) printf '/status - show active configuration\n/model [ID] - inspect or switch model\n/models - list provider models\n/history [N] - inspect recent messages\n/export PATH - export resumable transcript\n/save-config PATH - save current configuration\n/compact - summarize context\n/clear - clear transcript and shell\n/exit, /quit - exit\n';;
      /clear) stop_shell; jq '[.[0]]' "$HISTORY" > "$TMP/history.next"; mv "$TMP/history.next" "$HISTORY"; save_session || return; printf 'Session cleared.\n' >&2;;
      /compact) if compact_history && save_session; then printf 'Context compacted.\n' >&2; else printf '[%s]\n' "$ERROR" >&2; fi;;
      *) if agent_turn "$task"; then cat "$TMP/final.message"; else printf '[%s]\n' "$ERROR" >&2; fi;;
    esac
  done
  [[ $TERMINATED == 0 ]] || die cancelled
}

main() {
  [[ $HAS_TASK == 0 || $HAS_TASK_FILE == 0 ]] || die invalid-task-source || return
  [[ ${#CONTEXT_FILES[@]} == 0 || $MODE == run || $MODE == chat || $MODE == init ]] || die invalid-context-mode || return
  if [[ $MODE == presets ]]; then
    if [[ $JSON_OUTPUT == 1 ]]; then cat "$TMP/presets.json"; else jq -r '"Providers:",(.providers[]|"  "+.id+" - "+.label),"Task presets:",(.presets[]|"  "+.id),"Initialization recipes:",(.recipes[]|"  "+.id)' "$TMP/presets.json"; fi
    return
  fi
  if ! load_config; then
    if [[ $MODE == doctor ]]; then
      printf '[]' > "$TMP/doctor.json"
      doctor_check configuration false "Configuration is invalid ($ERROR)."
      if [[ $JSON_OUTPUT == 1 ]]; then jq '{ok:false,checks:.}' "$TMP/doctor.json"; else printf '[failed] configuration: %s\n' "$ERROR"; fi
      ERROR=; return 1
    fi
    return 1
  fi
  if [[ $MODE == configure ]]; then configure; return; fi
  if [[ $MODE == doctor ]]; then doctor; return; fi
  if [[ $MODE == models ]]; then models; return; fi
  load_context_files || return
  if shell_is_powershell; then die unsupported-shell; return; fi
  [[ $THEN == 0 || $MODE == init && ${#HANDOFF[@]} -gt 0 ]] || die invalid-handoff || return
  [[ ${#HANDOFF[@]} == 0 || $THEN == 1 ]] || die invalid-handoff || return
  WORKSPACE=${WORKSPACE:-${COGNIA_BOOTSTRAP_CWD:-${DSH_CWD:-$PWD}}}
  WORKSPACE=$(cd "$WORKSPACE" 2>/dev/null && pwd -P) || die invalid-cwd || return
  cd "$WORKSPACE" || die invalid-cwd || return
  jq -n --arg workspace "$WORKSPACE" --slurpfile c "$TMP/config.json" '[{role:"system",content:(($c[0].systemPrompt//"You are Cognia, a coding and environment initialization agent. Inspect before editing, use available tools, and never expose private data or credentials. Readiness is established only by host checks.")+"\nWorkspace root: "+($workspace|tojson)+". Shell commands use Bash/POSIX syntax. DSH editor paths must be absolute and remain within this workspace.")}]' > "$HISTORY" || return
  if [[ -z $SESSION ]]; then
    if [[ ${COGNIA_BOOTSTRAP_SESSION_FILE+x} ]]; then SESSION=$COGNIA_BOOTSTRAP_SESSION_FILE;
    elif [[ ${DSH_SESSION_FILE+x} ]]; then SESSION=$DSH_SESSION_FILE;
    elif [[ $MODE == chat ]]; then SESSION=session.jsonl; fi
  fi
  [[ $NO_SESSION == 0 ]] || SESSION=
  [[ -z $SESSION ]] || SESSION=$(absolute "$SESSION")
  load_session || return
  if [[ $MODE == chat ]]; then chat; return; fi
  if [[ $MODE == init ]]; then initialize || return; emit_record ready 'Environment readiness checks passed.';
  else configured_task; agent_turn "$CONFIGURED_TASK" || return; emit_record completed "$(cat "$TMP/final.message")"; fi
  if [[ $THEN == 1 ]]; then
    stop_shell
    set -m
    env -i "${CHILD_ENV[@]}" "${HANDOFF[@]}" &
    ACTIVE_PID=$!
    set +m
    wait "$ACTIVE_PID"; HANDOFF_EXIT=$?; stop_pid "$ACTIVE_PID"; ACTIVE_PID=
    [[ $CANCELLED == 0 ]] || die cancelled || return
    return "$HANDOFF_EXIT"
  fi
}

if main; then exit 0; else
  EXIT_CODE=$?
  if [[ -z $ERROR ]]; then exit "$EXIT_CODE"; fi
  STATUS=failed; EXIT_CODE=1
  case $ERROR in cancelled) STATUS=cancelled; EXIT_CODE=130;; *-budget-exhausted) STATUS=budget-exhausted; EXIT_CODE=3;; invalid-*|config-*|missing-config*|readiness-checks-required) EXIT_CODE=2;; esac
  if [[ $MODE == chat ]]; then printf '[%s]\n' "$ERROR" >&2; else emit_record "$STATUS" 'Bootstrap did not complete.' "$ERROR"; fi
  exit "$EXIT_CODE"
fi
