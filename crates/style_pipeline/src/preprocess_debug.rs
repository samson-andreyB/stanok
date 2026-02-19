use std::path::Path;

use regex::Regex;

pub(crate) fn maybe_dump_preprocessed_source(source: &str) {
    let Ok(path) = std::env::var("STANOK_DUMP_PREPROCESSED_CSS") else {
        return;
    };
    if path.trim().is_empty() {
        return;
    }
    let _ = std::fs::write(path, source);
}

pub(crate) fn maybe_dump_pre_stage(file_name: &str, source: &str) {
    let Ok(dir) = std::env::var("STANOK_DUMP_PREPROCESSED_STAGES_DIR") else {
        return;
    };
    if dir.trim().is_empty() {
        return;
    }
    let path = Path::new(&dir).join(file_name);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, source);
}

pub(crate) fn extract_parse_error_context(source: &str, raw_error: &str) -> String {
    let re = Regex::new(r":(\d+):(\d+)$").expect("parse error loc regex must compile");
    let Some(caps) = re.captures(raw_error) else {
        return String::new();
    };
    let line_no = caps
        .get(1)
        .and_then(|m| m.as_str().parse::<usize>().ok())
        .unwrap_or(0);
    if line_no == 0 {
        return String::new();
    }

    let lines: Vec<&str> = source.lines().collect();
    if line_no > lines.len() {
        return String::new();
    }

    let start = line_no.saturating_sub(2).max(1);
    let end = (line_no + 1).min(lines.len());
    let mut out = String::new();
    out.push_str("\n[around parse error]");
    for n in start..=end {
        let marker = if n == line_no { ">" } else { " " };
        let line = lines.get(n - 1).copied().unwrap_or_default();
        out.push_str(&format!("\n{} {:>5}: {}", marker, n, line));
    }
    out
}
