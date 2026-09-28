#![allow(dead_code)]
#[path = "../../../crates/cognia-skills/src/types.rs"]
mod types;
#[path = "resources-baseline.rs"]
mod baseline;
#[path = "../../../crates/cognia-skills/src/native.rs"]
mod current;
use std::{fs, time::Instant};
fn main() {
    for (name, skills, resources, bytes, ext) in [("small-text", 400, 10, 512, "md"), ("binary", 32, 8, 128 * 1024, "png")] {
        let root = tempfile::tempdir().unwrap();
        let data: Vec<u8> = (0..bytes).map(|i| if ext == "md" { b'x' } else { (i % 251) as u8 }).collect();
        for i in 0..skills {
            let dir = root.path().join(format!("skill-{i:04}"));
            fs::create_dir_all(dir.join("assets")).unwrap();
            fs::write(dir.join("SKILL.md"), "---\nname: fixture\n---\nbody\n").unwrap();
            for j in 0..resources { fs::write(dir.join("assets").join(format!("resource-{j:03}.{ext}")), &data).unwrap(); }
        }
        for pair in 0..14 {
            let mut result = Vec::new();
            let version = std::env::var("RESOURCE_VERSION").ok();
            let names: Vec<&str> = match version.as_deref() {
                Some("baseline") => vec!["baseline"],
                Some("current") => vec!["current"],
                _ if pair % 2 == 0 => vec!["baseline", "current"],
                _ => vec!["current", "baseline"],
            };
            for version in names {
                let start = Instant::now();
                let out = if version == "baseline" { baseline::skills_scan_dir(root.path().to_string_lossy().into_owned()) } else { current::skills_scan_dir(root.path().to_string_lossy().into_owned()) }.unwrap();
                let wire = serde_json::to_vec(&out).unwrap();
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(out.len(), skills);
                assert!(out.iter().all(|s| s.resources.len() == resources));
                if pair >= 2 { println!("RESOURCE_PAIR {}", serde_json::json!({"workload":name,"sample":pair-2,"version":version,"ms":ms,"wire_bytes":wire.len()})); }
                result.push(wire);
            }
            if result.len() == 2 { assert_eq!(result[0], result[1], "full native payload must remain identical"); }
        }
    }
}
