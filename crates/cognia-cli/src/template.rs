//! Bundled plugin template — files emitted by `cognia plugin new`.
//!
//! Stored as `include_str!` blobs so the CLI binary is self-contained
//! (no separate templates directory shipped alongside it). Authors can
//! still inspect what was generated because we emit a top-of-file
//! comment pointing them at the cognia repo.

pub const CARGO_TOML: &str = include_str!("../../cognia-plugin-template/Cargo.toml");
pub const SRC_LIB_RS: &str = include_str!("../../cognia-plugin-template/src/lib.rs");
pub const PLUGIN_JSON: &str = include_str!("../../cognia-plugin-template/plugin.json");
pub const WIT_WORLD: &str = include_str!("../../cognia-plugin-template/wit/world.wit");
pub const README: &str = include_str!("../../cognia-plugin-template/README.md");
pub const GITIGNORE: &str = include_str!("../../cognia-plugin-template/.gitignore");

/// Substitute `template_name` for the requested `target_name` in
/// `Cargo.toml` and `plugin.json`. We rely on JSON / TOML being plain
/// text so a string-level substitution is cheap and obvious.
pub fn substitute_name(content: &str, target_name: &str) -> String {
    content
        .replace("cognia-plugin-template", target_name)
        .replace("Cognia Plugin Template", &humanize(target_name))
}

fn humanize(name: &str) -> String {
    name.split(|c: char| c == '-' || c == '_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().chain(c).collect::<String>(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_files_are_non_empty() {
        assert!(!CARGO_TOML.is_empty());
        assert!(!SRC_LIB_RS.is_empty());
        assert!(!PLUGIN_JSON.is_empty());
        assert!(!WIT_WORLD.is_empty());
    }

    #[test]
    fn substitute_replaces_crate_and_display_name() {
        let out = substitute_name(
            r#"name = "cognia-plugin-template"
description = "Cognia Plugin Template""#,
            "my-cool-plugin",
        );
        assert!(out.contains(r#"name = "my-cool-plugin""#));
        assert!(out.contains("My Cool Plugin"));
        assert!(!out.contains("cognia-plugin-template"));
    }

    #[test]
    fn humanize_handles_underscores_and_hyphens() {
        assert_eq!(humanize("my-cool-plugin"), "My Cool Plugin");
        assert_eq!(humanize("my_cool_plugin"), "My Cool Plugin");
        assert_eq!(humanize("plugin"), "Plugin");
        assert_eq!(humanize(""), "");
    }
}
