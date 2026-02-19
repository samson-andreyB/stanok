use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

use crate::CompileRequest;

pub(crate) fn apply_legacy_svg_function(
    req: &CompileRequest,
    content: &str,
    file_abs: &Path,
) -> String {
    if !content.contains("svg(") {
        return content.to_string();
    }

    svg_call_re()
        .replace_all(content, |caps: &regex::Captures<'_>| {
            let name = caps
                .get(1)
                .or_else(|| caps.get(2))
                .map(|m| m.as_str())
                .unwrap_or("")
                .trim();
            let rules = caps
                .get(3)
                .or_else(|| caps.get(4))
                .map(|m| m.as_str())
                .unwrap_or("")
                .trim();
            svg_call_to_data_url(req, file_abs, name, rules).unwrap_or_else(|| caps[0].to_string())
        })
        .to_string()
}

fn svg_call_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"svg\(\s*(?:'([^']+)'|"([^"]+)")\s*(?:,\s*(?:'([^']*)'|"([^"]*)"))?\s*\)"#,
        )
        .expect("svg() regex must compile")
    })
}

fn svg_call_to_data_url(
    req: &CompileRequest,
    file_abs: &Path,
    raw_name: &str,
    raw_rules: &str,
) -> Option<String> {
    let (name, fragment) = split_name_fragment(raw_name);
    let svg_path = resolve_svg_path(req, file_abs, name)?;
    let mut svg = fs::read_to_string(svg_path).ok()?;
    if !raw_rules.is_empty() {
        svg = apply_color_rules(&svg, raw_rules);
    }
    if !fragment.is_empty() {
        svg = svg.replace("<svg", &format!(r#"<svg id="{fragment}""#));
    }
    let encoded = percent_encode(svg.as_bytes());
    Some(format!(r#"url("data:image/svg+xml,{}")"#, encoded))
}

fn split_name_fragment(name: &str) -> (&str, &str) {
    match name.find('#') {
        Some(i) => (&name[..i], &name[i + 1..]),
        None => (name, ""),
    }
}

fn apply_color_rules(svg: &str, raw_rules: &str) -> String {
    let mut fill_value: Option<String> = None;
    let mut stroke_value: Option<String> = None;

    for rule in raw_rules.split(';') {
        let line = rule.trim();
        if line.is_empty() {
            continue;
        }
        let Some((selector, value)) = line.split_once(':') else {
            continue;
        };
        let selector = selector.trim();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match selector {
            "[color]" => {
                fill_value = Some(value.to_string());
                stroke_value = Some(value.to_string());
            }
            "[fill]" => fill_value = Some(value.to_string()),
            "[stroke]" => stroke_value = Some(value.to_string()),
            _ => {}
        }
    }

    let mut out = svg.to_string();
    if let Some(fill) = fill_value {
        out = fill_attr_re()
            .replace_all(&out, format!(r#"fill="{fill}""#))
            .to_string();
        out = fill_attr_single_re()
            .replace_all(&out, format!(r#"fill='{fill}'"#))
            .to_string();
    }
    if let Some(stroke) = stroke_value {
        out = stroke_attr_re()
            .replace_all(&out, format!(r#"stroke="{stroke}""#))
            .to_string();
        out = stroke_attr_single_re()
            .replace_all(&out, format!(r#"stroke='{stroke}'"#))
            .to_string();
    }
    out
}

fn fill_attr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"fill\s*=\s*"[^"]*""#).expect("fill attr regex must compile"))
}

fn fill_attr_single_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"fill\s*=\s*'[^']*'"#).expect("fill attr single regex must compile"))
}

fn stroke_attr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"stroke\s*=\s*"[^"]*""#).expect("stroke attr regex must compile"))
}

fn stroke_attr_single_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"stroke\s*=\s*'[^']*'"#).expect("stroke attr single regex must compile"))
}

fn resolve_svg_path(req: &CompileRequest, file_abs: &Path, name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();
    let current_dir = file_abs.parent().unwrap_or(Path::new(""));
    candidates.push(current_dir.join(name));
    candidates.push(req.cwd.join(name));

    let out_dir_abs = if req.config.out_dir.is_absolute() {
        req.config.out_dir.clone()
    } else {
        req.cwd.join(&req.config.out_dir)
    };
    let root_dir = out_dir_abs.parent().unwrap_or(&req.cwd);
    candidates.push(root_dir.join("img").join("dest").join(name));
    candidates.push(root_dir.join("img").join(name));
    candidates.push(req.cwd.join("assets").join("img").join("dest").join(name));
    candidates.push(req.cwd.join("assets").join("img").join(name));

    for root in &req.config.import_roots {
        let abs_root = if root.is_absolute() {
            root.clone()
        } else {
            req.cwd.join(root)
        };
        candidates.push(abs_root.join(name));
        candidates.push(abs_root.join("img").join("dest").join(name));
    }

    for c in candidates {
        if let Some(found) = with_svg_extension(c) {
            return Some(found);
        }
    }
    None
}

fn with_svg_extension(candidate: PathBuf) -> Option<PathBuf> {
    if candidate.exists() {
        return Some(candidate);
    }
    if candidate.extension().is_none() {
        let svg = candidate.with_extension("svg");
        if svg.exists() {
            return Some(svg);
        }
    }
    None
}

fn percent_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        let safe = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~');
        if safe {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(hex((b >> 4) & 0x0f));
            out.push(hex(b & 0x0f));
        }
    }
    out
}

fn hex(v: u8) -> char {
    match v {
        0..=9 => (b'0' + v) as char,
        _ => (b'A' + (v - 10)) as char,
    }
}
