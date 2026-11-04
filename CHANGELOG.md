[English](./CHANGELOG.en.md) | 简体中文

# Changelog

所有值得注意的变更记录于此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 生成

- **`+gen wand/vega-videos/tasks`（WAND 视频）`content` 素材放宽**：`image_url` / `audio_url` 支持本地文件，自动编码为 data URL（实测上游接受：image 出片、audio 解码并校验时长 2000~15000 ms）；`video_url` 实测被上游明确拒绝（400："video_url does not support inline base64; use a public URL"），维持仅公网 URL；裸 Base64（无 `data:` 前缀）提交即 400。
- **Kling v4 参考视频放开本地文件**：`feature_video` 等视频素材支持本地 mp4/mov（≤75MB，自动编码为 data URL）；URL 视频 ≤300MB 由服务端校验（移除原「视频仅 URL」本地拦截）。
- **Mureka 音乐三能力拆分**：`wand/mureka-music` 按接口区分——`generation` 歌词成曲（`--lyrics` 必填、风格提示词 ≤1024）、`easy-generation` 提示词成曲（`--prompt` 必填 ≤2000，`--styles` 13 风格枚举挪到此接口）、`instrumental-generation` 纯音乐（`--prompt` 必填 ≤1024）。`--n` 默认 2 且**按首计费**，只需 1 首务必显式 `--n 1`。
- **Tenlai 异步语音识别**：`tenlai/asrproxy/create_rec_task`（`tenlai-asr-v1.0`），`--input-url` 与 `--data`（本地音频转 Base64）二选一；任务 ID 为数字、查询走 POST body（与 `wand/asrproxy` 的 GET 不同），转写正文与音频时长进结果元数据。
- **MiniMax TTS 流式合成 `--stream`**：SSE 分段响应由 CLI 拼接为完整音频文件（建议输入超过 5000 字符时开启）；流式仅支持 hex 输出，`--output-format url` 与 `--stream` 同用本地拦；末段缺 `audio_format` 时按请求体 `audio_setting.format` 回填保证 MIME 正确。接口参数默认值支持函数形式（如 `stream=true` 时不再注入 `output_format=url`）。
- **MiniMax 声音复刻补 `--file-id` 通道**：`--audio-url` / `--audio-data` / `--file-id` 三选一（文件上传接口获取的 ID）。

### 修复

- **`+gen wand/asrproxy/sync_transcribe` 的 `data` 补大小上限**：≤75MB（原实现无任何限制）；`input_url` 描述补 ≤100MB / ≤30 分钟。
- **`kling-video-v3-turbo` 图生视频允许尾帧**：素材白名单补 `last_frame`（TokenPlan 表格最终版 9-23）。
- **Vidu `subjects[].videos` 仅 q2-pro**：非 q2-pro 模型本地先拦。
- **Vidu 接口覆盖对齐表格**：`q3`/`q2` 补图生与首尾帧接口、`q2-turbo` 补多图参考生视频。
- **`IMAGE_MIME` 补 tiff/tif/heic/heif 映射**：Seedream 本地 tiff/heic/heif 文件原被误拒（白名单声明了格式但 MIME 表缺条目）。
- **world2-panorama 参数改名 `images[]` → `image_url`**（单值、仅 URL；对齐 TokenPlan 表格与 world2-scene 姊妹接口）。
- **WAND_IMAGE（vega 生图）`input` 描述补 0~10 张上限**（原为全库唯一未写张数的参考图参数）。
## [1.0.2] - 2026-10-28

### 新增

- **+gen 排障**：`+gen` 调用失败时与 `+chat` 一样输出错误说明、错误码、修复建议与 Request ID（原来只抛原始 JSON），
  未开后付费（`401007` / `401008`）直接提示 `thcli models activate <本次模型>`；错误说明按当前语言取中 / 英文。
  `thcli doctor model --id <模型>` 新增 `--area` / `--alias`，对 +gen 模型追加按量调用诊断：对应的 +gen 接口；沿请求链路查模型是否下线（预下线提示迁移）、
  与模型同名的默认接入点是否运行（VIRTUAL / INACTIVE 带停止原因给出恢复办法）、能否计费（剩余免费额度或已开后付费，有免费额度时不再误报未开后付费）；
  本地按量 Key（与 +gen 同样按 --area / --alias 定位）按打码前后缀对上云端那把（不取明文），检查启用状态、范围是否含该模型、额度是否用完，
  给出逐接口的 `+gen` 写法与补齐步骤（扩大 Key 范围的命令直接带齐现有绑定目标）；非 +gen 模型保持原有输出。
  `+gen` 报 Key、范围、后付费类错误（401002 / 401006 / 401007 / 401008 / 403002）时附一行可直接执行的上述诊断命令。
  `401006` 的说明补上「Key 的可访问范围不含该模型」（实测网关对范围外模型返回 401006），`401002` 补上「Key 已停用」，
  `401001` 的修复命令改为 `chat-config set`（原 `auth set --type` 不存在）。
- **厂商错误码**：按《厂商错误码说明》收录 PixVerse / Kling / Vidu / MiniMax / MiniMax H3 的错误码（含平台侧按厂商格式返回的值），
  `+gen` 在提交期（HTTP 非 2xx，或 2xx 但响应是厂商错误格式）与生成期（任务失败）都按厂商字段定位错误，
  输出厂商原文、厂商错误码说明、修复建议与 Request ID（此前提交失败只打原始 JSON、生成期失败拿不到原因）；
  `+gen resource`（Kling 主体 / 音色）同样按 Kling 错误码表展示。
  网关错误补读 `upstream_code` / `upstream_status`、限流的 `Retry-After`、Anthropic 协议的 `reqid`。
  `thcli doctor error <码>` 在平台码之外也查厂商码（同值码跨厂商全部列出），`--vendor <厂商>` 列出某厂商全部收录。
- **生成**：`thcli +gen <接口ID> --<字段> <值>`，参数按接口组织、flag 名即官方请求体字段名；共 33 个接口，
  覆盖混元 / Seedream / WAND / Vidu / Kling / PixVerse / MiniMax 的生图、生视频、3D、世界模型与语音、音乐（按量计费）。
  子命令：`apis [接口ID]`（接口列表 / 单接口完整参数）、`status <接口ID> <任务ID>`、`tasks`、`resource`（Kling 主体 / 音色）；
  `thcli +gen <接口ID> --help` 只输出该接口的用法与参数，`thcli +gen help <子命令|接口ID>` 同义。
  任意字段都可用 `--param key=value`（字符串）/ `key:=json`（JSON）或 `--body <json|@文件>` 覆盖，优先级：接口参数 < `--param` < `--body`；
  `--dry-run` 只打印最终请求。异步任务自动轮询，`--output` 下载结果；同步接口发请求前打印"正在生成"提示。
- 配套 skills：生成类 `thcli-image` / `thcli-video` / `thcli-audio` / `thcli-world`（随仓库 `skills/` 发布）。
- 本机提交过的异步生成任务记在 `~/.thcli/gen-tasks.jsonl`（0600，不含 Key 与结果地址）；`+gen tasks` 列出本机任务
  并自动刷新未完成的状态（最多 4 个并发，跳过提交超过 24 小时的），用来找回任务 ID；
  `+gen status <接口ID> <任务ID>` 对本机任务可省 `--model`，并沿用提交时的账号 / 站点 / 地域。

### 变更

- `+chat --anthropic` 不再要求 `--plan`：按量走 `/v1/messages`，与 `--plan` 同用仍走 `/plan/anthropic/v1/messages`。
- 数据面鉴权头统一为 `Authorization: Bearer`（含 Anthropic 协议，另带 `anthropic-version`），不再发 `x-api-key`。
  `+chat`、`+gen`、`equip` 验证共用 `core/data-plane.ts`。
- `+chat` / `+gen` 新增 `--verbose`：把实际请求（URL、请求头、请求体）与原始响应打到 stderr，Key 打码、Base64 截断。
- `+chat --json`（非流式）：输出网关原始响应（思考内容 / 回答 / usage 都在内），便于脚本与 Agent 解析；与 `--stream` 同用会报错（SSE 拼不出完整 JSON）。
- `+chat` 非流式请求超时 120 秒（`AbortSignal.timeout`），超时给出明确提示；流式不设总时限，避免误杀长回答。
- `+chat --input` 可重复（多图 / 多视频），支持视频理解（`video_url`）与公网 URL 透传；
  Responses 通道的图片改为文档规定的 `input_image` 结构。
- `+chat --search` 的联网搜索按协议选写法：Chat 端点（按量 chat 与 `--plan` 套餐通道）用 `web_search_options`，
  Responses 端点用 `tools`。
- 错误码表收录 `AuthFailure.UnauthorizedOperation`。

## [1.0.1] - 2026-10-14

### 新增

- **个人版套餐**：`thcli plan personal`（通用 / Hy Token Plan）——持有状态、可用模型、套餐详情、
  用量趋势（`usage tokens` / `usage credits`，`--range today|7day|30day` 默认 7day，或 `--from/--to`；
  粒度随跨度自动：≤3 天出分钟级总量 / 输入 / 输出，更长按日只出总量）、
  逐次调用明细 `records`（含 RequestID），共享 API Key 的查看 / 重置。
  套餐 / 模型 / 共享 Key / 调用明细都在 tokenhub 产品下，按 `product` 参数区分系列；
  用量趋势走云监控的 `TpEPkg*` 指标。调用明细时间为 RFC3339（`--from/--to` 同格式）。
  购买 / 续费 / 升配 / 建删 Key 涉及开通购买，打印控制台链接。
- **Agent 一键接入**：`thcli equip`。两条路径：`thcli equip install [tool...]` 只把 Agent 程序装到本机
  （`npm install -g`），不登录、不选通道 / Key / 模型、不写任何配置（help 里排在最前）；裸 `thcli equip [tool...]`
  完整接入——缺程序的先装，再写服务地址、API Key、模型列表。另有 `equip list`（支持的工具与检测结果）、
  `equip restore`（按台账还原配置）。
  支持 Claude Code、Codex、CodeBuddy Code、OpenCode、OpenClaw、Kimi Code、Pi、WorkBuddy、Kilo Code 写配置，
  Cursor、Cline、Roo Code、Trae 打印界面入口与填写项（按官方接入文档）；模型列表按云 API → 官方文档 → 内置快照回退；
  写前备份、台账可还原。Agent 用的 Key 从云端列表选择 / 新建 / 粘贴或 `--api-key` 传入，与 thcli 本地 Key 互不相干；
  模型按所选 Key 的绑定范围列出，交互多选（第一个为默认），Claude Code 的 fable / opus / sonnet / haiku 档位按所选顺序填写；
  完整接入时所选 Agent 未安装会询问后用 `npm install -g <包名>` 安装最新版（与官方一致，不改 Agent 自己的自动更新）；是否已安装以 `<命令> --version` 的输出判断；
  WorkBuddy 等桌面应用未安装时不写配置，提示先下载安装再接入。
  Codex 的 Key 写在 `config.toml` 的 `experimental_bearer_token`（0600），不设环境变量、不改 shell rc。
  Codex 另写一份只含所选 TokenHub 模型的模型目录（`model_catalog_json`），`/model` 菜单里只出现这些模型；接入后自动重启 Codex 后台服务（app-server daemon），IDE 插件 / 桌面端新会话即用新配置。
  Kilo Code 写 `~/.config/kilo/kilo.jsonc`；Pi 同时写默认模型（`settings.json`）；界面型 Agent（Cursor、Cline、Roo Code、Trae）只打印入口与填写项，不问写入确认。
  某个 Agent 写到一半失败时，本次写过的文件自动恢复原样；界面型 Agent 只显示打码 Key，确认后才显示完整 Key。
  企业专业版的模型取自所在地域的 `DescribeTokenPlanModelList`（只含在线模型），轻享版为 `auto`。
- 配套 skills（thcli-agent）在 tokenhub-cli-skills 仓库发布。

### 变更

- `auth login` 会打印当前站点与云 API 地域，并给出切换命令（`site use` / `profile set --region`），便于登录时核对是否站错了。
- 管控面客户端抽出公共骨架，两个产品共用同一套凭证刷新与调用日志。

### 修复

- **`+connect` 漏掉 Codex**：Codex 的 skills 目录改为 `~/.codex/skills`（尊重 `CODEX_HOME`），装了 Codex 即可注入；
  重复执行 `+connect` 会为之后新装的 Agent 补注入，已注入的不重复。
- **`plan models` 取不到模型**：改用 `DescribeTokenPlanModelList`（无参），输出专业版固定模型清单
  （模型 ID / 名称 / 状态 / 能力标签）。**不再要求 `--team-id`**——该清单所有专业版套餐一致，与套餐无关；
  轻享版只有 Auto。单把 Key 的可用范围仍可用 `plan key update --allowed-models` 配置。

## [1.0.0]

### 新增

- 首次开源发布。
- **短命令别名**：提供 `thcli` 与 `th` 两个等价命令，`th auth login` = `thcli auth login`。
- **模型**：列表、搜索、横向对比、价格查询。
- **API 密钥**：创建、查看、调整可访问范围与额度。
- **在线推理服务**：列表、详情、后付费开关。
- **对话**：文本与多模态推理，支持流式输出。
- **用量**：按模型 / 服务 / 密钥维度统计，趋势图，导出 CSV。
- **监控**：文本与非文本模型的服务健康度指标。
- **诊断**：`thcli doctor` 检查凭证、服务、模型、套餐，并解释错误码。
- **Agent Skills**：`thcli +connect` 注入 skills，让本地 AI Agent 用自然语言
  驱动 CLI。
- 中英双语界面（`--lang` 或 `thcli lang` 切换）。
