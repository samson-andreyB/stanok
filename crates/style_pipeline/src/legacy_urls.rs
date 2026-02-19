use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use crate::CompileRequest;

pub(crate) fn apply_legacy_import_url_rewrite(req: &CompileRequest, content: &str, file_abs: &Path) -> String {
    if !content.contains("url(") {
        return content.to_string();
    }
    // PR-07 scope: rewrite-only URL stage (no inline/filter).
    let url_re = url_re();
    let cur_dir_rel = path_relative_to(&req.cwd, file_abs.parent().unwrap_or(Path::new("")));

    url_re
        .replace_all(content, |caps: &regex::Captures<'_>| {
            let raw = caps.get(1).map(|m| m.as_str()).unwrap_or("").trim();
            let url = strip_quotes(raw);
            let (path_part, suffix) = split_url_suffix(url);

            if should_keep_url_unmodified(path_part) {
                return format!("url(\"{}\")", url);
            }

            let rewritten = normalize_slashes(&cur_dir_rel.join(Path::new(path_part)).to_string_lossy());
            format!("url(\"/{}{}\")", rewritten.trim_start_matches('/'), suffix)
        })
        .to_string()
}

fn url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"url\(([^(]*)\)"#).expect("url regex must compile"))
}

pub(crate) fn should_keep_url_unmodified(url: &str) -> bool {
    let value = url.trim();
    value.is_empty()
        || value.starts_with("data:")
        || value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("//")
        || value.starts_with('/')
        || value.starts_with('#')
}

pub(crate) fn split_url_suffix(url: &str) -> (&str, &str) {
    match url.find(['?', '#']) {
        Some(index) => (&url[..index], &url[index..]),
        None => (url, ""),
    }
}

pub(crate) fn strip_quotes(s: &str) -> &str {
    s.trim_matches(|c| c == '\'' || c == '"' || c == ' ')
}

fn path_relative_to(base: &Path, target: &Path) -> PathBuf {
    target.strip_prefix(base).unwrap_or(target).to_path_buf()
}

fn normalize_slashes(s: &str) -> String {
    s.replace('\\', "/")
}
