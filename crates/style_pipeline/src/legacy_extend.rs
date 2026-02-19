use std::collections::HashMap;

pub(crate) fn apply_legacy_extend_selectors(content: &str) -> String {
    process_scope(content)
}

fn process_scope(content: &str) -> String {
    let mut rules = Vec::<RuleNode>::new();
    let mut at_rules = Vec::<AtRuleNode>::new();
    let mut raw_parts = Vec::<RawNode>::new();

    let bytes = content.as_bytes();
    let mut i = 0usize;
    let mut last = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'{' {
            let prelude_raw = content[last..i].trim();
            if let Some((inner, end)) = crate::parse_balanced_block(content, i) {
                if !prelude_raw.is_empty() {
                    if prelude_raw.starts_with('@') {
                        at_rules.push(AtRuleNode {
                            prelude: prelude_raw.to_string(),
                            body: process_scope(&inner),
                            ordinal: last,
                        });
                    } else {
                        rules.push(RuleNode {
                            selectors: split_selectors(prelude_raw),
                            body: inner,
                            ordinal: last,
                        });
                    }
                }
                i = end;
                last = end;
                continue;
            }
        }
        i += 1;
    }

    if last < content.len() {
        raw_parts.push(RawNode {
            raw: content[last..].to_string(),
            ordinal: last,
        });
    }

    // Gather and remove @extend declarations from rule bodies.
    let mut extends_map = HashMap::<String, Vec<String>>::new();
    for rule in &mut rules {
        let (body_wo_extends, targets) = strip_extends(&rule.body);
        rule.body = body_wo_extends;
        for target in targets {
            let list = extends_map.entry(target).or_default();
            for selector in &rule.selectors {
                if !list.iter().any(|s| s == selector) {
                    list.push(selector.clone());
                }
            }
        }
    }

    // Apply extends to target selectors.
    for rule in &mut rules {
        let mut merged = rule.selectors.clone();
        for selector in &rule.selectors {
            if let Some(extra) = extends_map.get(selector) {
                for s in extra {
                    if !merged.iter().any(|x| x == s) {
                        merged.push(s.clone());
                    }
                }
            }
        }
        rule.selectors = merged;
    }

    let mut nodes = Vec::<RenderNode>::new();
    for rule in rules {
        if rule.body.trim().is_empty() {
            continue;
        }
        nodes.push(RenderNode::Rule(rule));
    }
    for at in at_rules {
        nodes.push(RenderNode::AtRule(at));
    }
    for raw in raw_parts {
        nodes.push(RenderNode::Raw(raw));
    }
    nodes.sort_by_key(|n| n.ordinal());

    let mut out = String::new();
    for node in nodes {
        match node {
            RenderNode::Rule(rule) => {
                if rule.selectors.is_empty() {
                    continue;
                }
                out.push_str(&rule.selectors.join(", "));
                out.push_str(" {\n");
                out.push_str(rule.body.trim());
                out.push_str("\n}\n");
            }
            RenderNode::AtRule(at) => {
                out.push_str(&at.prelude);
                out.push_str(" {\n");
                out.push_str(at.body.trim());
                out.push_str("\n}\n");
            }
            RenderNode::Raw(raw) => out.push_str(&raw.raw),
        }
    }

    out
}

fn strip_extends(body: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(body.len());
    let mut targets = Vec::<String>::new();

    let bytes = body.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if starts_with_bytes_at(bytes, i, b"@extend") {
            let mut j = i + "@extend".len();
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            let target_start = j;
            while j < bytes.len() && bytes[j] != b';' && bytes[j] != b'\n' && bytes[j] != b'{' {
                j += 1;
            }
            let target = body[target_start..j].trim();
            if !target.is_empty() {
                targets.push(target.to_string());
            }
            if j < bytes.len() && bytes[j] == b';' {
                i = j + 1;
            } else {
                i = j;
            }
            continue;
        }
        let ch = body[i..].chars().next().unwrap_or('\0');
        if ch == '\0' {
            break;
        }
        out.push(ch);
        i += ch.len_utf8();
    }

    (out, targets)
}

fn split_selectors(prelude: &str) -> Vec<String> {
    let mut parts = Vec::<String>::new();
    let mut cur = String::new();
    let mut paren = 0i32;
    let mut bracket = 0i32;
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;

    for ch in prelude.chars() {
        if in_single {
            cur.push(ch);
            if !escaped && ch == '\'' {
                in_single = false;
            }
            escaped = ch == '\\' && !escaped;
            continue;
        }
        if in_double {
            cur.push(ch);
            if !escaped && ch == '"' {
                in_double = false;
            }
            escaped = ch == '\\' && !escaped;
            continue;
        }

        match ch {
            '\'' => {
                in_single = true;
                escaped = false;
                cur.push(ch);
            }
            '"' => {
                in_double = true;
                escaped = false;
                cur.push(ch);
            }
            '(' => {
                paren += 1;
                cur.push(ch);
            }
            ')' => {
                paren -= 1;
                cur.push(ch);
            }
            '[' => {
                bracket += 1;
                cur.push(ch);
            }
            ']' => {
                bracket -= 1;
                cur.push(ch);
            }
            ',' if paren == 0 && bracket == 0 => {
                let s = cur.trim();
                if !s.is_empty() {
                    parts.push(s.to_string());
                }
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    let tail = cur.trim();
    if !tail.is_empty() {
        parts.push(tail.to_string());
    }
    parts
}

fn starts_with_bytes_at(haystack: &[u8], offset: usize, needle: &[u8]) -> bool {
    haystack
        .get(offset..)
        .map(|tail| tail.starts_with(needle))
        .unwrap_or(false)
}

struct RuleNode {
    selectors: Vec<String>,
    body: String,
    ordinal: usize,
}

struct AtRuleNode {
    prelude: String,
    body: String,
    ordinal: usize,
}

struct RawNode {
    raw: String,
    ordinal: usize,
}

enum RenderNode {
    Rule(RuleNode),
    AtRule(AtRuleNode),
    Raw(RawNode),
}

impl RenderNode {
    fn ordinal(&self) -> usize {
        match self {
            Self::Rule(v) => v.ordinal,
            Self::AtRule(v) => v.ordinal,
            Self::Raw(v) => v.ordinal,
        }
    }
}

