use std::collections::HashSet;
use std::path::{Path, PathBuf};

use regex::Regex;

use crate::{CompileRequest, PipelineError};

pub(crate) fn emit_svg_fallback_assets(
    req: &CompileRequest,
    css_code: &str,
) -> Result<Vec<PathBuf>, PipelineError> {
    if !req.config.asset.enable_svg_fallback {
        return Ok(Vec::new());
    }

    let url_re = Regex::new(r#"url\(([^(]*)\)"#).expect("url regex must compile");
    let fallback_dir = svg_fallback_dir(req);
    let mut emitted = Vec::<PathBuf>::new();
    let mut seen = HashSet::<PathBuf>::new();

    for capture in url_re.captures_iter(css_code) {
        let Some(m) = capture.get(1) else {
            continue;
        };
        let raw = crate::legacy_urls::strip_quotes(m.as_str().trim());
        let (path_part, _) = crate::legacy_urls::split_url_suffix(raw);
        if !is_local_svg_path(path_part) {
            continue;
        }

        let stem = Path::new(path_part)
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("fallback");
        let rel = fallback_dir.join(format!("{stem}.png"));
        if !seen.insert(rel.clone()) {
            continue;
        }

        crate::write_file(&req.cwd.join(&rel), b"")?;
        emitted.push(rel);
    }

    Ok(emitted)
}

fn svg_fallback_dir(req: &CompileRequest) -> PathBuf {
    if let Some(dir) = &req.config.asset.svg_fallback_dir {
        return dir.clone();
    }
    req.config
        .out_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("img")
        .join("svg_fallback")
}

fn is_local_svg_path(path: &str) -> bool {
    let p = path.trim();
    if p.is_empty() {
        return false;
    }
    if crate::legacy_urls::should_keep_url_unmodified(p) && !p.starts_with('/') {
        return false;
    }
    p.to_ascii_lowercase().ends_with(".svg")
}
