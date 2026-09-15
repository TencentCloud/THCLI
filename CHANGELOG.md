# Changelog

所有值得注意的变更记录于此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.0]

### 新增

- 首次开源发布。
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
