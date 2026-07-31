use crate::ResourceTrackingPolicy;
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

const CONFIG_FILES: &[&str] = &[
    "next.config.js",
    "next.config.mjs",
    "next.config.cjs",
    "next.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.ts",
];

pub fn resolve_tracking_policy(
    root: &Path,
    requested: &ResourceTrackingPolicy,
) -> Result<ResourceTrackingPolicy, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize tracking root {}: {error}", root.display()))?;
    let mut roots = BTreeSet::new();
    for candidate in &requested.generated_output_roots {
        roots.insert(validate_root(&canonical_root, candidate)?);
    }
    if requested.auto_detect {
        roots.extend(detect_generated_roots(&canonical_root));
    }
    Ok(ResourceTrackingPolicy {
        generated_output_roots: roots.into_iter().collect(),
        auto_detect: requested.auto_detect,
    })
}

fn detect_generated_roots(root: &Path) -> BTreeSet<String> {
    let mut roots = BTreeSet::new();
    if let Ok(value) = read_json(root.join("package.json")) {
        let has_dependency = |name: &str| {
            ["dependencies", "devDependencies"].iter().any(|key| {
                value
                    .get(key)
                    .and_then(Value::as_object)
                    .is_some_and(|deps| deps.contains_key(name))
            })
        };
        if has_dependency("next") {
            roots.insert(".next".to_string());
            if CONFIG_FILES
                .iter()
                .filter(|name| name.starts_with("next.config"))
                .filter_map(|name| fs::read_to_string(root.join(name)).ok())
                .any(|text| static_assignment(&text, "output").as_deref() == Some("export"))
            {
                roots.insert("out".to_string());
            }
        }
        if has_dependency("vite") {
            roots.insert("dist".to_string());
        }
    }
    if let Ok(value) = read_json(root.join("tsconfig.json")) {
        if let Some(out_dir) = value
            .get("compilerOptions")
            .and_then(|value| value.get("outDir"))
            .and_then(Value::as_str)
            .and_then(|value| normalize_detected_root(root, value))
        {
            roots.insert(out_dir);
        }
    }
    if root.join("Cargo.toml").is_file() {
        roots.insert("target".to_string());
        for config in [".cargo/config.toml", ".cargo/config"] {
            if let Ok(text) = fs::read_to_string(root.join(config)) {
                if let Some(value) = static_assignment(&text, "target-dir")
                    .and_then(|value| normalize_detected_root(root, &value))
                {
                    roots.remove("target");
                    roots.insert(value);
                }
            }
        }
    }
    for name in CONFIG_FILES {
        let Ok(text) = fs::read_to_string(root.join(name)) else {
            continue;
        };
        let property = if name.starts_with("next.config") {
            "distDir"
        } else {
            "outDir"
        };
        if let Some(value) = static_assignment(&text, property)
            .and_then(|value| normalize_detected_root(root, &value))
        {
            if name.starts_with("next.config") {
                roots.remove(".next");
            } else {
                roots.remove("dist");
            }
            roots.insert(value);
        }
    }
    roots
}

fn read_json(path: PathBuf) -> Result<Value, String> {
    let bytes = fs::read(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("parse {}: {error}", path.display()))
}

fn static_assignment(text: &str, property: &str) -> Option<String> {
    let compact = text.split_whitespace().collect::<String>();
    for separator in [':', '='] {
        let marker = format!("{property}{separator}");
        let Some((_, tail)) = compact.split_once(&marker) else {
            continue;
        };
        let quote = tail.chars().next()?;
        if !matches!(quote, '\'' | '"') {
            continue;
        }
        return tail[1..].split(quote).next().map(str::to_string);
    }
    None
}

fn normalize_detected_root(root: &Path, value: &str) -> Option<String> {
    validate_root(root, value).ok()
}

fn validate_root(root: &Path, value: &str) -> Result<String, String> {
    let normalized = value.trim().replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    let path = Path::new(normalized);
    if normalized.is_empty()
        || normalized == "."
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
        || path
            .components()
            .any(|component| component.as_os_str() == "node_modules")
    {
        return Err(format!("invalid generated output root: {value}"));
    }
    let candidate = root.join(path);
    let mut existing_ancestor = candidate.as_path();
    while !existing_ancestor.exists() {
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| format!("generated output root has no workspace ancestor: {value}"))?;
    }
    if existing_ancestor != root {
        let canonical = existing_ancestor.canonicalize().map_err(|error| {
            format!(
                "canonicalize generated output root {}: {error}",
                existing_ancestor.display()
            )
        })?;
        if !canonical.starts_with(root) {
            return Err(format!("generated output root escapes workspace: {value}"));
        }
    }
    Ok(normalized.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn explicit_roots_win_and_detection_is_bounded_to_known_configs() {
        let root = TempDir::new().unwrap();
        fs::write(
            root.path().join("package.json"),
            r#"{"devDependencies":{"next":"16.0.0"}}"#,
        )
        .unwrap();
        fs::write(
            root.path().join("next.config.ts"),
            "export default { output: 'export' }",
        )
        .unwrap();
        let policy = resolve_tracking_policy(
            root.path(),
            &ResourceTrackingPolicy {
                generated_output_roots: vec!["custom-build".into()],
                auto_detect: true,
            },
        )
        .unwrap();
        assert_eq!(
            policy.generated_output_roots,
            vec![".next", "custom-build", "out"]
        );
    }

    #[test]
    fn rejects_roots_that_escape_or_capture_dependencies() {
        let root = TempDir::new().unwrap();
        for candidate in ["../outside", ".", "node_modules/cache"] {
            assert!(resolve_tracking_policy(
                root.path(),
                &ResourceTrackingPolicy {
                    generated_output_roots: vec![candidate.into()],
                    auto_detect: false,
                },
            )
            .is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_nonexistent_roots_below_an_escaping_symlink() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        symlink(outside.path(), root.path().join("linked")).unwrap();
        assert!(resolve_tracking_policy(
            root.path(),
            &ResourceTrackingPolicy {
                generated_output_roots: vec!["linked/build".into()],
                auto_detect: false,
            },
        )
        .is_err());
    }
}
