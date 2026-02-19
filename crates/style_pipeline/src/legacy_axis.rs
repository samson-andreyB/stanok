use std::sync::OnceLock;

use regex::Regex;

pub(crate) fn apply_legacy_axis_shorthands(content: &str) -> String {
    let out = trailing_axis_re()
        .replace_all(content, |caps: &regex::Captures<'_>| {
            let indent = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            let base = caps.get(2).map(|m| m.as_str()).unwrap_or_default();
            let axis = caps.get(3).map(|m| m.as_str()).unwrap_or_default();
            let value = caps.get(4).map(|m| m.as_str().trim()).unwrap_or_default();

            if let Some((first, second)) = axis_pair(base, axis) {
                format!(
                    "{indent}{first}: {value};\n{indent}{second}: {value};"
                )
            } else {
                caps.get(0)
                    .map(|m| m.as_str())
                    .unwrap_or_default()
                    .to_string()
            }
        })
        .into_owned();

    // Legacy variant: border-x-color / border-y-width / border-x-style.
    border_middle_axis_re()
        .replace_all(&out, |caps: &regex::Captures<'_>| {
            let indent = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            let base = caps.get(2).map(|m| m.as_str()).unwrap_or_default();
            let axis = caps.get(3).map(|m| m.as_str()).unwrap_or_default();
            let suffix = caps.get(4).map(|m| m.as_str()).unwrap_or_default();
            let value = caps.get(5).map(|m| m.as_str().trim()).unwrap_or_default();
            let axis_base = format!("{base}-{suffix}");

            if let Some((first, second)) = axis_pair(&axis_base, axis) {
                format!("{indent}{first}: {value};\n{indent}{second}: {value};")
            } else {
                caps.get(0)
                    .map(|m| m.as_str())
                    .unwrap_or_default()
                    .to_string()
            }
        })
        .into_owned()
}

fn trailing_axis_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^([ \t]*)([A-Za-z][A-Za-z0-9-]*?)-(x|y)\s*:\s*([^;{}]+);[ \t]*$")
            .expect("legacy axis shorthand regex must compile")
    })
}

fn border_middle_axis_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^([ \t]*)(border)-(x|y)-(color|style|width)\s*:\s*([^;{}]+);[ \t]*$")
            .expect("legacy border middle-axis shorthand regex must compile")
    })
}

fn axis_pair(base: &str, axis: &str) -> Option<(&'static str, &'static str)> {
    match (base, axis) {
        ("margin", "x") => Some(("margin-left", "margin-right")),
        ("margin", "y") => Some(("margin-top", "margin-bottom")),
        ("padding", "x") => Some(("padding-left", "padding-right")),
        ("padding", "y") => Some(("padding-top", "padding-bottom")),
        ("border", "x") => Some(("border-left", "border-right")),
        ("border", "y") => Some(("border-top", "border-bottom")),
        ("border-width", "x") => Some(("border-left-width", "border-right-width")),
        ("border-width", "y") => Some(("border-top-width", "border-bottom-width")),
        ("border-style", "x") => Some(("border-left-style", "border-right-style")),
        ("border-style", "y") => Some(("border-top-style", "border-bottom-style")),
        ("border-color", "x") => Some(("border-left-color", "border-right-color")),
        ("border-color", "y") => Some(("border-top-color", "border-bottom-color")),
        ("inset", "x") => Some(("left", "right")),
        ("inset", "y") => Some(("top", "bottom")),
        ("scroll-margin", "x") => Some(("scroll-margin-left", "scroll-margin-right")),
        ("scroll-margin", "y") => Some(("scroll-margin-top", "scroll-margin-bottom")),
        ("scroll-padding", "x") => Some(("scroll-padding-left", "scroll-padding-right")),
        ("scroll-padding", "y") => Some(("scroll-padding-top", "scroll-padding-bottom")),
        _ => None,
    }
}
