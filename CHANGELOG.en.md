English | [简体中文](./CHANGELOG.md)

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Generation

- **`+gen wand/vega-videos/tasks` (WAND video) `content` media relaxed**: `image_url` / `audio_url` now accept local files, auto-encoded as data URLs (verified against upstream: image produced output, audio was decoded and its 2000~15000 ms duration validated); `video_url` was explicitly rejected by upstream in testing (400: "video_url does not support inline base64; use a public URL"), so it stays public-URL-only; bare Base64 (without the `data:` prefix) fails with 400 on submission.
- **Mureka music split into three capabilities**: `wand/mureka-music` is now organized by api — `generation` lyrics-to-song (`--lyrics` required, style prompt <=1024), `easy-generation` prompt-to-song (`--prompt` required, <=2000; the `--styles` enum of 13 styles moved to this api), `instrumental-generation` instrumental (`--prompt` required, <=1024). `--n` defaults to 2 and is **billed per track** — pass `--n 1` explicitly if you only need one.
- **Tenlai async speech recognition**: `tenlai/asrproxy/create_rec_task` (`tenlai-asr-v1.0`), with `--input-url` and `--data` (local audio as Base64) as a required either/or; the task ID is numeric and queries go through a POST body (unlike the GET used by `wand/asrproxy`); transcript text and audio duration land in the result metadata.
- **MiniMax TTS streaming synthesis `--stream`**: SSE chunked responses are stitched by the CLI into one complete audio file (recommended for inputs over 5000 characters); streaming supports hex output only — combining `--output-format url` with `--stream` is blocked locally; when the final chunk lacks `audio_format`, it is backfilled from the request's `audio_setting.format` so the MIME type stays correct. API parameter defaults now support a function form (e.g. `output_format=url` is no longer injected when `stream=true`).
- **MiniMax voice clone gains the `--file-id` channel**: `--audio-url` / `--audio-data` / `--file-id` are a required either/or (the ID comes from the file upload api).

### Fixed

- **`+gen wand/asrproxy/sync_transcribe` `data` size limit added**: <=75MB (previously unlimited); the `input_url` description now states <=100MB / <=30 minutes.
- **`kling-video-v3-turbo` image-to-video allows a last frame**: `last_frame` added to the media whitelist (TokenPlan sheet final version 9-23).
- **Vidu `subjects[].videos` is q2-pro only**: non-q2-pro models are blocked locally.
- **Vidu api coverage aligned with the sheet**: `q3`/`q2` gain image-to-video and first/last-frame apis; `q2-turbo` gains multi-image reference-to-video.
- **`IMAGE_MIME` gains tiff/tif/heic/heif mappings**: local tiff/heic/heif files were wrongly rejected for Seedream (the whitelist declared the formats but the MIME table lacked the entries).
- **world2-panorama parameter renamed `images[]` → `image_url`** (single value, URL-only; aligned with the TokenPlan sheet and the world2-scene sibling api).
- **WAND_IMAGE (vega image) `input` description states the 0~10 image limit** (it was the only reference-image parameter in the whole registry without a count).

## [1.0.2] - 2026-10-28

### Added

- **+gen troubleshooting**: when a `+gen` call fails, it now outputs the error description, error code, fix suggestion, and Request ID like `+chat` does (previously it just threw the raw JSON);
  without postpaid billing enabled (`401007` / `401008`) it directly suggests `thcli models activate <model>`; error descriptions follow the current language (Chinese / English).
  `thcli doctor model --id <model>` gains `--area` / `--alias`, and for +gen models appends pay-as-you-go diagnostics: the corresponding +gen api; checks along the request chain whether the model is offline (pre-offline models get a migration hint),
  whether the default endpoint named after the model is running (VIRTUAL / INACTIVE include the stop reason and how to recover), and whether it can be billed (remaining free quota or postpaid enabled — no more false "postpaid not enabled" reports when free quota exists);
  the local pay-as-you-go key (located the same way as +gen, via --area / --alias) is matched against the cloud one by its masked prefix/suffix (the plaintext is never read), checking whether it is enabled, whether its scope covers the model, and whether its quota is exhausted,
  then prints per-api `+gen` invocations and the steps to fix things (the command to widen a key's scope comes pre-filled with its current binding targets); non-+gen models keep the original output.
  When `+gen` reports key / scope / postpaid errors (401002 / 401006 / 401007 / 401008 / 403002), it appends the ready-to-run diagnostic command above.
  `401006` now explains "the key's accessible scope does not cover this model" (verified: the gateway returns 401006 for out-of-scope models), `401002` gains "key disabled",
  and `401001`'s fix command changed to `chat-config set` (the old `auth set --type` does not exist).
- **Vendor error codes**: error codes for PixVerse / Kling / Vidu / MiniMax / MiniMax H3 are collected per the "vendor error code reference" (including values the platform returns in vendor format),
  and `+gen` locates errors by vendor fields both at submission time (HTTP non-2xx, or 2xx with a vendor error body) and during generation (task failure),
  printing the vendor's original message, the error code explanation, a fix suggestion, and the Request ID (previously submission failures only dumped the raw JSON, and generation failures had no reason available);
  `+gen resource` (Kling elements / voices) is displayed the same way using the Kling error table.
  Gateway error parsing now also reads `upstream_code` / `upstream_status`, rate-limit `Retry-After`, and the Anthropic protocol's `reqid`.
  `thcli doctor error <code>` looks up vendor codes in addition to platform codes (same-value codes are listed across all vendors), and `--vendor <vendor>` lists everything collected for one vendor.
- **Generation**: `thcli +gen <apiId> --<field> <value>` — parameters are organized per api, and flag names are the official request-body field names; 33 apis in total,
  covering image, video, 3D, world-model, speech, and music generation from Hunyuan / Seedream / WAND / Vidu / Kling / PixVerse / MiniMax (pay-as-you-go).
  Subcommands: `apis [apiId]` (api list / full parameters of one api), `status <apiId> <taskId>`, `tasks`, `resource` (Kling elements / voices);
  `thcli +gen <apiId> --help` prints only that api's usage and parameters; `thcli +gen help <subcommand|apiId>` is equivalent.
  Any field can be overridden with `--param key=value` (string) / `key:=json` (JSON) or `--body <json|@file>`, with priority: api parameters < `--param` < `--body`;
  `--dry-run` prints only the final request. Async tasks are polled automatically and `--output` downloads results; sync apis print a "generating" hint before sending the request.
- Companion skills: generation skills `thcli-image` / `thcli-video` / `thcli-audio` / `thcli-world` (published with the repo's `skills/`).
- Async generation tasks submitted on this machine are recorded in `~/.thcli/gen-tasks.jsonl` (0600, no keys or result URLs); `+gen tasks` lists local tasks
  and auto-refreshes unfinished ones (up to 4 concurrent, skipping tasks submitted more than 24 hours ago) so you can recover task IDs;
  for local tasks, `+gen status <apiId> <taskId>` can omit `--model` and reuses the account / site / region from submission time.

### Changed

- `+chat --anthropic` no longer requires `--plan`: pay-as-you-go goes to `/v1/messages`; combined with `--plan` it still goes to `/plan/anthropic/v1/messages`.
- The data-plane auth header is unified to `Authorization: Bearer` (including the Anthropic protocol, which also sends `anthropic-version`); `x-api-key` is no longer sent.
  `+chat`, `+gen`, and `equip` verification share `core/data-plane.ts`.
- `+chat` / `+gen` gain `--verbose`: prints the actual request (URL, headers, body) and raw response to stderr, with keys masked and Base64 truncated.
- `+chat --json` (non-streaming): outputs the gateway's raw response (thinking / answer / usage all included) for scripts and agents to parse; combining it with `--stream` is an error (SSE cannot be stitched into complete JSON).
- `+chat` non-streaming requests time out after 120 seconds (`AbortSignal.timeout`) with a clear message on timeout; streaming has no overall deadline, so long answers are not killed prematurely.
- `+chat --input` is repeatable (multiple images / videos), supports video understanding (`video_url`) and public-URL passthrough;
  images on the Responses channel use the `input_image` structure required by the docs.
- `+chat --search` web search picks its encoding per protocol: Chat endpoints (pay-as-you-go chat and the `--plan` channel) use `web_search_options`,
  while the Responses endpoint uses `tools`.
- The error code table now includes `AuthFailure.UnauthorizedOperation`.

## [1.0.1] - 2026-10-14

### Added

- **Personal plans**: `thcli plan personal` (Universal / Hy Token Plan) — holding status, available models, plan details,
  usage trends (`usage tokens` / `usage credits`, `--range today|7day|30day` default 7day, or `--from/--to`;
  granularity follows the span automatically: <=3 days gives minute-level totals / input / output, longer spans give daily totals only),
  per-call records `records` (with RequestID), and shared API key view / reset.
  Plans / models / shared keys / call records all live under the tokenhub product, separated by the `product` parameter;
  usage trends use the `TpEPkg*` metrics from Cloud Monitor. Record timestamps are RFC3339 (`--from/--to` use the same format).
  Purchasing / renewing / upgrading / creating or deleting keys involves billing activation, so console links are printed.
- **One-command agent onboarding**: `thcli equip`. Two paths: `thcli equip install [tool...]` only installs the agent program locally
  (`npm install -g`) — no login, no channel / key / model selection, no config written (listed first in help); bare `thcli equip [tool...]`
  does the full setup — installs missing programs first, then writes the service URL, API key, and model list. Also `equip list` (supported tools and detection results) and
  `equip restore` (restores configs from the ledger).
  Writing configs is supported for Claude Code, Codex, CodeBuddy Code, OpenCode, OpenClaw, Kimi Code, Pi, WorkBuddy, and Kilo Code;
  Cursor, Cline, Roo Code, and Trae get their UI entry points and fields printed instead (per the official onboarding docs); the model list falls back from cloud API → official docs → built-in snapshot;
  configs are backed up before writing and restorable from the ledger. The agent's key comes from the cloud key list / creation / pasting or `--api-key`, entirely separate from thcli's local key;
  models are listed per the chosen key's binding scope with an interactive multi-select (the first is the default), and Claude Code's fable / opus / sonnet / haiku tiers are filled in the chosen order;
  during full setup, a missing agent is installed after confirmation via `npm install -g <package>` at the latest version (same as upstream, without touching the agent's own auto-update); installation is detected by `<command> --version` output;
  desktop apps like WorkBuddy get no config written when absent — the user is told to download and install first.
  Codex's key is written to `experimental_bearer_token` in `config.toml` (0600), with no environment variables and no shell rc changes.
  Codex also gets a model catalog containing only the chosen TokenHub models (`model_catalog_json`), so only those appear in the `/model` menu; after setup the Codex backend service (app-server daemon) restarts automatically so IDE plugins / desktop sessions pick up the new config.
  Kilo Code writes `~/.config/kilo/kilo.jsonc`; Pi also writes the default model (`settings.json`); UI-driven agents (Cursor, Cline, Roo Code, Trae) only print entry points and fields, without asking for write confirmation.
  If an agent's setup fails midway, every file written in that run is automatically restored; UI-driven agents only show a masked key until confirmed.
  Enterprise Pro model lists come from the region's `DescribeTokenPlanModelList` (online models only); Lite plans are `auto`.
- Companion skills (thcli-agent) published in the tokenhub-cli-skills repo.

### Changed

- `auth login` prints the current site and cloud API region along with the switching commands (`site use` / `profile set --region`) so you can verify you are on the right one.
- The control-plane client extracted a shared skeleton; both products now share the same credential refresh and call logging.

### Fixed

- **`+connect` missed Codex**: Codex's skills directory is now `~/.codex/skills` (respecting `CODEX_HOME`); injecting works once Codex is installed;
  re-running `+connect` backfills agents installed later without duplicating existing ones.
- **`plan models` returned no models**: switched to `DescribeTokenPlanModelList` (no arguments), outputting the fixed Pro model list
  (model ID / name / status / capability tags). **`--team-id` is no longer required** — the list is identical across all Pro plans and plan-independent;
  Lite plans only have Auto. A single key's accessible scope can still be configured with `plan key update --allowed-models`.

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
