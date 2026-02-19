use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use lightningcss::stylesheet::{MinifyOptions, ParserOptions, PrinterOptions, StyleSheet};
use lightningcss::targets::{Browsers, Targets as LightningTargets};
use parcel_sourcemap::SourceMap;
use regex::Regex;
use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub input: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceMapMode {
    None,
    Inline,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Targets {
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetConfig {
    pub rewrite_urls: bool,
    pub enable_svg_fallback: bool,
    pub svg_fallback_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompatibilityMode {
    LegacyCompatible,
    StrictLightning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineConfig {
    pub entries: Vec<Entry>,
    pub out_dir: PathBuf,
    pub source_maps: SourceMapMode,
    pub minify: bool,
    pub targets: Targets,
    pub browserslist_query: Option<String>,
    pub import_roots: Vec<PathBuf>,
    pub asset: AssetConfig,
    pub compatibility: CompatibilityMode,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            out_dir: PathBuf::from("."),
            source_maps: SourceMapMode::External,
            minify: false,
            targets: Targets { query: None },
            browserslist_query: None,
            import_roots: Vec::new(),
            asset: AssetConfig {
                rewrite_urls: true,
                enable_svg_fallback: false,
                svg_fallback_dir: None,
            },
            compatibility: CompatibilityMode::LegacyCompatible,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileRequest {
    pub cwd: PathBuf,
    pub config: PipelineConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileArtifact {
    pub entry: PathBuf,
    pub css_path: PathBuf,
    pub map_path: Option<PathBuf>,
    pub extra_outputs: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileResult {
    pub artifacts: Vec<CompileArtifact>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageKind {
    Pre,
    Post,
}

#[derive(Debug, Clone)]
pub struct StageContext<'a> {
    pub cwd: &'a Path,
    pub config: &'a PipelineConfig,
}

pub trait PreTransformStage: Send + Sync {
    fn name(&self) -> &'static str;
    fn priority(&self) -> i32 {
        0
    }
    fn run(
        &self,
        ctx: &StageContext<'_>,
        entry: &Path,
        input: String,
    ) -> Result<String, PipelineError>;
}

pub trait PostTransformStage: Send + Sync {
    fn name(&self) -> &'static str;
    fn priority(&self) -> i32 {
        0
    }
    fn run(
        &self,
        ctx: &StageContext<'_>,
        entry: &Path,
        output: String,
    ) -> Result<String, PipelineError>;
}

#[derive(Default, Clone)]
pub struct StageRegistry {
    pre_stages: Vec<Arc<dyn PreTransformStage>>,
    post_stages: Vec<Arc<dyn PostTransformStage>>,
}

impl StageRegistry {
    pub fn register_pre<S>(&mut self, stage: S) -> Result<(), PipelineError>
    where
        S: PreTransformStage + 'static,
    {
        ensure_unique_stage_name(self.pre_stages.iter().map(|s| s.name()), stage.name(), StageKind::Pre)?;
        self.pre_stages.push(Arc::new(stage));
        self.pre_stages
            .sort_by_key(|s| (s.priority(), s.name()));
        Ok(())
    }

    pub fn register_post<S>(&mut self, stage: S) -> Result<(), PipelineError>
    where
        S: PostTransformStage + 'static,
    {
        ensure_unique_stage_name(self.post_stages.iter().map(|s| s.name()), stage.name(), StageKind::Post)?;
        self.post_stages.push(Arc::new(stage));
        self.post_stages
            .sort_by_key(|s| (s.priority(), s.name()));
        Ok(())
    }

    fn run_pre(
        &self,
        ctx: &StageContext<'_>,
        entry: &Path,
        mut input: String,
    ) -> Result<String, PipelineError> {
        for stage in &self.pre_stages {
            input = stage.run(ctx, entry, input)?;
        }
        Ok(input)
    }

    fn run_post(
        &self,
        ctx: &StageContext<'_>,
        entry: &Path,
        mut output: String,
    ) -> Result<String, PipelineError> {
        for stage in &self.post_stages {
            output = stage.run(ctx, entry, output)?;
        }
        Ok(output)
    }

    pub fn pre_stage_names(&self) -> Vec<&'static str> {
        self.pre_stages.iter().map(|s| s.name()).collect()
    }

    pub fn post_stage_names(&self) -> Vec<&'static str> {
        self.post_stages.iter().map(|s| s.name()).collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipelineError {
    InvalidConfig(String),
    Stage(String),
    Resolve(String),
    Io(String),
    Compile(String),
    Emit(String),
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(message) => write!(f, "{message}"),
            Self::Stage(message) => write!(f, "{message}"),
            Self::Resolve(message) => write!(f, "{message}"),
            Self::Io(message) => write!(f, "{message}"),
            Self::Compile(message) => write!(f, "{message}"),
            Self::Emit(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for PipelineError {}

pub fn compile(req: CompileRequest) -> Result<CompileResult, PipelineError> {
    let stages = build_feature_registry()?;
    compile_with_registry(req, &stages)
}

pub fn build_feature_registry() -> Result<StageRegistry, PipelineError> {
    #[allow(unused_mut)]
    let mut stages = StageRegistry::default();

    #[cfg(feature = "plugin_svg_fallback")]
    stages.register_post(PluginSvgFallbackStage)?;

    #[cfg(feature = "plugin_data_inline")]
    stages.register_post(PluginDataInlineStage)?;

    Ok(stages)
}

pub fn compile_with_registry(
    req: CompileRequest,
    stages: &StageRegistry,
) -> Result<CompileResult, PipelineError> {
    validate_config(&req.config)?;
    let entries = if req.config.entries.is_empty() {
        discover_entries(&req.cwd.join(&req.config.out_dir))?
    } else {
        req.config.entries.clone()
    };

    if entries.is_empty() {
        return Err(PipelineError::InvalidConfig(
            "No entry files matching _main*.css were found in <out_dir>/src".to_string(),
        ));
    }

    let mut artifacts: Vec<CompileArtifact> = entries
        .iter()
        .map(|entry| CompileArtifact {
            entry: entry.input.clone(),
            css_path: output_css_path(&req.config.out_dir, &entry.input),
            map_path: output_map_path(&req.config.out_dir, &entry.input, &req.config.source_maps),
            extra_outputs: Vec::new(),
        })
        .collect();

    let targets = resolve_targets(&req.config)?;
    for artifact in &mut artifacts {
        artifact.extra_outputs = compile_and_emit_entry(&req, artifact, targets, stages)?;
    }

    Ok(CompileResult {
        artifacts,
        diagnostics: vec![Diagnostic {
            code: "PLANNED_OUTPUTS",
            message:
                "style_pipeline compile stub: entry discovery and output contract are implemented"
                    .to_string(),
        }],
    })
}

fn ensure_unique_stage_name<'a, I>(
    existing: I,
    candidate: &'static str,
    kind: StageKind,
) -> Result<(), PipelineError>
where
    I: Iterator<Item = &'a str>,
{
    if existing.into_iter().any(|name| name == candidate) {
        return Err(PipelineError::Stage(format!(
            "Duplicate {:?} stage name: '{}'",
            kind, candidate
        )));
    }
    Ok(())
}

#[cfg(feature = "plugin_svg_fallback")]
struct PluginSvgFallbackStage;

#[cfg(feature = "plugin_svg_fallback")]
impl PostTransformStage for PluginSvgFallbackStage {
    fn name(&self) -> &'static str {
        "plugin_svg_fallback"
    }

    fn run(
        &self,
        _ctx: &StageContext<'_>,
        _entry: &Path,
        output: String,
    ) -> Result<String, PipelineError> {
        Ok(output)
    }
}

#[cfg(feature = "plugin_data_inline")]
struct PluginDataInlineStage;

#[cfg(feature = "plugin_data_inline")]
impl PostTransformStage for PluginDataInlineStage {
    fn name(&self) -> &'static str {
        "plugin_data_inline"
    }

    fn run(
        &self,
        _ctx: &StageContext<'_>,
        _entry: &Path,
        output: String,
    ) -> Result<String, PipelineError> {
        Ok(output)
    }
}

pub fn validate_config(config: &PipelineConfig) -> Result<(), PipelineError> {
    if config.out_dir.as_os_str().is_empty() {
        return Err(PipelineError::InvalidConfig(
            "Pipeline config must define out_dir".to_string(),
        ));
    }
    Ok(())
}

pub fn discover_entries(style_dir: &Path) -> Result<Vec<Entry>, PipelineError> {
    let src_dir = style_dir.join("src");
    if !src_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&src_dir).map_err(|err| {
        PipelineError::Io(format!(
            "Failed to read style source directory '{}': {err}",
            src_dir.display()
        ))
    })?;

    for dir_entry in read_dir {
        let dir_entry = dir_entry.map_err(|err| {
            PipelineError::Io(format!(
                "Failed to iterate style source directory '{}': {err}",
                src_dir.display()
            ))
        })?;
        let path = dir_entry.path();

        if !path.is_file() || path.extension() != Some(OsStr::new("css")) {
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|f| f.to_str()) else {
            continue;
        };

        if file_name.starts_with("_main") {
            entries.push(Entry { input: path });
        }
    }

    entries.sort_by(|a, b| a.input.cmp(&b.input));
    Ok(entries)
}

fn output_css_path(out_dir: &Path, input: &Path) -> PathBuf {
    let file_name = input.file_name().and_then(|f| f.to_str()).unwrap_or("_main.css");
    let output_name = file_name.strip_prefix('_').unwrap_or(file_name);
    out_dir.join(output_name)
}

fn output_map_path(out_dir: &Path, input: &Path, source_maps: &SourceMapMode) -> Option<PathBuf> {
    if !matches!(source_maps, SourceMapMode::External) {
        return None;
    }
    let css_path = output_css_path(out_dir, input);
    let css_name = css_path.file_name().and_then(|f| f.to_str()).unwrap_or("main.css");
    Some(out_dir.join("maps").join(format!("{css_name}.map")))
}

fn compile_and_emit_entry(
    req: &CompileRequest,
    artifact: &CompileArtifact,
    targets: LightningTargets,
    stages: &StageRegistry,
) -> Result<Vec<PathBuf>, PipelineError> {
    let input_abs = req.cwd.join(&artifact.entry);
    let css_abs = req.cwd.join(&artifact.css_path);

    let stage_ctx = StageContext {
        cwd: &req.cwd,
        config: &req.config,
    };
    let source = preprocess_entry_source(req, &input_abs)?;
    let source = stages.run_pre(&stage_ctx, &artifact.entry, source)?;

    let mut sheet = StyleSheet::parse(
        &source,
        ParserOptions {
            filename: input_abs.display().to_string(),
            ..ParserOptions::default()
        },
    )
    .map_err(|err| {
        PipelineError::Compile(format!(
            "Failed to parse css '{}': {err}",
            artifact.entry.display()
        ))
    })?;

    if req.config.minify || targets.browsers.is_some() {
        sheet
            .minify(MinifyOptions {
                targets,
                ..MinifyOptions::default()
            })
            .map_err(|err| {
                PipelineError::Compile(format!(
                    "Failed to transform css '{}': {err}",
                    artifact.entry.display()
                ))
            })?;
    }

    let mut source_map = match req.config.source_maps {
        SourceMapMode::External => Some(SourceMap::new(&req.cwd.display().to_string())),
        _ => None,
    };

    let mut to_css_options = PrinterOptions {
        minify: req.config.minify,
        targets,
        ..PrinterOptions::default()
    };
    if let Some(sm) = source_map.as_mut() {
        to_css_options.source_map = Some(sm);
    }

    let mut css_code = sheet
        .to_css(to_css_options)
        .map_err(|err| {
            PipelineError::Compile(format!(
                "Failed to serialize css '{}': {err}",
                artifact.entry.display()
            ))
        })?
        .code;
    css_code = stages.run_post(&stage_ctx, &artifact.entry, css_code)?;

    if let Some(map_path) = &artifact.map_path {
        let map_rel = map_rel_path(&req.config.out_dir, map_path);
        css_code.push_str(&format!("\n/*# sourceMappingURL={map_rel} */\n"));
    }

    write_file(&css_abs, css_code.as_bytes())?;

    let extra_outputs = emit_svg_fallback_assets(req, &css_code)?;

    if let (Some(sm), Some(map_path)) = (source_map.as_mut(), &artifact.map_path) {
        if sm.get_sources().is_empty() {
            sm.add_empty_map(&artifact.entry.display().to_string(), &source, 0)
                .map_err(|err| {
                    PipelineError::Emit(format!(
                        "Failed to generate fallback source mappings for '{}': {err}",
                        artifact.entry.display()
                    ))
                })?;
        }
        let map_json = source_map_to_json(sm)?;
        write_file(&req.cwd.join(map_path), map_json.as_bytes())?;
    }

    Ok(extra_outputs)
}

fn emit_svg_fallback_assets(req: &CompileRequest, css_code: &str) -> Result<Vec<PathBuf>, PipelineError> {
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
        let raw = strip_quotes(m.as_str().trim());
        let (path_part, _) = split_url_suffix(raw);
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

        write_file(&req.cwd.join(&rel), b"")?;
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
    if should_keep_url_unmodified(p) && !p.starts_with('/') {
        return false;
    }
    p.to_ascii_lowercase().ends_with(".svg")
}

fn preprocess_entry_source(req: &CompileRequest, entry_abs: &Path) -> Result<String, PipelineError> {
    let mut stack = HashSet::new();
    let mut source = preprocess_source_recursive(req, entry_abs, &mut stack)?;
    if matches!(req.config.compatibility, CompatibilityMode::LegacyCompatible) {
        source = apply_legacy_variable_substitution(&source);
        source = apply_legacy_mixins(&source);
        source = apply_legacy_nested_selectors(&source);
    }
    Ok(source)
}

fn preprocess_source_recursive(
    req: &CompileRequest,
    file_abs: &Path,
    stack: &mut HashSet<PathBuf>,
) -> Result<String, PipelineError> {
    let canonical = std::fs::canonicalize(file_abs).map_err(|err| {
        PipelineError::Resolve(format!(
            "Failed to resolve css file '{}': {err}",
            file_abs.display()
        ))
    })?;

    if stack.contains(&canonical) {
        return Err(PipelineError::Resolve(format!(
            "Circular @import detected at '{}'",
            file_abs.display()
        )));
    }
    stack.insert(canonical.clone());

    let mut source = std::fs::read_to_string(&canonical).map_err(|err| {
        PipelineError::Io(format!(
            "Failed to read css file '{}': {err}",
            canonical.display()
        ))
    })?;

    if req.config.asset.rewrite_urls {
        source = apply_legacy_import_url_rewrite(req, &source, &canonical);
    }

    // Equivalent to postcss-import style flattening for simple `@import "..."` forms.
    let import_re = Regex::new(r#"(?m)^\s*@import\s+(?:url\()?\s*["']([^"']+)["']\s*\)?\s*;\s*$"#)
        .expect("import regex must compile");
    let mut result = String::new();
    let mut last = 0usize;

    for capture in import_re.captures_iter(&source) {
        let Some(m) = capture.get(0) else {
            continue;
        };
        let Some(spec) = capture.get(1) else {
            continue;
        };

        result.push_str(&source[last..m.start()]);
        let spec = spec.as_str().trim();

        if is_external_import(spec) {
            result.push_str(m.as_str());
        } else {
            let resolved = resolve_import_path(req, canonical.parent().unwrap_or(Path::new("")), spec)?;
            let imported = preprocess_source_recursive(req, &resolved, stack)?;
            result.push_str(&imported);
            if !imported.ends_with('\n') {
                result.push('\n');
            }
        }
        last = m.end();
    }
    result.push_str(&source[last..]);

    stack.remove(&canonical);
    Ok(result)
}

fn resolve_import_path(req: &CompileRequest, current_dir: &Path, spec: &str) -> Result<PathBuf, PipelineError> {
    let mut candidates = Vec::<PathBuf>::new();
    let spec_path = PathBuf::from(spec);

    if spec_path.is_absolute() {
        candidates.push(spec_path);
    } else {
        candidates.push(current_dir.join(&spec_path));
        for root in &req.config.import_roots {
            let abs_root = if root.is_absolute() {
                root.clone()
            } else {
                req.cwd.join(root)
            };
            candidates.push(abs_root.join(&spec_path));
        }
    }

    for candidate in candidates {
        if let Some(found) = candidate_with_css_extension(candidate) {
            return Ok(found);
        }
    }

    Err(PipelineError::Resolve(format!(
        "Failed to resolve @import '{}'",
        spec
    )))
}

fn candidate_with_css_extension(candidate: PathBuf) -> Option<PathBuf> {
    if candidate.exists() {
        return Some(candidate);
    }
    if candidate.extension().is_none() {
        let css = candidate.with_extension("css");
        if css.exists() {
            return Some(css);
        }
    }
    None
}

fn is_external_import(spec: &str) -> bool {
    spec.starts_with("http://")
        || spec.starts_with("https://")
        || spec.starts_with("data:")
        || spec.starts_with("//")
}

fn apply_legacy_import_url_rewrite(req: &CompileRequest, content: &str, file_abs: &Path) -> String {
    // PR-07 scope: rewrite-only URL stage (no inline/filter).
    let url_re = Regex::new(r#"url\(([^(]*)\)"#).expect("url regex must compile");
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

fn should_keep_url_unmodified(url: &str) -> bool {
    let value = url.trim();
    value.is_empty()
        || value.starts_with("data:")
        || value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("//")
        || value.starts_with('/')
        || value.starts_with('#')
}

fn split_url_suffix(url: &str) -> (&str, &str) {
    match url.find(['?', '#']) {
        Some(index) => (&url[..index], &url[index..]),
        None => (url, ""),
    }
}

fn strip_quotes(s: &str) -> &str {
    s.trim_matches(|c| c == '\'' || c == '"' || c == ' ')
}

fn path_relative_to(base: &Path, target: &Path) -> PathBuf {
    target.strip_prefix(base).unwrap_or(target).to_path_buf()
}

fn normalize_slashes(s: &str) -> String {
    s.replace('\\', "/")
}

fn apply_legacy_variable_substitution(content: &str) -> String {
    let var_decl_re = Regex::new(r#"(?m)^\s*\$([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*;\s*$"#)
        .expect("legacy variable declaration regex must compile");
    let var_ref_re =
        Regex::new(r#"\$([A-Za-z_][A-Za-z0-9_-]*)"#).expect("legacy variable ref regex must compile");

    let mut vars = HashMap::<String, String>::new();
    for capture in var_decl_re.captures_iter(content) {
        let Some(name) = capture.get(1).map(|m| m.as_str().to_string()) else {
            continue;
        };
        let Some(value) = capture.get(2).map(|m| m.as_str().trim().to_string()) else {
            continue;
        };
        vars.insert(name, value);
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

fn apply_legacy_mixins(content: &str) -> String {
    let (mut without_defs, mixins) = extract_legacy_mixin_definitions(content);
    if mixins.is_empty() {
        return without_defs;
    }

    for _ in 0..8 {
        let expanded = expand_legacy_mixin_calls(&without_defs, &mixins);
        if expanded == without_defs {
            break;
        }
        without_defs = expanded;
    }
    without_defs
}

fn apply_legacy_nested_selectors(content: &str) -> String {
    flatten_css_level(content)
}

fn flatten_css_level(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let bytes = content.as_bytes();
    let mut i = 0usize;
    let mut last = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'{' {
            let prelude = content[last..i].trim();
            if let Some((inner, end)) = parse_balanced_block(content, i) {
                if prelude.starts_with('@') {
                    // Keep at-rules structure, but flatten inside.
                    out.push_str(&content[last..i]);
                    out.push('{');
                    out.push_str(&flatten_css_level(&inner));
                    out.push('}');
                } else {
                    let selectors = split_selectors(prelude);
                    if selectors.is_empty() {
                        out.push_str(&content[last..end]);
                    } else {
                        out.push_str(&flatten_rule_block(&selectors, &inner));
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
        out.push_str(&content[last..]);
    }
    out
}

fn flatten_rule_block(parent_selectors: &[String], inner: &str) -> String {
    let mut local = String::new();
    let mut nested_out = String::new();
    let bytes = inner.as_bytes();
    let mut i = 0usize;
    let mut last = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'{' {
            let prelude = inner[last..i].trim();
            if let Some((child_inner, end)) = parse_balanced_block(inner, i) {
                local.push_str(&inner[last..i]);
                if prelude.starts_with('@') {
                    // Preserve nested at-rules in-place under current selector.
                    local.push('{');
                    local.push_str(&flatten_css_level(&child_inner));
                    local.push('}');
                } else {
                    let child_selectors = split_selectors(prelude);
                    if child_selectors.is_empty() {
                        local.push('{');
                        local.push_str(&child_inner);
                        local.push('}');
                    } else {
                        let combined = combine_selectors(parent_selectors, &child_selectors);
                        nested_out.push_str(&flatten_rule_block(&combined, &child_inner));
                    }
                }
                i = end;
                last = end;
                continue;
            }
        }
        i += 1;
    }
    if last < inner.len() {
        local.push_str(&inner[last..]);
    }

    let mut out = String::new();
    if !local.trim().is_empty() {
        out.push_str(&parent_selectors.join(", "));
        out.push_str(" {\n");
        out.push_str(local.trim());
        out.push_str("\n}\n");
    }
    out.push_str(&nested_out);
    out
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

fn combine_selectors(parents: &[String], children: &[String]) -> Vec<String> {
    let mut out = Vec::<String>::new();
    for p in parents {
        for c in children {
            let combined = if c.contains('&') {
                c.replace('&', p)
            } else {
                format!("{p} {c}")
            };
            let normalized = combined.split_whitespace().collect::<Vec<_>>().join(" ");
            out.push(normalized);
        }
    }
    out
}

fn extract_legacy_mixin_definitions(content: &str) -> (String, HashMap<String, String>) {
    let mut out = String::with_capacity(content.len());
    let mut mixins = HashMap::<String, String>::new();
    let bytes = content.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if starts_with_bytes_at(bytes, i, b"@define-mixin") {
            let mut j = i + "@define-mixin".len();
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            let name_start = j;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-')
            {
                j += 1;
            }
            let name = content.get(name_start..j).unwrap_or("").trim();
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if name.is_empty() || j >= bytes.len() || bytes[j] != b'{' {
                let ch = content[i..].chars().next().unwrap_or('\0');
                if ch != '\0' {
                    out.push(ch);
                    i += ch.len_utf8();
                } else {
                    i += 1;
                }
                continue;
            }

            if let Some((body, end)) = parse_balanced_block(content, j) {
                mixins.insert(name.to_string(), body);
                i = end;
                continue;
            }
        }

        let ch = content[i..].chars().next().unwrap_or('\0');
        if ch != '\0' {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            i += 1;
        }
    }

    (out, mixins)
}

fn expand_legacy_mixin_calls(content: &str, mixins: &HashMap<String, String>) -> String {
    let mixin_content_re =
        Regex::new(r"@mixin-content\s*;?").expect("mixin-content regex must compile");
    let mut out = String::with_capacity(content.len());
    let bytes = content.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if starts_with_bytes_at(bytes, i, b"@mixin") {
            let mut j = i + "@mixin".len();
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            let name_start = j;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-')
            {
                j += 1;
            }
            let name = content.get(name_start..j).unwrap_or("").trim();
            if name.is_empty() {
                let ch = content[i..].chars().next().unwrap_or('\0');
                if ch != '\0' {
                    out.push(ch);
                    i += ch.len_utf8();
                } else {
                    i += 1;
                }
                continue;
            }

            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }

            if let Some(body) = mixins.get(name) {
                if j < bytes.len() && bytes[j] == b';' {
                    let expanded = mixin_content_re.replace_all(body, "").to_string();
                    out.push_str(&expanded);
                    i = j + 1;
                    continue;
                }
                if j < bytes.len() && bytes[j] == b'{' {
                    if let Some((inner, end)) = parse_balanced_block(content, j) {
                        let expanded = mixin_content_re.replace_all(body, inner).to_string();
                        out.push_str(&expanded);
                        i = end;
                        continue;
                    }
                }
            }
        }

        let ch = content[i..].chars().next().unwrap_or('\0');
        if ch != '\0' {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            i += 1;
        }
    }

    out
}

fn starts_with_bytes_at(haystack: &[u8], offset: usize, needle: &[u8]) -> bool {
    haystack
        .get(offset..)
        .map(|tail| tail.starts_with(needle))
        .unwrap_or(false)
}

fn parse_balanced_block(content: &str, open_brace_index: usize) -> Option<(String, usize)> {
    let bytes = content.as_bytes();
    if open_brace_index >= bytes.len() || bytes[open_brace_index] != b'{' {
        return None;
    }

    let mut depth = 0usize;
    let mut i = open_brace_index;
    let start = open_brace_index + 1;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut escaped = false;

    while i < bytes.len() {
        let b = bytes[i];
        let next = bytes.get(i + 1).copied();

        if in_line_comment {
            if b == b'\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        if in_block_comment {
            if b == b'*' && next == Some(b'/') {
                in_block_comment = false;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }

        if in_single {
            if !escaped && b == b'\'' {
                in_single = false;
            }
            escaped = b == b'\\' && !escaped;
            i += 1;
            continue;
        }
        if in_double {
            if !escaped && b == b'"' {
                in_double = false;
            }
            escaped = b == b'\\' && !escaped;
            i += 1;
            continue;
        }

        if b == b'/' && next == Some(b'/') {
            in_line_comment = true;
            i += 2;
            continue;
        }
        if b == b'/' && next == Some(b'*') {
            in_block_comment = true;
            i += 2;
            continue;
        }

        if b == b'\'' {
            in_single = true;
            escaped = false;
            i += 1;
            continue;
        }
        if b == b'"' {
            in_double = true;
            escaped = false;
            i += 1;
            continue;
        }

        if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            if depth == 0 {
                return None;
            }
            depth -= 1;
            if depth == 0 {
                let inner = content[start..i].to_string();
                return Some((inner, i + 1));
            }
        }
        i += 1;
    }

    None
}

fn write_file(path: &Path, content: &[u8]) -> Result<(), PipelineError> {
    let parent = path.parent().ok_or_else(|| {
        PipelineError::Emit(format!(
            "Cannot determine parent directory for '{}'",
            path.display()
        ))
    })?;
    std::fs::create_dir_all(parent).map_err(|err| {
        PipelineError::Emit(format!(
            "Failed to create output directory '{}': {err}",
            parent.display()
        ))
    })?;
    let mut file = std::fs::File::create(path).map_err(|err| {
        PipelineError::Emit(format!(
            "Failed to create output file '{}': {err}",
            path.display()
        ))
    })?;
    file.write_all(content).map_err(|err| {
        PipelineError::Emit(format!(
            "Failed to write output file '{}': {err}",
            path.display()
        ))
    })
}

fn resolve_targets(config: &PipelineConfig) -> Result<LightningTargets, PipelineError> {
    let query = config
        .browserslist_query
        .as_deref()
        .or(config.targets.query.as_deref());

    let Some(query) = query else {
        return Ok(LightningTargets::default());
    };

    let browsers = Browsers::from_browserslist([query]).map_err(|err| {
        PipelineError::InvalidConfig(format!(
            "Invalid browserslist query '{query}': {err}"
        ))
    })?;

    Ok(LightningTargets::from(browsers))
}

fn map_rel_path(out_dir: &Path, map_path: &Path) -> String {
    map_path
        .strip_prefix(out_dir)
        .ok()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| map_path.display().to_string())
}

fn source_map_to_json(map: &mut SourceMap) -> Result<String, PipelineError> {
    let mut mappings = Vec::new();
    map.write_vlq(&mut mappings)
        .map_err(|err| PipelineError::Emit(format!("Failed to generate source map mappings: {err}")))?;
    let mappings = String::from_utf8(mappings)
        .map_err(|err| PipelineError::Emit(format!("Invalid source map encoding: {err}")))?;

    let value = json!({
        "version": 3,
        "sources": map.get_sources(),
        "sourcesContent": map.get_sources_content(),
        "names": map.get_names(),
        "mappings": mappings,
    });

    serde_json::to_string(&value)
        .map_err(|err| PipelineError::Emit(format!("Failed to serialize source map JSON: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn pipeline_config_defaults_are_stable() {
        let cfg = PipelineConfig::default();
        assert_eq!(cfg.entries.len(), 0);
        assert_eq!(cfg.out_dir, PathBuf::from("."));
        assert_eq!(cfg.source_maps, SourceMapMode::External);
        assert_eq!(cfg.minify, false);
        assert_eq!(cfg.compatibility, CompatibilityMode::LegacyCompatible);
        assert_eq!(cfg.asset.rewrite_urls, true);
        assert_eq!(cfg.asset.enable_svg_fallback, false);
        assert_eq!(cfg.asset.svg_fallback_dir, None);
    }

    #[test]
    fn validate_config_accepts_discovery_mode_without_entries() {
        let cfg = PipelineConfig::default();
        validate_config(&cfg).expect("empty entries are valid when discovery mode is used");
    }

    #[test]
    fn compile_returns_planned_artifacts_for_explicit_entries() {
        let temp = std::env::temp_dir().join("style_pipeline_unit_compile_explicit");
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(temp.join("assets/css/src")).expect("must create fixture dir");
        std::fs::write(temp.join("assets/css/src/_main.css"), ".a { color: red; }")
            .expect("must write fixture css");

        let mut cfg = PipelineConfig::default();
        cfg.entries.push(Entry {
            input: PathBuf::from("assets/css/src/_main.css"),
        });
        cfg.out_dir = PathBuf::from("assets/css");

        let result = compile(CompileRequest {
            cwd: temp.clone(),
            config: cfg,
        })
        .expect("valid config should compile in stub mode");

        assert_eq!(result.artifacts.len(), 1);
        assert_eq!(result.artifacts[0].css_path, PathBuf::from("assets/css/main.css"));
        assert_eq!(
            result.artifacts[0].map_path,
            Some(PathBuf::from("assets/css/maps/main.css.map"))
        );
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].code, "PLANNED_OUTPUTS");
        assert!(temp.join("assets/css/main.css").exists());
    }

    #[test]
    fn legacy_import_url_rewrite_rewrites_simple_relative_urls() {
        let cwd = PathBuf::from("/tmp/project");
        let file = PathBuf::from("/tmp/project/assets/css/src/modules/_feature.css");
        let input = r#".a { background: url(icon.svg); }"#;
        let req = CompileRequest {
            cwd,
            config: PipelineConfig::default(),
        };
        let out = apply_legacy_import_url_rewrite(&req, input, &file);
        assert!(out.contains(r#"url("/assets/css/src/modules/icon.svg")"#));
    }

    #[test]
    fn legacy_import_url_rewrite_keeps_data_http_and_absolute_urls() {
        let cwd = PathBuf::from("/tmp/project");
        let file = PathBuf::from("/tmp/project/assets/css/src/modules/_feature.css");
        let input = r#"
            .a { background: url(data:image/svg+xml;base64,abc); }
            .b { background: url(https://example.com/x.png); }
            .c { background: url(/assets/img/a.png); }
            .d { background: url(#icon-id); }
        "#;
        let req = CompileRequest {
            cwd,
            config: PipelineConfig::default(),
        };
        let out = apply_legacy_import_url_rewrite(&req, input, &file);
        assert!(out.contains(r#"url("data:image/svg+xml;base64,abc")"#));
        assert!(out.contains(r#"url("https://example.com/x.png")"#));
        assert!(out.contains(r#"url("/assets/img/a.png")"#));
        assert!(out.contains(r##"url("#icon-id")"##));
    }

    #[test]
    fn legacy_import_url_rewrite_preserves_query_and_fragment() {
        let cwd = PathBuf::from("/tmp/project");
        let file = PathBuf::from("/tmp/project/assets/css/src/modules/_feature.css");
        let input = r#".a { background: url(icons/x.svg?v=1#view); }"#;
        let req = CompileRequest {
            cwd,
            config: PipelineConfig::default(),
        };
        let out = apply_legacy_import_url_rewrite(&req, input, &file);
        assert!(out.contains(r#"url("/assets/css/src/modules/icons/x.svg?v=1#view")"#));
    }

    #[test]
    fn legacy_variable_substitution_removes_declarations_and_replaces_refs() {
        let input = r#"
            $base: #111;
            $accent: $base;
            .a { color: $accent; }
            .b { border-color: $base; }
        "#;
        let out = apply_legacy_variable_substitution(input);
        assert!(!out.contains("$base:"));
        assert!(!out.contains("$accent:"));
        assert!(out.contains(".a { color: #111; }"));
        assert!(out.contains(".b { border-color: #111; }"));
    }

    #[test]
    fn legacy_mixins_expand_simple_and_content_forms() {
        let input = r#"
            @define-mixin hocus {
                &:hover { @mixin-content; }
            }
            @define-mixin link {
                color: red;
            }
            .a {
                @mixin hocus { color: blue; }
            }
            .b { @mixin link; }
        "#;

        let out = apply_legacy_mixins(input);
        assert!(!out.contains("@define-mixin"));
        assert!(!out.contains("@mixin hocus"));
        assert!(!out.contains("@mixin link"));
        assert!(out.contains(".a"));
        assert!(out.contains("&:hover"));
        assert!(out.contains("color: blue;"));
        assert!(out.contains(".b"));
        assert!(out.contains("color: red;"));
    }

    #[test]
    fn legacy_mixins_do_not_panic_on_utf8_comments() {
        let input = "/* Примеси */\n@define-mixin x { &:hover { @mixin-content; } }\n.a { @mixin x { color: red; } }";
        let out = apply_legacy_mixins(input);
        assert!(out.contains("color: red;"));
    }

    #[test]
    fn legacy_nested_expands_bem_and_context_patterns() {
        let input = r#"
            .Item {
                &__box {
                    &--truncated { max-width: 1px; }
                }
                .Items__list &:hover &__box { background: yellow; }
            }
        "#;
        let out = apply_legacy_nested_selectors(input);
        assert!(out.contains(".Item__box"));
        assert!(out.contains(".Item__box--truncated"));
        assert!(out.contains(".Items__list .Item:hover .Item__box"));
    }

    #[test]
    fn legacy_nested_expands_double_ampersand_concat() {
        let input = r#"
            .Calendar {
                &__workDay&__today { background: #f9f5da; }
            }
        "#;
        let out = apply_legacy_nested_selectors(input);
        assert!(out.contains(".Calendar__workDay.Calendar__today"));
    }

    #[derive(Clone)]
    struct DemoPreStage {
        name: &'static str,
        priority: i32,
        snippet: &'static str,
    }

    impl PreTransformStage for DemoPreStage {
        fn name(&self) -> &'static str {
            self.name
        }
        fn priority(&self) -> i32 {
            self.priority
        }
        fn run(
            &self,
            _ctx: &StageContext<'_>,
            _entry: &Path,
            input: String,
        ) -> Result<String, PipelineError> {
            Ok(format!("{}\n{}", self.snippet, input))
        }
    }

    #[derive(Clone)]
    struct DemoPostStage {
        name: &'static str,
        priority: i32,
        snippet: &'static str,
    }

    impl PostTransformStage for DemoPostStage {
        fn name(&self) -> &'static str {
            self.name
        }
        fn priority(&self) -> i32 {
            self.priority
        }
        fn run(
            &self,
            _ctx: &StageContext<'_>,
            _entry: &Path,
            output: String,
        ) -> Result<String, PipelineError> {
            Ok(format!("{}\n{}", output, self.snippet))
        }
    }

    #[test]
    fn registry_orders_stages_by_priority_then_name() {
        let mut registry = StageRegistry::default();
        registry
            .register_pre(DemoPreStage {
                name: "z-last",
                priority: 10,
                snippet: ".z{}",
            })
            .expect("stage should register");
        registry
            .register_pre(DemoPreStage {
                name: "a-first",
                priority: 10,
                snippet: ".a{}",
            })
            .expect("stage should register");
        registry
            .register_pre(DemoPreStage {
                name: "prio-zero",
                priority: 0,
                snippet: ".p{}",
            })
            .expect("stage should register");

        let names: Vec<&'static str> = registry.pre_stages.iter().map(|s| s.name()).collect();
        assert_eq!(names, vec!["prio-zero", "a-first", "z-last"]);
    }

    #[test]
    fn registry_rejects_duplicate_stage_names() {
        let mut registry = StageRegistry::default();
        registry
            .register_post(DemoPostStage {
                name: "dup",
                priority: 0,
                snippet: ".a{}",
            })
            .expect("first stage should register");

        let err = registry
            .register_post(DemoPostStage {
                name: "dup",
                priority: 1,
                snippet: ".b{}",
            })
            .expect_err("duplicate stage names must fail");

        assert_eq!(
            err,
            PipelineError::Stage("Duplicate Post stage name: 'dup'".to_string())
        );
    }

    #[test]
    fn compile_with_registry_executes_registered_stages() {
        let temp = std::env::temp_dir().join("style_pipeline_unit_compile_with_registry");
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(temp.join("assets/css/src")).expect("must create fixture dir");
        std::fs::write(temp.join("assets/css/src/_main.css"), ".a { color: red; }")
            .expect("must write fixture css");

        let mut cfg = PipelineConfig::default();
        cfg.entries.push(Entry {
            input: PathBuf::from("assets/css/src/_main.css"),
        });
        cfg.out_dir = PathBuf::from("assets/css");
        cfg.source_maps = SourceMapMode::None;

        let mut registry = StageRegistry::default();
        registry
            .register_pre(DemoPreStage {
                name: "pre-snippet",
                priority: 0,
                snippet: ".from_pre { color: blue; }",
            })
            .expect("pre stage should register");
        registry
            .register_post(DemoPostStage {
                name: "post-snippet",
                priority: 0,
                snippet: ".from_post { display: block; }",
            })
            .expect("post stage should register");

        compile_with_registry(
            CompileRequest {
                cwd: temp.clone(),
                config: cfg,
            },
            &registry,
        )
        .expect("compile with registry should succeed");

        let css = std::fs::read_to_string(temp.join("assets/css/main.css"))
            .expect("css output should exist");
        assert!(css.contains(".from_pre"));
        assert!(css.contains(".from_post"));
    }

    #[cfg(not(any(feature = "plugin_svg_fallback", feature = "plugin_data_inline")))]
    #[test]
    fn feature_registry_is_empty_without_plugin_features() {
        let registry = build_feature_registry().expect("feature registry should build");
        assert!(registry.pre_stage_names().is_empty());
        assert!(registry.post_stage_names().is_empty());
    }

    #[cfg(feature = "plugin_svg_fallback")]
    #[test]
    fn feature_registry_includes_svg_plugin_when_enabled() {
        let registry = build_feature_registry().expect("feature registry should build");
        assert!(registry
            .post_stage_names()
            .contains(&"plugin_svg_fallback"));
    }

    #[cfg(feature = "plugin_data_inline")]
    #[test]
    fn feature_registry_includes_data_inline_plugin_when_enabled() {
        let registry = build_feature_registry().expect("feature registry should build");
        assert!(registry
            .post_stage_names()
            .contains(&"plugin_data_inline"));
    }

    #[cfg(all(feature = "plugin_svg_fallback", feature = "plugin_data_inline"))]
    #[test]
    fn feature_registry_includes_both_plugins() {
        let registry = build_feature_registry().expect("feature registry should build");
        let names = registry.post_stage_names();
        assert!(names.contains(&"plugin_svg_fallback"));
        assert!(names.contains(&"plugin_data_inline"));
    }
}
