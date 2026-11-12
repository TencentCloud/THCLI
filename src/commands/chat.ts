/**
 * +chat 数据面对话 + chat-config 本地 key 管理。
 *
 * 命令名带 + 前缀，用来跟管控面命令视觉区分——只有 +chat 会真正打到数据面推理
 * 接口，其它命令全是管控面云 API 或纯本地操作。
 *
 * 路由由三个独立维度决定，互不覆盖：
 *   url_channel   打哪个 URL —— 只看 --plan；没给 --plan 时看 --responses/--search
 *   payload       body 结构  —— 看 --responses/--search（messages vs input）
 *   是否挂搜索工具 —— 只看 --search
 * 核心原则：给了 --plan 就一定走 /plan/v3/chat/completions，不会因为同时给了
 * --responses/--search 就改道。CLI 不替用户和后端决定"这个组合该走哪"，也不做
 * 客户端主观拦截，网关的真实响应（含报错）如实透传。
 */
import { Command } from "commander";

import { allowedRegions, chatHostOf, DEFAULT_REGION, defaultPlanRegion, planOriginOf } from "../core/config.js";
import {
  type GlobalArgs,
  mask,
  resolveEnv,
  resolveProfile,
  resolveSite,
} from "../core/credentials.js";
import {
  DEFAULT_ALIAS,
  KEY_TYPES,
  listRegionKeyAliases,
  listSiteKeyScopes,
  loadDataConfig,
  resolveRegionKey,
  saveDataConfig,
  setRegionKey,
  type KeyType,
} from "../core/keystore.js";
import { buildChatContent, type PayloadShape } from "../core/chat-content.js";
import { authHeadersOf } from "../core/data-plane.js";
import { collect } from "../core/format.js";
import { emitJson, isJson, traceRequest, traceResponse } from "../core/output.js";
import { logDataPlaneCall } from "../core/telemetry.js";
import { extractRequestId, gatewayErrorLines, parseGatewayBody } from "../core/errors.js";
import { t } from "../core/i18n.js";

/**
 * 各通道的 URL 路径。按量三种协议同一组 Base URL、只换路径（文档 1823/130079
 * 「协议与调用方式」）：/v1/chat/completions、/v1/responses、/v1/messages。
 */
const CHANNEL_PATHS = {
  chat: "/v1/chat/completions",
  plan: "/plan/v3/chat/completions",
  planAnthropic: "/plan/anthropic/v1/messages",
  responses: "/v1/responses",
  anthropic: "/v1/messages",
} as const;

type Channel = keyof typeof CHANNEL_PATHS;

/**
 * Anthropic Messages API 的 max_tokens 是必填字段（OpenAI 侧可选）。用户没给就
 * 用这个默认值，否则请求会被直接拒。
 */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/**
 * 非流式请求的超时（毫秒）。只对非流式设：流式下"回答很长"本就是正常情况，
 * 用同一个总时限会把长回答误杀。非流式是一问一答，卡这么久基本可判为服务端没返回。
 * 用 AbortSignal.timeout 而不是给整个 fetch 设一个笼统时限——它同时覆盖连接与响应两段。
 *
 * 深度思考（--thinking）放宽到 300 秒：思考链是隐藏输出，非流式要等「思考 + 回答」
 * 全部生成完才返回，长思考题实测超 120 秒（2026-11-11 Web 端 Hy4 超时报障）。
 */
const REQUEST_TIMEOUT_MS = 120_000;
const THINKING_REQUEST_TIMEOUT_MS = 300_000;


/** +chat 的参数 */
interface ChatOptions {
  model?: string;
  /** 用户输入的文本。来自位置参数，由 action 收拢后填入（无 --message 选项） */
  message?: string;
  /** --input 可重复：多图 / 多视频 / 文本文件，按给出顺序进入 content */
  input?: string[];
  stream?: boolean;
  search?: boolean;
  responses?: boolean;
  thinking?: boolean;
  plan?: string;
  anthropic?: boolean;
  maxTokens?: string;
  apiKey?: string;
  alias?: string;
  area?: string;
  verbose?: boolean;
}

/** 解析出的请求目标 */
interface ResolvedRequest {
  url: string;
  urlChannel: Channel;
  payloadChannel: PayloadShape;
  /**
   * 联网搜索的写法，随**协议**而定：
   *   Chat 端点      → web_search_options:{enable:true}
   *   Responses 端点 → tools:[{type:"web_search"}]
   *   none           未开搜索
   */
  searchForm: "chat_options" | "responses" | "none";
  apiKey: string;
}

export function resolveRequest(opts: ChatOptions, globals: GlobalArgs): ResolvedRequest {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  // --area 有默认值 gz，要区分"用户写了"和"没写"：个人版在国际站只有 sg，没写时改用它
  const areaGiven = process.argv.includes("--area");
  const region = !areaGiven && opts.plan ? defaultPlanRegion(opts.plan, site) : opts.area ?? DEFAULT_REGION;

  // URL：--plan 锁定套餐通道；否则 --anthropic / --responses 各选一条，都不给就是 Chat。
  let urlChannel: Channel;
  let keyType: KeyType;
  if (opts.plan) {
    if (opts.plan !== "tp-ep" && opts.plan !== "tp") {
      throw new Error(t("chat.badPlan"));
    }
    urlChannel = opts.anthropic ? "planAnthropic" : "plan";
    keyType = opts.plan;
  } else {
    urlChannel = opts.anthropic ? "anthropic" : opts.responses ? "responses" : "chat";
    keyType = "th";
  }

  // body 形状：--responses 决定 chat / responses；Anthropic 端点自身是第三种形状，跟着 URL 走。
  const payloadChannel: PayloadShape =
    urlChannel === "planAnthropic" || urlChannel === "anthropic"
      ? "anthropic"
      : opts.responses
        ? "responses"
        : "chat";

  // 联网搜索：Chat 端点用 web_search_options，Responses 端点用 tools。
  const searchForm: ResolvedRequest["searchForm"] = !opts.search
    ? "none"
    : payloadChannel === "responses"
      ? "responses"
      : payloadChannel === "chat"
        ? "chat_options"
        : "none";

  const keyConfig = loadDataConfig(profile);
  const apiKey =
    opts.apiKey ??
    resolveRegionKey(keyConfig, site, region, keyType, opts.alias);
  if (!apiKey) {
    // 与 +gen 同款：默认地域查不到 Key 时列出该站点已配置的地域，避免误以为 Key 没配/配错
    const scopes = listSiteKeyScopes(keyConfig, site, keyType);
    const areaHint = scopes.length ? `\n${t("chat.noKeyAreaHint", { scopes: scopes.join("、") })}` : "";
    throw new Error(
      `${t("chat.noKey", {
        site,
        area: region,
        type: keyType,
        alias: opts.alias ?? DEFAULT_ALIAS,
      })}\n${t("chat.noKeyFix", { type: keyType, area: region })}${areaHint}`,
    );
  }

  // planOriginOf 返回含 scheme 的 origin（按站点/地域解析数据面 host），
  // 与按量同一套域名；个别测试集群是 http，故保留 scheme。
  const env = resolveEnv();
  const origin =
    urlChannel === "plan" || urlChannel === "planAnthropic"
      ? planOriginOf(opts.plan!, site, region, env)
      : `https://${chatHostOf(site, region, env)}`;
  return {
    url: `${origin.replace(/\/$/, "")}${CHANNEL_PATHS[urlChannel]}`,
    urlChannel,
    payloadChannel,
    searchForm,
    apiKey,
  };
}

/**
 * 内容构造在 core/chat-content.ts（多输入、URL 透传、视频、三种协议的块结构）。
 * 这里只负责把告警打到 stderr——stdout 留给回答本身，便于管道处理。
 */
function contentOf(opts: ChatOptions, shape: PayloadShape): unknown {
  const built = buildChatContent(shape, opts.message, opts.input ?? []);
  for (const w of built.warnings) {
    console.error(w);
  }
  return built.content;
}

/**
 * Anthropic Messages API 的 body。与 OpenAI 侧有四处结构差异，逐条对应：
 *   max_tokens   必填（OpenAI 可选）——缺了直接被拒，故有默认值
 *   图片块       {type:"image",source:{type:"base64",media_type,data}}
 *                而不是 OpenAI 的 {type:"image_url",image_url:{url}}
 *   thinking     需要 budget_tokens，且必须小于 max_tokens
 */
function buildAnthropicPayload(opts: ChatOptions): Record<string, unknown> {
  const maxTokens = Number(opts.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error(t("chat.badMaxTokens"));
  }

  const payload: Record<string, unknown> = {
    model: opts.model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: contentOf(opts, "anthropic") }],
  };
  if (opts.stream) {
    payload["stream"] = true;
  }
  if (opts.thinking === true) {
    // budget 必须小于 max_tokens；取一半并保底 1024（Anthropic 的下限）
    payload["thinking"] = {
      type: "enabled",
      budget_tokens: Math.max(1024, Math.floor(maxTokens / 2)),
    };
  }
  return payload;
}

function buildPayload(opts: ChatOptions, req: ResolvedRequest): Record<string, unknown> {
  if (req.payloadChannel === "anthropic") {
    return buildAnthropicPayload(opts);
  }
  const content = contentOf(opts, req.payloadChannel);
  const payload: Record<string, unknown> = { model: opts.model };

  if (req.payloadChannel === "responses") {
    payload["input"] = [{ role: "user", content }];
  } else {
    payload["messages"] = [{ role: "user", content }];
  }
  payload["stream"] = Boolean(opts.stream);

  // 联网搜索：按通道选写法（见 resolveRequest.searchForm 的说明）。
  // Chat API（含 plan 通道）用 web_search_options；Responses API 用 tools 声明搜索工具。
  if (req.searchForm === "chat_options") {
    payload["web_search_options"] = { enable: true };
  } else if (req.searchForm === "responses") {
    payload["tools"] = [{ type: "web_search" }];
    payload["tool_choice"] = "auto";
  }
  // 深度思考开关。字段名经真实调用验证（见下），不是按惯例猜的：
  //   thinking: {type:"enabled"}   ✅ 生效，且 disabled 能反向关掉
  //   reasoning_effort: "high"     ✅ 也生效（low/medium/high/none 四档）
  //   enable_thinking: true        ❌ 无效——曾用这个，网关静默忽略
  // 网关对未知字段一律放行（实测传 definitely_not_a_field_xyz 也返回 200），
  // 所以字段名错了不会报错、只会静默不生效，必须靠"思考内容有没有出现"来判定。
  // 三态：不传 → 不带该字段（用模型默认）｜--thinking → enabled｜--no-thinking → disabled。
  // commander 把 --no-thinking 解析成 thinking:false（不是 noThinking:true），
  // 且不传时该键不存在，所以 undefined 检查能区分出这三种情况
  if (opts.thinking === true) {
    payload["thinking"] = { type: "enabled" };
  } else if (opts.thinking === false) {
    payload["thinking"] = { type: "disabled" };
  }
  return payload;
}

/** 流式：逐块输出。
 *  人类模式直接打印正文增量（思考增量跳过，避免终端噪音）；
 *  --json 机器模式每行一个 JSON 事件：reasoning_delta / content_delta / done（带 model、request_id、usage），
 *  供 Web 控制台等消费方实时渲染思考过程与正文 */
async function printStream(
  body: ReadableStream<Uint8Array>,
  payloadChannel: PayloadShape,
  meta: { machine: boolean; model?: string; requestId?: string },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Record<string, unknown> | undefined;

  const emit = (type: "reasoning_delta" | "content_delta", text: string): void => {
    if (meta.machine) process.stdout.write(`${JSON.stringify({ type, text })}\n`);
    else if (type === "content_delta") process.stdout.write(text);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // 最后一段可能不完整，留到下一轮
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const data = line.startsWith("data:") ? line.slice(5).trim() : line;
      if (data === "[DONE]") continue;
      try {
        const evt = JSON.parse(data) as Record<string, unknown>;
        // usage 尽力收：chat 通道尾块 / Anthropic message_delta / responses 的 response.completed
        const u = (evt["usage"] ?? (evt["response"] as Record<string, unknown> | undefined)?.["usage"]) as Record<string, unknown> | undefined;
        if (u && typeof u === "object") usage = u;
        if (payloadChannel === "anthropic") {
          // Anthropic 流是带类型的事件流：thinking_delta（思考增量）与 text_delta（正文）都在 content_block_delta 里；
          // 其余（message_start / ping / message_stop 等）没有可打印内容
          const delta = evt["delta"] as Record<string, unknown> | undefined;
          if (evt["type"] === "content_block_delta") {
            if (typeof delta?.["thinking"] === "string") emit("reasoning_delta", delta["thinking"]);
            else if (typeof delta?.["text"] === "string") emit("content_delta", delta["text"]);
          }
        } else if (payloadChannel === "responses") {
          // responses 通道的 delta 是裸字符串；事件 type 含 reasoning 的是推理摘要增量
          if (typeof evt["delta"] === "string") {
            emit(String(evt["type"] ?? "").includes("reasoning") ? "reasoning_delta" : "content_delta", evt["delta"]);
          }
        } else {
          const choices = evt["choices"] as Array<Record<string, unknown>> | undefined;
          const delta = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
          if (typeof delta?.["reasoning_content"] === "string") emit("reasoning_delta", delta["reasoning_content"]);
          else if (typeof delta?.["content"] === "string") emit("content_delta", delta["content"]);
        }
      } catch {
        // 非 JSON 的心跳/注释行直接跳过
      }
    }
  }
  if (meta.machine) {
    process.stdout.write(`${JSON.stringify({ type: "done", model: meta.model, requestId: meta.requestId, usage })}\n`);
  } else {
    process.stdout.write("\n");
  }
}

/** 非流式：打印思考过程（如有）与回答 */
function printOnce(body: Record<string, unknown>): void {
  // Anthropic 通道：content[] 数组，thinking 块与 text 块并列
  const content = body["content"];
  if (Array.isArray(content) && body["type"] === "message") {
    const blocks = content as Array<Record<string, unknown>>;
    const thinking = blocks
      .filter((b) => b["type"] === "thinking" && typeof b["thinking"] === "string")
      .map((b) => b["thinking"] as string)
      .join("");
    if (thinking) {
      console.log(t("chat.thinkingHeader"));
      console.log(thinking);
      console.log("");
      console.log(t("chat.answerHeader"));
    }
    console.log(
      blocks
        .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
        .map((b) => b["text"] as string)
        .join(""),
    );
    return;
  }

  // chat/plan 通道：choices[0].message
  const choices = body["choices"] as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.["message"] as Record<string, unknown> | undefined;
  if (message) {
    const reasoning = message["reasoning_content"];
    if (typeof reasoning === "string" && reasoning) {
      console.log(t("chat.thinkingHeader"));
      console.log(reasoning);
      console.log("");
      console.log(t("chat.answerHeader"));
    }
    console.log(String(message["content"] ?? ""));
    return;
  }

  // responses 通道：output[] 数组，含 web_search_call（搜索动作）+ message（最终答案）
  const output = body["output"];
  if (Array.isArray(output)) {
    printResponsesOutput(output as Array<Record<string, unknown>>);
    return;
  }

  // 少数实现直接给 output_text
  if (typeof body["output_text"] === "string") {
    console.log(body["output_text"]);
    return;
  }

  // 兜底：结构未知时原样打印，不吞内容
  console.log(JSON.stringify(body, null, 2));
}

/** 解析 responses 通道的 output 数组：搜索动作提示 + 正文 + 引用来源 */
function printResponsesOutput(output: Array<Record<string, unknown>>): void {
  // 先提示做过联网搜索，让用户知道答案带了实时信息
  const searchCalls = output.filter((o) => o["type"] === "web_search_call");
  for (const call of searchCalls) {
    const action = call["action"] as Record<string, unknown> | undefined;
    const query = action?.["query"];
    console.log(t("chat.searched", { query: query ? t("chat.searchedQuery", { query }) : "" }));
  }
  if (searchCalls.length) {
    console.log("");
  }

  // 正文在 type=message 的 content[].output_text 里
  const citations: string[] = [];
  for (const item of output) {
    if (item["type"] !== "message") {
      continue;
    }
    const contents = item["content"] as Array<Record<string, unknown>> | undefined;
    for (const part of contents ?? []) {
      if (part["type"] === "output_text" || part["type"] === "text") {
        console.log(String(part["text"] ?? ""));
        // 收集引用来源，末尾统一列出
        const annotations = part["annotations"] as Array<Record<string, unknown>> | undefined;
        for (const ann of annotations ?? []) {
          if (ann["type"] === "url_citation" && ann["url"]) {
            const idx = ann["index"] ?? citations.length + 1;
            citations.push(`  [${idx}] ${ann["url"]}`);
          }
        }
      }
    }
  }

  if (citations.length) {
    console.log("");
    console.log(t("chat.sourcesHeader"));
    // 同一 url 可能被引用多次，去重后按出现顺序列出
    for (const c of [...new Set(citations)]) {
      console.log(c);
    }
  }
}

/** 参数校验：模型、内容、地域（地域早拦，免得拼出不存在的 host） */
function validateChatOptions(opts: ChatOptions, site: string): void {
  if (!opts.model) {
    throw new Error(t("chat.needModel"));
  }
  if (!opts.message && !opts.input?.length) {
    throw new Error(t("chat.needContent"));
  }
  // --stream --json 组合 = NDJSON 事件流（reasoning_delta / content_delta / done），
  // 供脚本与 Web 控制台实时消费（含思考过程）；不再互斥报错
  const regions = allowedRegions(site);
  if (opts.area && !regions.includes(opts.area)) {
    throw new Error(t("chat.badArea", { site, area: opts.area, options: regions.join(", ") }));
  }
}

/** 请求头：统一 Bearer，Anthropic 协议另带 anthropic-version，见 core/data-plane.ts */
function headersOf(req: ResolvedRequest): Record<string, string> {
  return authHeadersOf(req.payloadChannel === "anthropic" ? "anthropic" : "openai", req.apiKey);
}

/** 非 2xx：打印网关原始错误、业务码建议与 request_id，返回 request_id 供记日志 */
async function reportHttpError(resp: Response, url: string, text: string): Promise<string | undefined> {
  const parsed = parseGatewayBody(text);
  const requestId = extractRequestId(resp.headers, typeof parsed === "string" ? undefined : parsed);
  console.log(t("chat.httpFailed", { status: resp.status, statusText: resp.statusText, url }));
  // 业务码已收录时补一条 thcli 侧的修复建议；未收录就不打，避免给出泛泛而谈的噪音
  for (const line of gatewayErrorLines(parsed, requestId)) console.log(line);
  return requestId;
}

async function chatCommand(opts: ChatOptions, globals: GlobalArgs): Promise<void> {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  validateChatOptions(opts, site);

  const req = resolveRequest(opts, globals);
  const payload = buildPayload(opts, req);
  const start = Date.now();
  const log = (status: "ok" | "error", requestId?: string, error?: string, extra?: Record<string, unknown>): void =>
    logDataPlaneCall(profile, site, { channel: req.urlChannel, requestId, durationMs: Date.now() - start, status, error, extra });

  const headers = headersOf(req);
  if (opts.verbose) traceRequest("POST", req.url, headers, payload);
  let resp: Response;
  try {
    // 非流式才设超时：流式回答可能持续很久，设总时限会误杀正常的长回答；
    // 深度思考用放宽档（思考链 + 回答全部生成完才返回，见 THINKING_REQUEST_TIMEOUT_MS 注释）
    const timeoutMs = opts.thinking === true ? THINKING_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const signal = opts.stream ? undefined : AbortSignal.timeout(timeoutMs);
    resp = await fetch(req.url, { method: "POST", headers, body: JSON.stringify(payload), signal });
  } catch (err) {
    // 网络层错误或超时：请求根本没到网关（或没拿到响应），不存在 request_id
    const aborted = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
    const timeoutMs = opts.thinking === true ? THINKING_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const message = aborted ? t("chat.requestTimeout", { seconds: timeoutMs / 1000 }) : t("chat.requestFailed", { message: (err as Error).message });
    log("error", undefined, aborted ? `timeout ${timeoutMs}ms` : (err as Error).message);
    // NDJSON 流模式（--stream --json）：错误也走事件行，消费方（Web 控制台）才能透传真实原因
    if (opts.stream && isJson()) {
      process.stdout.write(`${JSON.stringify({ type: "error", error: message })}\n`);
      return;
    }
    console.log(message);
    console.log(t("chat.noRequestId"));
    return;
  }

  if (!resp.ok) {
    const text = await resp.text();
    if (opts.verbose) traceResponse(resp.status, Date.now() - start, text);
    if (opts.stream && isJson()) {
      // NDJSON 流模式：HTTP 错误走事件行（多行块解析不了）
      process.stdout.write(`${JSON.stringify({ type: "error", status: resp.status, error: text.slice(0, 2000) })}\n`);
      log("error", extractRequestId(resp.headers), `HTTP ${resp.status}`);
      return;
    }
    log("error", await reportHttpError(resp, req.url, text), `HTTP ${resp.status}`);
    return;
  }

  if (opts.stream && resp.body) {
    // 流式正文是 SSE，--verbose 只打状态行，正文照常逐块输出
    if (opts.verbose) traceResponse(resp.status, Date.now() - start);
    // 流式下只能从响应头取 request_id（body 是 SSE 流，不能当 JSON 解析）
    const requestId = extractRequestId(resp.headers);
    await printStream(resp.body, req.payloadChannel, { machine: Boolean(isJson()), model: opts.model, requestId });
    log("ok", requestId, undefined, { model: opts.model, stream: true });
    return;
  }

  const text = await resp.text();
  if (opts.verbose) traceResponse(resp.status, Date.now() - start, text);
  const body = JSON.parse(text) as Record<string, unknown>;
  log("ok", extractRequestId(resp.headers, body), undefined, { model: opts.model });
  // --json：吐网关原始响应（思考内容、回答、usage 都在里面），供脚本与 Agent 解析
  if (emitJson(body)) return;
  printOnce(body);
}

// ---------------------------------------------------------------- chat-config

function configSet(opts: Record<string, string>, globals: GlobalArgs): void {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  const region = opts["area"] ?? DEFAULT_REGION;
  const type = (opts["type"] ?? "th") as KeyType;
  const alias = opts["alias"] ?? DEFAULT_ALIAS;

  if (!KEY_TYPES.includes(type)) {
    throw new Error(t("chatConfig.badType", { options: KEY_TYPES.join(" / ") }));
  }
  if (!allowedRegions(site).includes(region)) {
    throw new Error(
      t("chatConfig.badArea", { site, area: region, options: allowedRegions(site).join(", ") }),
    );
  }
  if (!opts["value"]) {
    throw new Error(t("chatConfig.needValue"));
  }

  const cfg = loadDataConfig(profile);
  setRegionKey(cfg, site, region, type, opts["value"], alias);
  saveDataConfig(profile, cfg);
  console.log(
    t("chatConfig.setDone", {
      profile,
      site,
      area: region,
      type,
      alias,
      masked: mask(opts["value"]),
    }),
  );
}

function configGet(opts: Record<string, string>, globals: GlobalArgs): void {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  const region = opts["area"] ?? DEFAULT_REGION;
  const type = (opts["type"] ?? "th") as KeyType;
  const cfg = loadDataConfig(profile);
  const prefix = `[profile=${profile} site=${site} area=${region}]`;

  if (opts["alias"]) {
    const value = resolveRegionKey(cfg, site, region, type, opts["alias"]);
    console.log(
      t("chatConfig.aliasLine", {
        prefix,
        type,
        alias: opts["alias"],
        value: value ? mask(value) : t("chatConfig.notSet"),
      }),
    );
    return;
  }

  const aliases = listRegionKeyAliases(cfg, site, region, type);
  const names = Object.keys(aliases);
  if (!names.length) {
    console.log(t("chatConfig.typeEmpty", { prefix, type }));
    return;
  }
  console.log(t("chatConfig.aliasCount", { prefix, type, count: names.length }));
  for (const name of names) {
    console.log(`  ${name} = ${mask(aliases[name])}`);
  }
}

/** 装配 +chat 与 chat-config */
export function registerChatCommands(program: Command, getGlobals: () => GlobalArgs): void {
  program
    .command("+chat")
    .description(t("group.chat.desc"))
    // 问题作为位置参数：`thcli +chat --model m "问题"` 比 --message 更顺手，
    // 也与「选好模型直接执行任务」的设计形态一致
    .argument("[text...]", t("chat.arg.text"))
    .requiredOption("--model <model>", t("chat.opt.model"))
    .option("--input <path>", t("chat.opt.input"), collect)
    .option("--stream", t("chat.opt.stream"))
    .option("--search", t("chat.opt.search"))
    .option("--responses", t("chat.opt.responses"))
    .option("--thinking", t("chat.opt.thinking"))
    .option("--no-thinking", t("chat.opt.noThinking"))
    .option("--plan <type>", t("chat.opt.plan"))
    .option("--anthropic", t("chat.opt.anthropic"))
    .option("--verbose", t("chat.opt.verbose"))
    .option("--max-tokens <n>", t("chat.opt.maxTokens"))
    .option("--api-key <key>", t("chat.opt.apiKey"))
    .option("--alias <alias>", t("opt.aliasPick"), DEFAULT_ALIAS)
    .option("--area <area>", t("opt.areaChat"), DEFAULT_REGION)
    // 位置参数收成一个字符串塞进 message：下游按 message 取值的地方无需改动。
    // 用变长 [text...] 而不是单个 <text>，这样未加引号的多词输入也能正常工作
    .action(async (text: string[], opts: ChatOptions) =>
      chatCommand({ ...opts, message: text.join(" ") || opts.message }, getGlobals()),
    );

  const config = program
    .command("chat-config")
    .description(t("group.chatconfig.desc"));

  config
    .command("set")
    .description(t("chatConfig.set.desc"))
    .requiredOption("--value <key>", t("chatConfig.set.opt.value"))
    .option("--type <type>", t("opt.keyType"), "th")
    .option("--alias <alias>", t("opt.alias"), DEFAULT_ALIAS)
    .option("--area <area>", t("opt.area"), DEFAULT_REGION)
    .action((opts) => configSet(opts, getGlobals()));

  config
    .command("get")
    .description(t("chatConfig.get.desc"))
    .option("--type <type>", t("opt.keyType"), "th")
    .option("--alias <alias>", t("chatConfig.get.opt.alias"))
    .option("--area <area>", t("opt.area"), DEFAULT_REGION)
    .action((opts) => configGet(opts, getGlobals()));
}
