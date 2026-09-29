//! Local dev-server discovery for the browser's empty state (ADR-0201).
//!
//! Lists TCP listeners on this machine (`lsof` on macOS/Linux, `ss` as the
//! Linux fallback, `netstat` + `tasklist` on Windows), keeps the ones reachable
//! over loopback (bound to a loopback or the any-address), probes each with a
//! short plain-HTTP `GET /`, and returns the ones that answer HTTP with the
//! page `<title>` when there is one. The command-output parsers are pure and
//! tested against captured samples; only [`detect`] touches the OS.

use std::collections::{BTreeMap, HashMap};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_PROBE_BYTES: usize = 64 * 1024;
const MAX_TITLE_CHARS: usize = 200;
/// Upper bound on distinct ports probed in one detection.
pub const DEFAULT_MAX_PROBES: usize = 64;

/// One reachable local HTTP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServer {
    pub url: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub process: Option<String>,
    pub title: Option<String>,
}

/// A listening TCP socket as reported by the OS tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    /// The bound host as printed (`127.0.0.1`, `::1`, `*`, `0.0.0.0`, `::`).
    pub host: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub process: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DetectOptions {
    /// Processes whose listeners are skipped (Cognia itself, its runtime).
    pub exclude_pids: Vec<u32>,
    /// Ports skipped (e.g. Cognia's own local-file server).
    pub exclude_ports: Vec<u16>,
    /// Cap on probed ports; `0` means [`DEFAULT_MAX_PROBES`].
    pub max_probes: usize,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DevServerError {
    #[error("dev_servers_unavailable: no listener tool could be run ({0})")]
    ToolUnavailable(String),
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/// Split `host:port` where host may be bracketed IPv6 or carry a `%iface`.
fn split_host_port(address: &str) -> Option<(String, u16)> {
    let (host, port) = address.rsplit_once(':')?;
    let port = port.parse::<u16>().ok()?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host = host.split('%').next().unwrap_or(host);
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port))
}

/// Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output (`p<pid>`, `c<command>`,
/// then `f<fd>`/`n<host:port>` per socket).
pub fn parse_lsof(output: &str) -> Vec<Listener> {
    let mut listeners = Vec::new();
    let mut pid: Option<u32> = None;
    let mut command: Option<String> = None;
    for line in output.lines() {
        let Some(tag) = line.chars().next() else {
            continue;
        };
        let value = &line[tag.len_utf8()..];
        match tag {
            'p' => {
                pid = value.trim().parse().ok();
                command = None;
            }
            'c' => command = Some(value.replace("\\x20", " ")),
            'n' => {
                // Established sockets print `a->b`; only listeners are wanted.
                if value.contains("->") {
                    continue;
                }
                if let Some((host, port)) = split_host_port(value.trim()) {
                    listeners.push(Listener {
                        host,
                        port,
                        pid,
                        process: command.clone(),
                    });
                }
            }
            _ => {}
        }
    }
    listeners
}

/// Parse `ss -ltnp` output (header optional).
pub fn parse_ss(output: &str) -> Vec<Listener> {
    let mut listeners = Vec::new();
    for line in output.lines() {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 4 || columns[0] != "LISTEN" {
            continue;
        }
        let Some((host, port)) = split_host_port(columns[3]) else {
            continue;
        };
        let users = columns
            .get(5..)
            .map(|rest| rest.join(" "))
            .unwrap_or_default();
        let (process, pid) = parse_ss_users(&users);
        listeners.push(Listener {
            host,
            port,
            pid,
            process,
        });
    }
    listeners
}

/// `users:(("node",pid=1234,fd=23),...)` → first process name and pid.
fn parse_ss_users(users: &str) -> (Option<String>, Option<u32>) {
    let Some(start) = users.find("((\"") else {
        return (None, None);
    };
    let rest = &users[start + 3..];
    let name = rest.split('"').next().map(str::to_string);
    let pid = rest
        .split("pid=")
        .nth(1)
        .and_then(|tail| tail.split([',', ')']).next())
        .and_then(|pid| pid.parse().ok());
    (name, pid)
}

/// Parse `netstat -ano -p TCP` / `-p TCPv6` (Windows). The state column is
/// localized, so a listener is recognised by its unconnected foreign address
/// (`0.0.0.0:0` / `[::]:0`) instead.
pub fn parse_netstat(output: &str) -> Vec<Listener> {
    let mut listeners = Vec::new();
    for line in output.lines() {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 4 || !columns[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        let foreign = columns[2];
        if foreign != "0.0.0.0:0" && foreign != "[::]:0" && foreign != "*:*" {
            continue;
        }
        let Some((host, port)) = split_host_port(columns[1]) else {
            continue;
        };
        let pid = columns.last().and_then(|pid| pid.parse::<u32>().ok());
        listeners.push(Listener {
            host,
            port,
            pid,
            process: None,
        });
    }
    listeners
}

/// Parse `tasklist /FO CSV /NH` into pid → image name.
pub fn parse_tasklist_csv(output: &str) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    for line in output.lines() {
        let fields = parse_csv_line(line);
        if fields.len() < 2 {
            continue;
        }
        if let Ok(pid) = fields[1].trim().parse::<u32>() {
            map.insert(pid, fields[0].clone());
        }
    }
    map
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = line.trim_end_matches('\r').chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted && chars.peek() == Some(&'"') => {
                current.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => fields.push(std::mem::take(&mut current)),
            ch => current.push(ch),
        }
    }
    if !current.is_empty() || !fields.is_empty() {
        fields.push(current);
    }
    fields
}

/// Whether a listener bound to `host` is reachable over loopback.
pub fn is_local_bind(host: &str) -> bool {
    if host == "*" || host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_loopback() || v4.is_unspecified(),
        Ok(IpAddr::V6(v6)) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
        Err(_) => false,
    }
}

/// Keep loopback-reachable listeners, drop excluded pids/ports, and merge the
/// IPv4/IPv6 twins of one port (preferring the entry that knows its process).
pub fn select_listeners(listeners: Vec<Listener>, options: &DetectOptions) -> Vec<Listener> {
    let mut by_port: BTreeMap<u16, Listener> = BTreeMap::new();
    for listener in listeners {
        if !is_local_bind(&listener.host)
            || options.exclude_ports.contains(&listener.port)
            || listener
                .pid
                .is_some_and(|pid| options.exclude_pids.contains(&pid))
        {
            continue;
        }
        by_port
            .entry(listener.port)
            .and_modify(|existing| {
                if existing.pid.is_none() {
                    existing.pid = listener.pid;
                }
                if existing.process.is_none() {
                    existing.process = listener.process.clone();
                }
                // An IPv4-reachable bind is the better probe target.
                if !existing.host.contains(':') {
                    return;
                }
                if !listener.host.contains(':') {
                    existing.host = listener.host.clone();
                }
            })
            .or_insert(listener);
    }
    let cap = if options.max_probes == 0 {
        DEFAULT_MAX_PROBES
    } else {
        options.max_probes
    };
    by_port.into_values().take(cap).collect()
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(end) = tail.find(';').filter(|end| *end <= 10) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => entity[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(ch) => {
                out.push(ch);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The document `<title>` of an HTML body, entity-decoded and
/// whitespace-collapsed; `None` when absent or empty.
pub fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut search = 0;
    let open_end = loop {
        let at = search + lower[search..].find("<title")?;
        let after = lower[at + 6..].chars().next()?;
        if after == '>' || after.is_whitespace() {
            break at + lower[at..].find('>')? + 1;
        }
        search = at + 6;
    };
    let close = open_end + lower[open_end..].find("</title")?;
    let raw = html.get(open_end..close)?;
    let text = decode_entities(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(MAX_TITLE_CHARS).collect())
}

/// Whether a raw response is HTTP, and its body (after the header block).
pub fn split_http_response(raw: &[u8]) -> Option<&[u8]> {
    if !raw.starts_with(b"HTTP/") {
        return None;
    }
    match raw.windows(4).position(|window| window == b"\r\n\r\n") {
        Some(at) => Some(&raw[at + 4..]),
        None => Some(&[]),
    }
}

// ---------------------------------------------------------------------------
// OS access
// ---------------------------------------------------------------------------

async fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = tokio::time::timeout(COMMAND_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    // lsof exits 1 when nothing matches; its stdout is still authoritative.
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn run_first(candidates: &[&str], args: &[&str]) -> Option<String> {
    for program in candidates {
        if let Some(output) = run(program, args).await {
            return Some(output);
        }
    }
    None
}

/// Every listening TCP socket the OS tool reports.
pub async fn list_listeners() -> Result<Vec<Listener>, DevServerError> {
    #[cfg(windows)]
    {
        let v4 = run("netstat", &["-ano", "-p", "TCP"]).await;
        let v6 = run("netstat", &["-ano", "-p", "TCPv6"]).await;
        if v4.is_none() && v6.is_none() {
            return Err(DevServerError::ToolUnavailable("netstat".into()));
        }
        let mut listeners = parse_netstat(&v4.unwrap_or_default());
        listeners.extend(parse_netstat(&v6.unwrap_or_default()));
        if let Some(tasks) = run("tasklist", &["/FO", "CSV", "/NH"]).await {
            let names = parse_tasklist_csv(&tasks);
            for listener in &mut listeners {
                listener.process = listener.pid.and_then(|pid| names.get(&pid).cloned());
            }
        }
        Ok(listeners)
    }
    #[cfg(not(windows))]
    {
        let lsof_args = ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"];
        if let Some(output) =
            run_first(&["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"], &lsof_args).await
        {
            return Ok(parse_lsof(&output));
        }
        if let Some(output) = run_first(
            &["/usr/bin/ss", "/usr/sbin/ss", "/bin/ss", "ss"],
            &["-ltnp"],
        )
        .await
        {
            return Ok(parse_ss(&output));
        }
        Err(DevServerError::ToolUnavailable("lsof, ss".into()))
    }
}

fn probe_address(listener: &Listener) -> SocketAddr {
    let ip = match listener.host.parse::<IpAddr>() {
        Ok(IpAddr::V6(v6)) if v6.is_loopback() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        Ok(IpAddr::V6(v6)) if v6.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        _ => IpAddr::V4(Ipv4Addr::LOCALHOST),
    };
    SocketAddr::new(ip, listener.port)
}

async fn probe_once(address: SocketAddr) -> Option<Vec<u8>> {
    let mut stream = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(address))
        .await
        .ok()?
        .ok()?;
    let request = format!(
        "GET / HTTP/1.1\r\nHost: localhost:{}\r\nUser-Agent: Cognia-DevServer-Probe\r\nAccept: text/html,*/*\r\nConnection: close\r\n\r\n",
        address.port()
    );
    let deadline = tokio::time::Instant::now() + PROBE_TIMEOUT;
    tokio::time::timeout_at(deadline, stream.write_all(request.as_bytes()))
        .await
        .ok()?
        .ok()?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        // A slow body keeps whatever arrived before the deadline.
        match tokio::time::timeout_at(deadline, stream.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
            Ok(Ok(n)) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() >= MAX_PROBE_BYTES
                    || raw.windows(8).any(|w| w.eq_ignore_ascii_case(b"</title>"))
                {
                    break;
                }
            }
        }
    }
    Some(raw)
}

/// Probe one listener; `None` when it does not speak HTTP.
pub async fn probe(listener: Listener) -> Option<DevServer> {
    let primary = probe_address(&listener);
    let mut raw = probe_once(primary).await;
    if raw.as_deref().and_then(split_http_response).is_none() && is_any_address(&listener.host) {
        // A `*`/`::` bind can be IPv6-only; retry over ::1.
        raw = probe_once(SocketAddr::new(
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            listener.port,
        ))
        .await;
    }
    let raw = raw?;
    let body = split_http_response(&raw)?;
    let title = extract_title(&String::from_utf8_lossy(body));
    Some(DevServer {
        url: format!("http://localhost:{}/", listener.port),
        port: listener.port,
        pid: listener.pid,
        process: listener.process,
        title,
    })
}

fn is_any_address(host: &str) -> bool {
    host == "*" || host == "0.0.0.0" || host == "::"
}

/// List local HTTP servers, sorted by port.
pub async fn detect(options: DetectOptions) -> Result<Vec<DevServer>, DevServerError> {
    let listeners = select_listeners(list_listeners().await?, &options);
    let mut set = tokio::task::JoinSet::new();
    for listener in listeners {
        set.spawn(probe(listener));
    }
    let mut servers = Vec::new();
    while let Some(result) = set.join_next().await {
        if let Ok(Some(server)) = result {
            servers.push(server);
        }
    }
    servers.sort_by_key(|server| server.port);
    Ok(servers)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LSOF_SAMPLE: &str = "p812\ncrapportd\nf12\nn127.0.0.1:49152\np4321\ncnode\nf23\nn127.0.0.1:3000\nf24\nn[::1]:3000\np4400\ncvite\\x20dev\nf30\nn*:5173\np555\ncpostgres\nf5\nn192.168.1.20:5432\nf6\nn10.0.0.2:5432->10.0.0.3:6000\n";

    #[test]
    fn lsof_field_output_is_parsed() {
        let parsed = parse_lsof(LSOF_SAMPLE);
        assert_eq!(parsed.len(), 5);
        assert_eq!(
            parsed[1],
            Listener {
                host: "127.0.0.1".into(),
                port: 3000,
                pid: Some(4321),
                process: Some("node".into())
            }
        );
        assert_eq!(parsed[2].host, "::1");
        assert_eq!(parsed[3].host, "*");
        assert_eq!(parsed[3].process.as_deref(), Some("vite dev"));
        assert_eq!(parsed[4].host, "192.168.1.20");
    }

    #[test]
    fn ss_output_is_parsed_with_and_without_users() {
        let sample = "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n\
LISTEN 0      511        127.0.0.1:3000       0.0.0.0:*     users:((\"node\",pid=1234,fd=23))\n\
LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*\n\
LISTEN 0      511            [::1]:8080          [::]:*     users:((\"python3\",pid=99,fd=3),(\"python3\",pid=100,fd=3))\n\
LISTEN 0      128                *:22               *:*\n";
        let parsed = parse_ss(sample);
        assert_eq!(parsed.len(), 4);
        assert_eq!(parsed[0].pid, Some(1234));
        assert_eq!(parsed[0].process.as_deref(), Some("node"));
        assert_eq!(parsed[1].host, "127.0.0.53");
        assert_eq!(parsed[1].pid, None);
        assert_eq!(parsed[2].host, "::1");
        assert_eq!(parsed[2].process.as_deref(), Some("python3"));
        assert_eq!(parsed[3].host, "*");
    }

    #[test]
    fn netstat_output_is_parsed_regardless_of_locale() {
        let sample = "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n\
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044\r\n\
  TCP    127.0.0.1:3000         0.0.0.0:0              ABHÖREN         5678\r\n\
  TCP    127.0.0.1:3000         127.0.0.1:52011        ESTABLISHED     5678\r\n\
  TCP    [::1]:5173             [::]:0                 LISTENING       777\r\n\
  UDP    0.0.0.0:500            *:*                                    9\r\n";
        let parsed = parse_netstat(sample);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[1].port, 3000);
        assert_eq!(parsed[1].pid, Some(5678));
        assert_eq!(parsed[2].host, "::1");
    }

    #[test]
    fn tasklist_csv_maps_pids_to_names() {
        let sample = "\"System Idle Process\",\"0\",\"Services\",\"0\",\"8 K\"\r\n\"node.exe\",\"5678\",\"Console\",\"1\",\"50,000 K\"\r\n\"we\"\"ird.exe\",\"9\",\"Console\",\"1\",\"1 K\"\r\n";
        let map = parse_tasklist_csv(sample);
        assert_eq!(map.get(&5678).map(String::as_str), Some("node.exe"));
        assert_eq!(map.get(&9).map(String::as_str), Some("we\"ird.exe"));
        assert_eq!(map.get(&0).map(String::as_str), Some("System Idle Process"));
    }

    #[test]
    fn only_loopback_and_any_address_binds_are_local() {
        for host in [
            "127.0.0.1",
            "127.8.9.1",
            "::1",
            "0.0.0.0",
            "::",
            "*",
            "::ffff:127.0.0.1",
        ] {
            assert!(is_local_bind(host), "{host}");
        }
        for host in ["192.168.1.20", "10.0.0.2", "fe80::1", "example.com"] {
            assert!(!is_local_bind(host), "{host}");
        }
    }

    #[test]
    fn selection_filters_excludes_merges_twins_and_caps() {
        let listeners = parse_lsof(LSOF_SAMPLE);
        let options = DetectOptions {
            exclude_pids: vec![812],
            exclude_ports: vec![],
            max_probes: 0,
        };
        let selected = select_listeners(listeners.clone(), &options);
        let ports: Vec<u16> = selected.iter().map(|l| l.port).collect();
        assert_eq!(ports, vec![3000, 5173]);
        assert_eq!(selected[0].host, "127.0.0.1");

        let options = DetectOptions {
            exclude_pids: vec![],
            exclude_ports: vec![3000],
            max_probes: 1,
        };
        let selected = select_listeners(listeners, &options);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].port, 5173);

        // An IPv6 twin seen first is replaced by the IPv4 bind and keeps pid.
        let merged = select_listeners(
            vec![
                Listener {
                    host: "::1".into(),
                    port: 8000,
                    pid: Some(7),
                    process: None,
                },
                Listener {
                    host: "127.0.0.1".into(),
                    port: 8000,
                    pid: None,
                    process: Some("python".into()),
                },
            ],
            &DetectOptions::default(),
        );
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].host, "127.0.0.1");
        assert_eq!(merged[0].pid, Some(7));
        assert_eq!(merged[0].process.as_deref(), Some("python"));
    }

    #[test]
    fn titles_are_extracted_and_decoded() {
        assert_eq!(
            extract_title("<html><head><TITLE>\n  Vite &amp; React  </TITLE></head>"),
            Some("Vite & React".into())
        );
        assert_eq!(
            extract_title("<title data-x=\"1\">A&#39;b &#x4e2d;</title>"),
            Some("A'b 中".into())
        );
        assert_eq!(
            extract_title("<titles>no</titles><title>yes</title>"),
            Some("yes".into())
        );
        assert_eq!(extract_title("<title>   </title>"), None);
        assert_eq!(extract_title("<p>no title</p>"), None);
        assert_eq!(extract_title("<title>unterminated"), None);
        assert_eq!(extract_title("<title>a & b</title>"), Some("a & b".into()));
        let long = format!("<title>{}</title>", "x".repeat(500));
        assert_eq!(extract_title(&long).unwrap().len(), MAX_TITLE_CHARS);
    }

    #[test]
    fn http_responses_are_recognised() {
        assert_eq!(
            split_http_response(b"HTTP/1.1 200 OK\r\nA: b\r\n\r\n<p>x"),
            Some(&b"<p>x"[..])
        );
        assert_eq!(split_http_response(b"HTTP/1.0 301 Moved"), Some(&b""[..]));
        assert_eq!(split_http_response(b"SSH-2.0-OpenSSH"), None);
        assert_eq!(split_http_response(b""), None);
    }

    #[tokio::test]
    async fn probe_reads_title_and_rejects_non_http() {
        let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_port = http.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = http.accept().await {
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<title>My App</title>",
                    )
                    .await;
            }
        });
        let server = probe(Listener {
            host: "127.0.0.1".into(),
            port: http_port,
            pid: Some(1),
            process: Some("node".into()),
        })
        .await
        .unwrap();
        assert_eq!(server.url, format!("http://localhost:{http_port}/"));
        assert_eq!(server.title.as_deref(), Some("My App"));
        assert_eq!(server.process.as_deref(), Some("node"));

        let raw = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let raw_port = raw.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = raw.accept().await {
                let _ = socket.write_all(b"SSH-2.0-OpenSSH_9.0\r\n").await;
            }
        });
        assert!(probe(Listener {
            host: "127.0.0.1".into(),
            port: raw_port,
            pid: None,
            process: None,
        })
        .await
        .is_none());
    }
}
