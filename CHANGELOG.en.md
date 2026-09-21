English | [简体中文](./CHANGELOG.md)

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0]

### Added

- Initial open-source release.
- **Short command alias**: two equivalent commands, `thcli` and `th`; `th auth login` = `thcli auth login`.
- **Models**: list, search, side-by-side comparison, and pricing lookup.
- **API keys**: create, view, and adjust accessible scope and quotas.
- **Inference endpoints**: list, details, and postpaid billing toggle.
- **Chat**: text and multimodal inference with streaming output.
- **Usage**: statistics by model / endpoint / key, trend charts, and CSV export.
- **Monitoring**: service health metrics for text and non-text models.
- **Diagnostics**: `thcli doctor` checks credentials, endpoints, models, and plans, and explains error codes.
- **Agent Skills**: `thcli +connect` injects skills so local AI agents can drive the CLI in natural language.
- Bilingual UI (switch with `--lang` or `thcli lang`).
