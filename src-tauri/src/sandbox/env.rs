// ADR-0028 — environment-variable scrubbing for sandboxed commands.
//
// Every backend launches the target with EXACTLY the environment the caller
// (the renderer-side `sandbox_*` tool, ultimately the model's tool-call
// payload) supplied — `env_clear().envs(&command.env)`. Several environment
// variables are *code-injection vectors*: the dynamic loader honours
// `LD_PRELOAD` / `DYLD_INSERT_LIBRARIES`, `node` honours `NODE_OPTIONS`,
// `sh` / `bash` auto-source `BASH_ENV` / `ENV`, `git` shells out to
// `GIT_SSH_COMMAND`, etc. A malicious value pointing at a file inside the
// (legitimately) writable workspace lets the model inject arbitrary code into
// every helper process the sandboxed command spawns — defeating the
// protected-path carve-outs and the "no persistence" intent even though the
// OS layer still confines the filesystem.
//
// We therefore drop a denylist of these keys before exec. This is a
// confinement *hardening* (it does not, by itself, contain the filesystem —
// the namespaces / SBPL do that), and it runs on the caller-supplied env only;
// the dispatcher's own injected proxy variables are added AFTER scrubbing so
// they always survive.

use std::collections::BTreeMap;

/// Exact variable names (matched case-insensitively) that are dropped from a
/// sandboxed command's environment. The `LD_*` / `DYLD_*` loader families are
/// handled by prefix in [`is_dangerous_env_key`]; this set covers the
/// interpreter / tool auto-execution vectors.
const DANGEROUS_EXACT: &[&str] = &[
    // Node.js — `--require`/`--import` arbitrary modules at startup.
    "NODE_OPTIONS",
    "NODE_REPL_EXTERNAL_MODULE",
    // POSIX shells auto-source these before running a script.
    "BASH_ENV",
    "ENV",
    // Python interpreter hooks.
    "PYTHONSTARTUP",
    "PYTHONINSPECT",
    // Perl — `-M`/`-d` style injection.
    "PERL5OPT",
    "PERL5DB",
    // Ruby.
    "RUBYOPT",
    // Git shells these out on fetch/push/diff/proxy operations.
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_EXTERNAL_DIFF",
    "GIT_PROXY_COMMAND",
    "GIT_PAGER",
    // glibc loaders that exec arbitrary code/data modules in ANY program that
    // does charset conversion / name resolution — equivalent to LD_PRELOAD.
    // `GCONV_PATH` loads attacker-supplied iconv modules; the rest redirect
    // resolver / locale lookups to attacker-controlled files.
    "GCONV_PATH",
    "HOSTALIASES",
    "NLSPATH",
    "RESOLV_HOST_CONF",
    "LOCALDOMAIN",
    "RES_OPTIONS",
    // Git: `GIT_CONFIG_GLOBAL`/`_SYSTEM` redirect config to an attacker file;
    // the `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_n`/`_VALUE_n` family injects
    // arbitrary config (aliases / `core.pager` / `core.fsmonitor`) that exec.
    // The numbered keys are caught by the `GIT_CONFIG_` prefix below.
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    // Generic pager / editor escapes that some tools exec.
    "PAGER",
];

/// True when `key` is a code-injection environment variable that must be
/// stripped from a sandboxed command. Matches the `LD_*` (glibc/musl loader),
/// `DYLD_*` (macOS dyld), and `GIT_CONFIG_*` (numbered config injection)
/// families by prefix, plus the exact-name set. Case-insensitive so it also
/// covers Windows' case-folding environment.
pub fn is_dangerous_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    if upper.starts_with("LD_") || upper.starts_with("DYLD_") || upper.starts_with("GIT_CONFIG_") {
        return true;
    }
    DANGEROUS_EXACT.iter().any(|k| k.eq_ignore_ascii_case(&upper))
}

/// Remove every dangerous key from `env` in place. Returns the keys that were
/// dropped (sorted, for deterministic audit / test assertions).
pub fn filter_env(env: &mut BTreeMap<String, String>) -> Vec<String> {
    let dropped: Vec<String> = env
        .keys()
        .filter(|k| is_dangerous_env_key(k))
        .cloned()
        .collect();
    for key in &dropped {
        env.remove(key);
    }
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ld_and_dyld_families_are_dangerous() {
        assert!(is_dangerous_env_key("LD_PRELOAD"));
        assert!(is_dangerous_env_key("LD_LIBRARY_PATH"));
        assert!(is_dangerous_env_key("LD_AUDIT"));
        assert!(is_dangerous_env_key("DYLD_INSERT_LIBRARIES"));
        assert!(is_dangerous_env_key("DYLD_LIBRARY_PATH"));
        // Case-insensitive (Windows folds case).
        assert!(is_dangerous_env_key("ld_preload"));
        assert!(is_dangerous_env_key("Dyld_Insert_Libraries"));
    }

    #[test]
    fn interpreter_and_tool_hooks_are_dangerous() {
        for k in [
            "NODE_OPTIONS",
            "BASH_ENV",
            "ENV",
            "PYTHONSTARTUP",
            "PERL5OPT",
            "RUBYOPT",
            "GIT_SSH_COMMAND",
            "GIT_EXTERNAL_DIFF",
        ] {
            assert!(is_dangerous_env_key(k), "{k} should be dangerous");
        }
    }

    #[test]
    fn glibc_loader_and_git_config_injection_are_dangerous() {
        for k in [
            "GCONV_PATH",
            "HOSTALIASES",
            "NLSPATH",
            "RESOLV_HOST_CONF",
            "LOCALDOMAIN",
            "RES_OPTIONS",
            "GIT_CONFIG",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_SYSTEM",
            "GIT_CONFIG_COUNT",
            // Numbered GIT_CONFIG_* injection keys caught by prefix.
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        ] {
            assert!(is_dangerous_env_key(k), "{k} should be dangerous");
        }
    }

    #[test]
    fn ordinary_vars_are_kept() {
        for k in ["PATH", "HOME", "LANG", "TERM", "HTTP_PROXY", "CARGO_HOME", "MY_VAR"] {
            assert!(!is_dangerous_env_key(k), "{k} should be kept");
        }
    }

    #[test]
    fn filter_removes_only_dangerous_keys_and_reports_them() {
        let mut env = BTreeMap::new();
        env.insert("PATH".to_string(), "/usr/bin".to_string());
        env.insert("LD_PRELOAD".to_string(), "/work/evil.so".to_string());
        env.insert("NODE_OPTIONS".to_string(), "--require /work/x.js".to_string());
        env.insert("HOME".to_string(), "/home/u".to_string());

        let dropped = filter_env(&mut env);

        assert_eq!(dropped, vec!["LD_PRELOAD".to_string(), "NODE_OPTIONS".to_string()]);
        assert!(env.contains_key("PATH"));
        assert!(env.contains_key("HOME"));
        assert!(!env.contains_key("LD_PRELOAD"));
        assert!(!env.contains_key("NODE_OPTIONS"));
    }

    #[test]
    fn filter_on_clean_env_is_noop() {
        let mut env = BTreeMap::new();
        env.insert("PATH".to_string(), "/usr/bin".to_string());
        let dropped = filter_env(&mut env);
        assert!(dropped.is_empty());
        assert_eq!(env.len(), 1);
    }

    #[test]
    fn injected_proxy_vars_survive_filtering() {
        // The dispatcher injects these for an allowlist policy; they must never
        // be treated as dangerous.
        let mut env = BTreeMap::new();
        for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "COGNIA_SANDBOX_PROXY_PORT"] {
            env.insert(k.to_string(), "x".to_string());
        }
        let dropped = filter_env(&mut env);
        assert!(dropped.is_empty());
        assert_eq!(env.len(), 5);
    }
}
