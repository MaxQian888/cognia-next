use crate::{BeginTaskRun, ServiceConfig, TaskWorkspaceService};
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn run_worker_cli(args: &[String], input: &str, output: &mut impl Write) -> Result<(), String> {
    let command = args
        .first()
        .map(String::as_str)
        .ok_or_else(|| "missing worker workspace command".to_string())?;
    let data_dir = required_flag(args, "data-dir")?;
    let service = TaskWorkspaceService::open(ServiceConfig::new(PathBuf::from(data_dir)))?;
    let value = match command {
        "bind" => {
            let binding_ref = required_flag(args, "repository-ref")?;
            let source_root = required_flag(args, "path")?;
            serde_json::to_value(service.bind_workspace_source(
                binding_ref,
                Path::new(source_root),
                now_ms(),
            )?)
            .map_err(|error| format!("serialize worker workspace result: {error}"))?
        }
        "list" => serde_json::to_value(service.list_workspace_source_bindings()?)
            .map_err(|error| format!("serialize worker workspace result: {error}"))?,
        "remove" => {
            let binding_ref = required_flag(args, "repository-ref")?;
            serde_json::json!({
                "removed": service.remove_workspace_source_binding(binding_ref)?
            })
        }
        "resolve" => {
            let binding_ref = required_flag(args, "repository-ref")?;
            serde_json::to_value(service.resolve_workspace_source(binding_ref)?)
                .map_err(|error| format!("serialize worker workspace result: {error}"))?
        }
        "begin" => {
            let binding_ref = required_flag(args, "repository-ref")?;
            let request: BeginTaskRun = serde_json::from_str(input)
                .map_err(|error| format!("parse begin request: {error}"))?;
            serde_json::to_value(service.begin_bound_run(binding_ref, request)?)
                .map_err(|error| format!("serialize worker workspace result: {error}"))?
        }
        _ => return Err(format!("unknown worker workspace command: {command}")),
    };
    writeln!(output, "{value}").map_err(|error| format!("write result: {error}"))
}

fn required_flag<'a>(args: &'a [String], name: &str) -> Result<&'a str, String> {
    let flag = format!("--{name}");
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing {flag}"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn args(command: &str, data: &Path, extra: &[&str]) -> Vec<String> {
        let mut values = vec![
            command.to_string(),
            "--data-dir".to_string(),
            data.to_string_lossy().into_owned(),
        ];
        values.extend(extra.iter().map(|value| value.to_string()));
        values
    }

    #[test]
    fn bind_list_resolve_and_remove_share_the_task_workspace_store() {
        let data = TempDir::new().unwrap();
        let repository = TempDir::new().unwrap();
        git2::Repository::init(repository.path()).unwrap();
        let repository_path = repository.path().to_string_lossy().into_owned();
        let binding_ref = "repository:project-1:repo-1";

        let mut bind_output = Vec::new();
        run_worker_cli(
            &args(
                "bind",
                data.path(),
                &["--repository-ref", binding_ref, "--path", &repository_path],
            ),
            "",
            &mut bind_output,
        )
        .unwrap();
        let binding: crate::WorkspaceSourceBinding = serde_json::from_slice(&bind_output).unwrap();
        assert_eq!(binding.binding_ref, binding_ref);

        let mut list_output = Vec::new();
        run_worker_cli(&args("list", data.path(), &[]), "", &mut list_output).unwrap();
        let listed: Vec<crate::WorkspaceSourceBinding> =
            serde_json::from_slice(&list_output).unwrap();
        assert_eq!(listed, vec![binding.clone()]);

        let mut resolve_output = Vec::new();
        run_worker_cli(
            &args("resolve", data.path(), &["--repository-ref", binding_ref]),
            "",
            &mut resolve_output,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<crate::WorkspaceSourceBinding>(&resolve_output).unwrap(),
            binding
        );

        let mut remove_output = Vec::new();
        run_worker_cli(
            &args("remove", data.path(), &["--repository-ref", binding_ref]),
            "",
            &mut remove_output,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&remove_output).unwrap(),
            serde_json::json!({ "removed": true })
        );
    }
}
