use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

pub(crate) fn apply_legacy_variable_substitution(content: &str) -> String {
    if !content.contains('$') {
        return content.to_string();
    }
    let var_decl_re = var_decl_re();
    let var_ref_re = var_ref_re();

    let mut vars = HashMap::<String, String>::new();
    for capture in var_decl_re.captures_iter(content) {
        let Some(name) = capture.get(1).map(|m| m.as_str().to_string()) else {
            continue;
        };
        let Some(value) = capture
            .get(2)
            .map(|m| normalize_legacy_var_value(m.as_str().trim()))
        else {
            continue;
        };
        vars.insert(name, value);
    }

    let mut cache = HashMap::<String, String>::new();
    let keys = vars.keys().cloned().collect::<Vec<_>>();
    for key in keys {
        let mut visiting = HashSet::<String>::new();
        let _ = resolve_var(&key, &vars, &mut cache, &mut visiting, &var_ref_re);
    }

    let without_decl = var_decl_re.replace_all(content, "").to_string();
    var_ref_re
        .replace_all(&without_decl, |caps: &regex::Captures<'_>| {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            cache
                .get(name)
                .cloned()
                .unwrap_or_else(|| caps.get(0).map(|m| m.as_str()).unwrap_or_default().to_string())
        })
        .to_string()
}

fn normalize_legacy_var_value(raw: &str) -> String {
    let mut out = raw.to_string();
    // SCSS-like flags occasionally leak from legacy sources;
    // they are metadata and must not enter resulting CSS values.
    out = default_flag_re().replace_all(&out, "").to_string();
    out = global_flag_re().replace_all(&out, "").to_string();
    out.trim().to_string()
}

fn var_decl_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?m)^\s*\$([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*;\s*$"#)
            .expect("legacy variable declaration regex must compile")
    })
}

fn var_ref_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"\$([A-Za-z_][A-Za-z0-9_-]*)"#)
            .expect("legacy variable ref regex must compile")
    })
}

fn default_flag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\s*!default\b"#).expect("default flag regex must compile"))
}

fn global_flag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"\s*!global\b"#).expect("global flag regex must compile"))
}

fn resolve_var(
    key: &str,
    vars: &HashMap<String, String>,
    cache: &mut HashMap<String, String>,
    visiting: &mut HashSet<String>,
    ref_re: &Regex,
) -> String {
    if let Some(v) = cache.get(key) {
        return v.clone();
    }
    let Some(raw) = vars.get(key) else {
        return format!("${key}");
    };
    if !visiting.insert(key.to_string()) {
        return raw.clone();
    }
    let resolved = ref_re
        .replace_all(raw, |caps: &regex::Captures<'_>| {
            let nested = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            if nested == key {
                return caps.get(0).map(|m| m.as_str()).unwrap_or_default().to_string();
            }
            if vars.contains_key(nested) {
                resolve_var(nested, vars, cache, visiting, ref_re)
            } else {
                caps.get(0).map(|m| m.as_str()).unwrap_or_default().to_string()
            }
        })
        .to_string();
    visiting.remove(key);
    cache.insert(key.to_string(), resolved.clone());
    resolved
}
