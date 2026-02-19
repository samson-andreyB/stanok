use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};

use lightningcss::stylesheet::{MinifyOptions, ParserOptions, PrinterOptions, StyleSheet};
use lightningcss::targets::{Browsers, Targets as LightningTargets};
use parcel_sourcemap::SourceMap;
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
            asset: AssetConfig { rewrite_urls: true },
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
pub enum PipelineError {
    InvalidConfig(String),
    Io(String),
    Compile(String),
    Emit(String),
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(message) => write!(f, "{message}"),
            Self::Io(message) => write!(f, "{message}"),
            Self::Compile(message) => write!(f, "{message}"),
            Self::Emit(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for PipelineError {}

pub fn compile(req: CompileRequest) -> Result<CompileResult, PipelineError> {
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

    let artifacts: Vec<CompileArtifact> = entries
        .iter()
        .map(|entry| CompileArtifact {
            entry: entry.input.clone(),
            css_path: output_css_path(&req.config.out_dir, &entry.input),
            map_path: output_map_path(&req.config.out_dir, &entry.input, &req.config.source_maps),
            extra_outputs: Vec::new(),
        })
        .collect();

    let targets = resolve_targets(&req.config)?;
    for artifact in &artifacts {
        compile_and_emit_entry(&req, artifact, targets)?;
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
) -> Result<(), PipelineError> {
    let input_abs = req.cwd.join(&artifact.entry);
    let css_abs = req.cwd.join(&artifact.css_path);

    let source = std::fs::read_to_string(&input_abs).map_err(|err| {
        PipelineError::Io(format!(
            "Failed to read entry css '{}': {err}",
            input_abs.display()
        ))
    })?;

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

    if let Some(map_path) = &artifact.map_path {
        let map_rel = map_rel_path(&req.config.out_dir, map_path);
        css_code.push_str(&format!("\n/*# sourceMappingURL={map_rel} */\n"));
    }

    write_file(&css_abs, css_code.as_bytes())?;

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

    Ok(())
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
}
