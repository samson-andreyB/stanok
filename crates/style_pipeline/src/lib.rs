use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use lightningcss::stylesheet::{MinifyOptions, ParserOptions, PrinterOptions, StyleSheet};
use lightningcss::targets::{Browsers, Targets as LightningTargets};
use parcel_sourcemap::SourceMap;
use serde_json::json;

mod legacy_nested;
mod legacy_mixins;
mod legacy_axis;
mod legacy_vars;
mod legacy_imports;
mod legacy_extend;
mod legacy_resolve_dims;
mod legacy_svg_fn;
mod legacy_urls;
mod preprocess_debug;
mod svg_fallback;

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

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreprocessTiming {
    imports_ms: u128,
    vars_ms: u128,
    mixins_ms: u128,
    axis_ms: u128,
    nested_ms: u128,
    extend_ms: u128,
    total_ms: u128,
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
    let mut diagnostics = Vec::<Diagnostic>::new();
    for artifact in &mut artifacts {
        let outcome = compile_and_emit_entry(&req, artifact, targets, stages)?;
        artifact.extra_outputs = outcome.extra_outputs;
        diagnostics.extend(outcome.diagnostics);
    }

    diagnostics.push(Diagnostic {
        code: "PLANNED_OUTPUTS",
        message:
            "style_pipeline compile stub: entry discovery and output contract are implemented"
                .to_string(),
    });

    Ok(CompileResult {
        artifacts,
        diagnostics,
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
) -> Result<EntryCompileOutcome, PipelineError> {
    let input_abs = req.cwd.join(&artifact.entry);
    let css_abs = req.cwd.join(&artifact.css_path);

    let stage_ctx = StageContext {
        cwd: &req.cwd,
        config: &req.config,
    };
    let (source, timing) = preprocess_entry_source(req, &input_abs)?;
    preprocess_debug::maybe_dump_preprocessed_source(&source);
    let source = stages.run_pre(&stage_ctx, &artifact.entry, source)?;

    let mut sheet = StyleSheet::parse(
        &source,
        ParserOptions {
            filename: input_abs.display().to_string(),
            ..ParserOptions::default()
        },
    )
    .map_err(|err| {
        let raw = err.to_string();
        let context = preprocess_debug::extract_parse_error_context(&source, &raw);
        PipelineError::Compile(format!(
            "Failed to parse css '{}': {}{}",
            artifact.entry.display(),
            raw,
            context
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

    let extra_outputs = svg_fallback::emit_svg_fallback_assets(req, &css_code)?;

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

    Ok(EntryCompileOutcome {
        extra_outputs,
        diagnostics: vec![Diagnostic {
            code: "PREPROCESS_PROFILE",
            message: format!(
                "{} imports={}ms vars={}ms mixins={}ms axis={}ms nested={}ms extend={}ms total={}ms",
                artifact.entry.display(),
                timing.imports_ms,
                timing.vars_ms,
                timing.mixins_ms,
                timing.axis_ms,
                timing.nested_ms,
                timing.extend_ms,
                timing.total_ms
            ),
        }],
    })
}

fn preprocess_entry_source(req: &CompileRequest, entry_abs: &Path) -> Result<(String, PreprocessTiming), PipelineError> {
    let t_total = Instant::now();
    let mut stack = HashSet::new();
    let t_imports = Instant::now();
    let mut source = legacy_imports::preprocess_source_recursive(req, entry_abs, &mut stack)?;
    let imports_ms = t_imports.elapsed().as_millis();
    preprocess_debug::maybe_dump_pre_stage("01_after_imports.css", &source);

    let mut vars_ms = 0u128;
    let mut mixins_ms = 0u128;
    let mut axis_ms = 0u128;
    let mut nested_ms = 0u128;
    let mut extend_ms = 0u128;
    if matches!(req.config.compatibility, CompatibilityMode::LegacyCompatible) {
        let t_vars = Instant::now();
        source = apply_legacy_variable_substitution(&source);
        vars_ms = t_vars.elapsed().as_millis();
        preprocess_debug::maybe_dump_pre_stage("02_after_vars.css", &source);

        let t_mixins = Instant::now();
        source = apply_legacy_mixins(&source);
        mixins_ms = t_mixins.elapsed().as_millis();
        preprocess_debug::maybe_dump_pre_stage("03_after_mixins.css", &source);

        let t_axis = Instant::now();
        source = apply_legacy_axis_shorthands(&source);
        axis_ms = t_axis.elapsed().as_millis();
        preprocess_debug::maybe_dump_pre_stage("04_after_axis.css", &source);

        let t_nested = Instant::now();
        source = apply_legacy_nested_selectors(&source);
        nested_ms = t_nested.elapsed().as_millis();
        preprocess_debug::maybe_dump_pre_stage("05_after_nested.css", &source);

        let t_extend = Instant::now();
        source = apply_legacy_extend_selectors(&source);
        extend_ms = t_extend.elapsed().as_millis();
        preprocess_debug::maybe_dump_pre_stage("06_after_extend.css", &source);
    }
    let total_ms = t_total.elapsed().as_millis();
    Ok((
        source,
        PreprocessTiming {
            imports_ms,
            vars_ms,
            mixins_ms,
            axis_ms,
            nested_ms,
            extend_ms,
            total_ms,
        },
    ))
}

pub(crate) fn apply_legacy_import_url_rewrite(req: &CompileRequest, content: &str, file_abs: &Path) -> String {
    legacy_urls::apply_legacy_import_url_rewrite(req, content, file_abs)
}

pub(crate) fn apply_legacy_resolve_width_height(
    req: &CompileRequest,
    content: &str,
    file_abs: &Path,
) -> String {
    legacy_resolve_dims::apply_legacy_resolve_width_height(req, content, file_abs)
}

fn apply_legacy_variable_substitution(content: &str) -> String {
    legacy_vars::apply_legacy_variable_substitution(content)
}

fn apply_legacy_mixins(content: &str) -> String {
    legacy_mixins::apply_legacy_mixins(content)
}

fn apply_legacy_axis_shorthands(content: &str) -> String {
    legacy_axis::apply_legacy_axis_shorthands(content)
}

fn apply_legacy_nested_selectors(content: &str) -> String {
    legacy_nested::apply_legacy_nested_selectors(content)
}

fn apply_legacy_extend_selectors(content: &str) -> String {
    legacy_extend::apply_legacy_extend_selectors(content)
}

fn apply_legacy_svg_function(req: &CompileRequest, content: &str, file_abs: &Path) -> String {
    legacy_svg_fn::apply_legacy_svg_function(req, content, file_abs)
}

pub(crate) fn parse_balanced_block(content: &str, open_brace_index: usize) -> Option<(String, usize)> {
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
    let mut paren = 0i32;
    let mut bracket = 0i32;

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

        match b {
            b'(' => {
                paren += 1;
                i += 1;
                continue;
            }
            b')' => {
                if paren > 0 {
                    paren -= 1;
                }
                i += 1;
                continue;
            }
            b'[' => {
                bracket += 1;
                i += 1;
                continue;
            }
            b']' => {
                if bracket > 0 {
                    bracket -= 1;
                }
                i += 1;
                continue;
            }
            _ => {}
        }

        if (paren > 0 || bracket > 0) && (b == b'{' || b == b'}') {
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

pub(crate) fn write_file(path: &Path, content: &[u8]) -> Result<(), PipelineError> {
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

struct EntryCompileOutcome {
    extra_outputs: Vec<PathBuf>,
    diagnostics: Vec<Diagnostic>,
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
        assert!(result.diagnostics.iter().any(|d| d.code == "PLANNED_OUTPUTS"));
        assert!(result
            .diagnostics
            .iter()
            .any(|d| d.code == "PREPROCESS_PROFILE"));
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
    fn legacy_resolve_width_height_expand_from_real_png() {
        let uniq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("style-pipeline-resolve-test-{uniq}"));
        let src = temp.join("assets/css/src");
        let modules = src.join("modules");
        std::fs::create_dir_all(&modules).expect("must create fixture dirs");

        std::fs::write(
            src.join("_main.css"),
            ".a { background-image: resolve('modules/icon.png'); width: width('modules/icon.png'); height: height('modules/icon.png'); }",
        )
        .expect("must write fixture css");
        // Minimal PNG bytes with IHDR 16x32.
        std::fs::write(
            modules.join("icon.png"),
            b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x10\0\0\0\x20\x08\x06\0\0\0",
        )
        .expect("must write fixture png");

        let mut cfg = PipelineConfig::default();
        cfg.out_dir = PathBuf::from("assets/css");
        cfg.entries.push(Entry {
            input: PathBuf::from("assets/css/src/_main.css"),
        });
        let req = CompileRequest {
            cwd: temp.clone(),
            config: cfg,
        };

        let (out, _) =
            preprocess_entry_source(&req, &temp.join("assets/css/src/_main.css")).expect("preprocess should succeed");
        assert!(out.contains(r#"background-image: url("/assets/css/src/modules/icon.png");"#));
        assert!(out.contains("width: 16px;"));
        assert!(out.contains("height: 32px;"));
    }

    #[test]
    fn legacy_resolve_width_height_normalizes_calc_unary_minus_with_dimension_function() {
        let uniq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("style-pipeline-resolve-calc-test-{uniq}"));
        let src = temp.join("assets/css/src");
        let modules = src.join("modules");
        std::fs::create_dir_all(&modules).expect("must create fixture dirs");

        std::fs::write(
            src.join("_main.css"),
            ".a { margin-top: calc(- height('modules/icon.png') / 2); }",
        )
        .expect("must write fixture css");
        // Minimal PNG bytes with IHDR 16x32.
        std::fs::write(
            modules.join("icon.png"),
            b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x10\0\0\0\x20\x08\x06\0\0\0",
        )
        .expect("must write fixture png");

        let mut cfg = PipelineConfig::default();
        cfg.out_dir = PathBuf::from("assets/css");
        cfg.entries.push(Entry {
            input: PathBuf::from("assets/css/src/_main.css"),
        });
        let req = CompileRequest {
            cwd: temp.clone(),
            config: cfg,
        };

        let (out, _) =
            preprocess_entry_source(&req, &temp.join("assets/css/src/_main.css")).expect("preprocess should succeed");
        assert!(out.contains("margin-top: calc(-32px / 2);"));
    }

    #[test]
    fn legacy_svg_function_inlines_svg_data_uri_and_applies_color_rule() {
        let uniq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("style-pipeline-svg-fn-test-{uniq}"));
        let src = temp.join("assets/css/src");
        let img_dest = temp.join("assets/img/dest");
        std::fs::create_dir_all(&src).expect("must create fixture dirs");
        std::fs::create_dir_all(&img_dest).expect("must create fixture dirs");

        std::fs::write(
            src.join("_main.css"),
            r#".a { background-image: svg("cross_18x18", "[color]: #d0011b"); }"#,
        )
        .expect("must write fixture css");
        std::fs::write(
            img_dest.join("cross_18x18.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><path fill="#000" stroke="#000" d="M1 1L17 17"/></svg>"##,
        )
        .expect("must write fixture svg");

        let mut cfg = PipelineConfig::default();
        cfg.out_dir = PathBuf::from("assets/css");
        cfg.entries.push(Entry {
            input: PathBuf::from("assets/css/src/_main.css"),
        });
        let req = CompileRequest {
            cwd: temp.clone(),
            config: cfg,
        };

        let (out, _) =
            preprocess_entry_source(&req, &temp.join("assets/css/src/_main.css")).expect("preprocess should succeed");
        assert!(out.contains("data:image/svg+xml"));
        assert!(out.contains("%23d0011b"));
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
    fn legacy_variable_substitution_strips_default_flags_from_values() {
        let input = r#"
            $spaceBase: 1.5em !default;
            .m-t-half {
                margin-top: calc($spaceBase * .5);
            }
            .m-t-1 {
                margin-top: $spaceBase;
            }
        "#;
        let out = apply_legacy_variable_substitution(input);
        assert!(!out.contains("!default"));
        assert!(out.contains("margin-top: calc(1.5em * .5);"));
        assert!(out.contains("margin-top: 1.5em;"));
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
    fn legacy_axis_shorthands_expand_x_and_y_properties() {
        let input = r#"
            .Box {
                padding-x: 10px;
                margin-y: 4px;
                border-x: 1px solid #000;
                border-color-y: red;
                border-x-color: transparent;
                border-y-width: 2px;
            }
        "#;
        let out = apply_legacy_axis_shorthands(input);
        assert!(out.contains("padding-left: 10px;"));
        assert!(out.contains("padding-right: 10px;"));
        assert!(out.contains("margin-top: 4px;"));
        assert!(out.contains("margin-bottom: 4px;"));
        assert!(out.contains("border-left: 1px solid #000;"));
        assert!(out.contains("border-right: 1px solid #000;"));
        assert!(out.contains("border-top-color: red;"));
        assert!(out.contains("border-bottom-color: red;"));
        assert!(out.contains("border-left-color: transparent;"));
        assert!(out.contains("border-right-color: transparent;"));
        assert!(out.contains("border-top-width: 2px;"));
        assert!(out.contains("border-bottom-width: 2px;"));
    }

    #[test]
    fn legacy_axis_shorthands_do_not_touch_unrelated_css_properties() {
        let input = r#"
            .Box {
                background-position-x: 10px;
                background-position-y: 20px;
            }
        "#;
        let out = apply_legacy_axis_shorthands(input);
        assert!(out.contains("background-position-x: 10px;"));
        assert!(out.contains("background-position-y: 20px;"));
        assert!(!out.contains("background-position-left"));
        assert!(!out.contains("background-position-top"));
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

    #[test]
    fn legacy_nested_does_not_leave_dangling_selector_in_parent_block() {
        let input = r#"
            .Box {
                & + & { margin-top: .5em; }
                color: red;
            }
        "#;
        let out = apply_legacy_nested_selectors(input);
        assert!(out.contains(".Box + .Box"));
        assert!(!out.contains(".Box {\n& + &"));
    }

    #[test]
    fn legacy_nested_keeps_parent_context_inside_media() {
        let input = r#"
            .TCard {
                @media (max-width: 768px) {
                    &__text:is(.Ctx__btn .Profile .TCard) {
                        display: none;
                    }

                    &__number:is(.Ctx__btn .Profile .TCard) {
                        display: block;
                    }
                }
            }
        "#;
        let out = apply_legacy_nested_selectors(input);
        assert!(out.contains(".TCard__text:is(.Ctx__btn .Profile .TCard)"));
        assert!(out.contains(".TCard__number:is(.Ctx__btn .Profile .TCard)"));
        assert!(!out.contains("\n__text:is("));
        assert!(!out.contains("\n__number:is("));
    }

    #[test]
    fn legacy_nested_media_with_local_decls_and_child_selector_stays_valid() {
        let input = r#"
            .DemoDoc--unified {
                .DemoSheet,
                .DemoDoc__wrapper {
                    padding: 60px;

                    @media screen {
                        width: 210mm;
                        height: 297mm;

                        &.DemoSheet--landscape {
                            .DemoSheet {
                                width: 297mm;
                                height: 210mm;
                            }
                        }
                    }
                }
            }
        "#;
        let out = apply_legacy_nested_selectors(input);
        assert!(!out.contains(", width: 210mm;"));
        let parsed = StyleSheet::parse(&out, ParserOptions::default());
        assert!(
            parsed.is_ok(),
            "nested output must remain parseable for media/local-decls case\n---\n{}\n---",
            out
        );
    }

    #[test]
    fn legacy_nested_box_sample_remains_parseable() {
        let input = r#"
            .Box {
                & + & {
                    margin-top: .5em;
                }

                &--accent {
                    background-color: #f0f4f5;
                    padding: 15px;
                }

                &--hintWarning {
                    background-color: #f8f3da;
                    margin-top: 20px;
                    padding: 10px;
                    padding-left: 30px;
                    background-image: resolve('warning.png');
                    background-repeat: no-repeat;
                    background-position: 10px 13px;
                }

                &--time {
                    background-color: #f6ffda;
                    color: #535c69;
                    padding: 12px 18px;

                    &:before {
                        content: "";
                        display: inline-block;
                        background-image: resolve('clock_grey_b.png');
                        vertical-align: middle;
                        width: width('clock_grey_b.png');
                        height: height('clock_grey_b.png');
                        margin: -.15em 10px 0 0;
                    }
                }

                &--showMore {
                    padding: 12px;
                    text-align: center;
                }

                &--task {
                    background-color: #f8f3da;
                    color: #e00000;
                    display: inline-block;
                    padding: .5em 1em;
                    text-decoration: none;

                    a:link,
                    a:visited,
                    a:hover {
                        color: #e00000;
                    }
                }

                &--info {
                    p {
                        margin: 0;
                    }

                    p + p {
                        margin-top: 5px;
                    }
                }
            }

            .Group {
                &--accent {
                    background-color: #f0f4f5;
                    padding: 15px;
                }

                .Box {
                    display: table-cell;
                    padding-right: 20px;
                    vertical-align: middle;

                    &:last-child {
                        padding-right: 0;
                    }
                }
            }
        "#;

        let out = apply_legacy_nested_selectors(input);
        let parsed = StyleSheet::parse(&out, ParserOptions::default());
        assert!(
            parsed.is_ok(),
            "nested output must remain parseable\n---\n{}\n---",
            out
        );
    }

    #[test]
    fn legacy_nested_keeps_comma_group_under_id_parent_without_selector_leakage() {
        let input = r#"
            .Upload__btn:before {
                content: "";
            }
            #menu-root {
                .menu-item:not(.--default),
                .menu-section {
                    display: none;
                }
            }
        "#;

        let out = apply_legacy_nested_selectors(input);
        assert!(out.contains(
            "#menu-root .menu-item:not(.--default), #menu-root .menu-section"
        ));
        assert!(!out.contains(
            ".Upload__btn #menu-root .menu-item:not(.--default)"
        ));
    }

    #[test]
    fn legacy_nested_ignores_braces_inside_url_data_values() {
        let input = r#"
            .Upload__btn {
                background-image: url(data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><style>.a{fill:red}</style></svg>);
            }

            #menu-root {
                .menu-item:not(.--default),
                .menu-section {
                    display: none;
                }
            }
        "#;

        let out = apply_legacy_nested_selectors(input);
        assert!(out.contains("#menu-root .menu-item:not(.--default), #menu-root .menu-section"));
        assert!(!out.contains(".Upload__btn #menu-root"));
        assert!(!out.contains(".Upload__btn utf8"));
    }

    #[test]
    fn legacy_extend_merges_selectors_into_target_rule() {
        let input = r#"
            .BaseTitle {
                font-size: 16px;
                margin-bottom: 8px;
            }

            .CardHint {
                @extend .BaseTitle;
                color: #888;
            }
        "#;

        let out = apply_legacy_extend_selectors(input);
        assert!(out.contains(".BaseTitle, .CardHint"));
        assert!(!out.contains("@extend .BaseTitle"));
        assert!(out.contains(".CardHint {\ncolor: #888;"));
    }

    #[test]
    fn legacy_extend_drops_rule_when_it_only_contains_extend() {
        let input = r#"
            .base { display: block; }
            .alias { @extend .base; }
        "#;
        let out = apply_legacy_extend_selectors(input);
        assert!(out.contains(".base, .alias"));
        assert!(!out.contains("@extend .base"));
    }

    #[test]
    fn preprocess_ignores_imports_inside_comments() {
        let temp = std::env::temp_dir().join("style_pipeline_unit_commented_imports");
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(temp.join("assets/css/src")).expect("must create fixture dir");
        std::fs::write(
            temp.join("assets/css/src/_main.css"),
            "/* @import 'modules/_commented'; */\n@import 'modules/_active';\n",
        )
        .expect("must write entry css");
        std::fs::create_dir_all(temp.join("assets/css/src/modules")).expect("must create modules dir");
        std::fs::write(
            temp.join("assets/css/src/modules/_active.css"),
            ".ok { color: green; }\n",
        )
        .expect("must write active module");
        std::fs::write(
            temp.join("assets/css/src/modules/_commented.css"),
            ".bad { color: red; }\n",
        )
        .expect("must write commented module");

        let req = CompileRequest {
            cwd: temp.clone(),
            config: PipelineConfig::default(),
        };
        let (out, _timing) = preprocess_entry_source(&req, &temp.join("assets/css/src/_main.css"))
            .expect("preprocess should succeed");
        assert!(out.contains(".ok"));
        assert!(!out.contains(".bad"));
    }

    #[test]
    fn preprocess_resolves_lib_alias_from_import_roots() {
        let temp = std::env::temp_dir().join("style_pipeline_unit_import_lib_alias");
        let _ = std::fs::remove_dir_all(&temp);

        std::fs::create_dir_all(temp.join("assets/css/src")).expect("must create src dir");
        std::fs::create_dir_all(temp.join("vendor/polki/styles/postcss/lib"))
            .expect("must create lib dir");

        std::fs::write(
            temp.join("assets/css/src/_main.css"),
            "@import 'lib/_helpers';\n.Case { color: #111; }\n",
        )
        .expect("must write entry");
        std::fs::write(
            temp.join("vendor/polki/styles/postcss/lib/_helpers.css"),
            ".Helper { display: block; }\n",
        )
        .expect("must write helper");

        let mut cfg = PipelineConfig::default();
        cfg.out_dir = PathBuf::from("assets/css");
        cfg.import_roots = vec![PathBuf::from("vendor/polki/styles/postcss")];
        let req = CompileRequest {
            cwd: temp.clone(),
            config: cfg,
        };

        let (out, _timing) = preprocess_entry_source(&req, &temp.join("assets/css/src/_main.css"))
            .expect("preprocess should resolve lib alias");
        assert!(out.contains(".Helper"));
        assert!(out.contains("display: block;"));
        assert!(out.contains(".Case"));
        assert!(out.contains("color: #111;"));
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
