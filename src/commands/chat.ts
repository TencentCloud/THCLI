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
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";

import { allowedRegions, chatHostOf, DEFAULT_REGION, planOriginOf } from "../core/config.js";
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
  loadDataConfig,
  resolveRegionKey,
  saveDataConfig,
  setRegionKey,
  type KeyType,
} from "../core/keystore.js";
import { logDataPlaneCall } from "../core/telemetry.js";
import { lookupError } from "../core/errors.js";
import { t } from "../core/i18n.js";

/** 各通道的 URL 路径 */
const CHANNEL_PATHS = {
  chat: "/v1/chat/completions",
  plan: "/plan/v3/chat/completions",
  planAnthropic: "/plan/anthropic/v1/messages",
  responses: "/v1/responses",
} as const;

type Channel = keyof typeof CHANNEL_PATHS;

/** body 结构的三种形状。与 URL 通道不是一一对应，见 resolveRequest */
type PayloadShape = "chat" | "responses" | "anthropic";

/**
 * Anthropic Messages API 的 max_tokens 是必填字段（OpenAI 侧可选）。用户没给就
 * 用这个默认值，否则请求会被直接拒。
 */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/** Anthropic 协议版本头。标准 API 要求携带 */
const ANTHROPIC_VERSION = "2023-06-01";

/** +chat 的参数 */
interface ChatOptions {
  model?: string;
  /** 用户输入的文本。来自位置参数，由 action 收拢后填入（无 --message 选项） */
  message?: string;
  input?: string;
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
}

/** 解析出的请求目标 */
interface ResolvedRequest {
  url: string;
  urlChannel: Channel;
  payloadChannel: PayloadShape;
  useTools: boolean;
  apiKey: string;
}

function resolveRequest(opts: ChatOptions, globals: GlobalArgs): ResolvedRequest {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  const region = opts.area ?? DEFAULT_REGION;

  // --plan 优先级最高：给了就锁定 plan 通道，不受 --responses/--search 影响
  let urlChannel: Channel;
  let keyType: KeyType;
  if (opts.plan) {
    if (opts.plan !== "tp-ep" && opts.plan !== "tp") {
      throw new Error(t("chat.badPlan"));
    }
    urlChannel = opts.anthropic ? "planAnthropic" : "plan";
    keyType = opts.plan;
  } else {
    if (opts.anthropic) {
      throw new Error(t("chat.anthropicNeedsPlan"));
    }
    // --search 隐含 --responses 的路由效果
    urlChannel = opts.responses || opts.search ? "responses" : "chat";
    keyType = "th";
  }

  // body 结构独立于 URL：只看 --responses/--search。
  // 例外是 Anthropic 通道——那条路径只认 Anthropic 的 body 结构，发别的形状
  // 必然被拒，且报的是字段级错误、看不出根因，所以这里必须跟着 URL 走。
  const payloadChannel: PayloadShape =
    urlChannel === "planAnthropic" ? "anthropic" : opts.responses || opts.search ? "responses" : "chat";

  const apiKey =
    opts.apiKey ??
    resolveRegionKey(loadDataConfig(profile), site, region, keyType, opts.alias);
  if (!apiKey) {
    throw new Error(
      `${t("chat.noKey", {
        site,
        area: region,
        type: keyType,
        alias: opts.alias ?? DEFAULT_ALIAS,
      })}\n${t("chat.noKeyFix", { type: keyType, area: region })}`,
    );
  }

  // plan 通道与数据面不在同一套服务上（国内站个人版走 lkeap），host 要分开解析。
  // planOriginOf 返回含 scheme 的 origin，因为个别测试集群是 http。
  const env = resolveEnv();
  const origin =
    urlChannel === "plan" || urlChannel === "planAnthropic"
      ? planOriginOf(opts.plan!, site, region, env)
      : `https://${chatHostOf(site, region, env)}`;
  return {
    url: `${origin.replace(/\/$/, "")}${CHANNEL_PATHS[urlChannel]}`,
    urlChannel,
    payloadChannel,
    useTools: Boolean(opts.search),
    apiKey,
  };
}

/** 图片扩展名 → MIME，走 image_url 通道 */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** 能当纯文本读进 prompt 的扩展名 */
const TEXT_EXT = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".log",
  ".xml",
  ".yaml",
  ".yml",
  ".html",
  ".js",
  ".ts",
  ".py",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".sh",
]);

/** 把 --input 解析成绝对路径 */
function resolveInputPath(rawPath: string): string {
  const cleaned = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const resolved = cleaned.startsWith("~") ? path.join(os.homedir(), cleaned.slice(1)) : cleaned;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(t("chat.inputMissing", { path: resolved }));
  }
  return resolved;
}

/**
 * 构造 message 的 content。
 *
 * 网关实测行为（2026-08 验证）：/v1/chat/completions 只接受两种内容块——纯 text
 * 和 image_url；任何 file/input_file 结构都被拒（400 invalid params）。所以：
 *   - 图片 → image_url（走视觉通道）
 *   - 文本类文档 → 读出内容拼进 text（网关不认文件块，只能内联）
 *   - 其它二进制（pdf/docx…）→ 明确报错，不发注定失败的请求
 */
function buildContent(opts: ChatOptions): unknown {
  if (!opts.input) {
    return opts.message ?? "";
  }

  const resolved = resolveInputPath(opts.input);
  const ext = path.extname(resolved).toLowerCase();

  // 图片：走 image_url
  const imageMime = IMAGE_MIME[ext];
  if (imageMime) {
    const dataUrl = `data:${imageMime};base64,${fs.readFileSync(resolved).toString("base64")}`;
    const parts: Array<Record<string, unknown>> = [];
    if (opts.message) {
      parts.push({ type: "text", text: opts.message });
    }
    parts.push({ type: "image_url", image_url: { url: dataUrl } });
    return parts;
  }

  // 文本类文档：网关不认文件块，把内容内联进 text
  if (TEXT_EXT.has(ext)) {
    const fileText = fs.readFileSync(resolved, "utf8");
    const header = opts.message ? `${opts.message}\n\n` : "";
    return `${t("chat.fileIntro", { header, name: path.basename(resolved) })}\n\n${fileText}`;
  }

  // 其它二进制格式当前网关不支持，直接报错而不是发一个注定 400 的请求
  throw new Error(
    `${t("chat.unsupportedFile", {
      ext: ext || t("chat.unsupportedExtFallback"),
      images: Object.keys(IMAGE_MIME).join("/"),
      texts: [...TEXT_EXT].slice(0, 5).join("/"),
    })}\n${t("chat.unsupportedFileFix")}`,
  );
}

/**
 * Anthropic Messages API 的 body。与 OpenAI 侧有四处结构差异，逐条对应：
 *   max_tokens   必填（OpenAI 可选）——缺了直接被拒，故有默认值
 *   图片块       {type:"image",source:{type:"base64",media_type,data}}
 *                而不是 OpenAI 的 {type:"image_url",image_url:{url}}
 *   thinking     需要 budget_tokens，且必须小于 max_tokens
 *   工具         Anthropic 的 web_search 工具定义与 OpenAI 不同，暂不支持
 */
function buildAnthropicPayload(opts: ChatOptions): Record<string, unknown> {
  const maxTokens = Number(opts.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error(t("chat.badMaxTokens"));
  }

  const payload: Record<string, unknown> = {
    model: opts.model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: buildAnthropicContent(opts) }],
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

/** Anthropic 的 content 块。图片用 base64 source，与 OpenAI 的 image_url 不同 */
function buildAnthropicContent(opts: ChatOptions): unknown {
  if (!opts.input) {
    return opts.message ?? "";
  }
  const resolved = resolveInputPath(opts.input);
  const ext = path.extname(resolved).toLowerCase();

  const imageMime = IMAGE_MIME[ext];
  if (imageMime) {
    const parts: Array<Record<string, unknown>> = [];
    if (opts.message) {
      parts.push({ type: "text", text: opts.message });
    }
    parts.push({
      type: "image",
      source: {
        type: "base64",
        media_type: imageMime,
        data: fs.readFileSync(resolved).toString("base64"),
      },
    });
    return parts;
  }

  if (TEXT_EXT.has(ext)) {
    const fileText = fs.readFileSync(resolved, "utf8");
    const header = opts.message ? `${opts.message}\n\n` : "";
    return `${t("chat.fileIntro", { header, name: path.basename(resolved) })}\n\n${fileText}`;
  }

  throw new Error(
    `${t("chat.unsupportedFile", {
      ext: ext || t("chat.unsupportedExtFallback"),
      images: Object.keys(IMAGE_MIME).join("/"),
      texts: [...TEXT_EXT].slice(0, 5).join("/"),
    })}\n${t("chat.unsupportedFileFix")}`,
  );
}

function buildPayload(opts: ChatOptions, req: ResolvedRequest): Record<string, unknown> {
  if (req.payloadChannel === "anthropic") {
    return buildAnthropicPayload(opts);
  }
  const content = buildContent(opts);
  const payload: Record<string, unknown> = { model: opts.model };

  if (req.payloadChannel === "responses") {
    payload["input"] = [{ role: "user", content }];
  } else {
    payload["messages"] = [{ role: "user", content }];
  }
  payload["stream"] = Boolean(opts.stream);

  if (req.useTools) {
    payload["tools"] = [
      { type: "web_search", name: "web_search", description: t("chat.toolSearchDesc") },
    ];
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

/** 从响应头/体里提取网关真实返回的 request_id，客户端从不自己生成 */
function extractRequestId(headers: Headers, body?: Record<string, unknown>): string | undefined {
  const fromHeader = headers.get("x-request-id") ?? headers.get("x-trace-id");
  if (fromHeader) return fromHeader;
  if (!body) return undefined;
  if (typeof body["id"] === "string") return body["id"];
  const error = body["error"] as Record<string, unknown> | undefined;
  if (error && typeof error["request_id"] === "string") return error["request_id"];
  const resp = body["Response"] as Record<string, unknown> | undefined;
  if (resp && typeof resp["RequestId"] === "string") return resp["RequestId"];
  return undefined;
}

/**
 * 从网关错误体里取业务码（`error.code`，六位数字，与 HTTP 状态码独立）。
 *
 * 网关的 message 已含修复建议，但那是面向 HTTP 调用方的通用话术；取到码后可以再补一条
 * 带 thcli 命令的建议，省去用户另开一次 doctor error。
 */
function extractBusinessCode(body: Record<string, unknown> | string): string | undefined {
  if (typeof body === "string") return undefined;
  const error = body["error"] as Record<string, unknown> | undefined;
  const code = error?.["code"];
  if (typeof code === "string") return code;
  if (typeof code === "number") return String(code);
  return undefined;
}

function extractErrorDetail(body: Record<string, unknown> | string): string {
  if (typeof body === "string") return body;
  const error = body["error"] as Record<string, unknown> | undefined;
  if (error) {
    const msg = error["message_zh"] ?? error["message"];
    if (typeof msg === "string") return msg;
  }
  const resp = body["Response"] as Record<string, unknown> | undefined;
  const respError = resp?.["Error"] as Record<string, unknown> | undefined;
  if (respError && typeof respError["Message"] === "string") return respError["Message"];
  return JSON.stringify(body);
}

/** 流式：逐块打印。各通道的 chunk 结构不同 */
async function printStream(
  body: ReadableStream<Uint8Array>,
  payloadChannel: PayloadShape,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
        if (payloadChannel === "anthropic") {
          // Anthropic 流是带类型的事件流，正文只在 content_block_delta 里；
          // 其余（message_start / ping / message_stop 等）没有可打印内容
          const delta = evt["delta"] as Record<string, unknown> | undefined;
          if (evt["type"] === "content_block_delta" && typeof delta?.["text"] === "string") {
            process.stdout.write(delta["text"]);
          }
        } else if (payloadChannel === "responses") {
          // responses 通道的 delta 是裸字符串
          if (typeof evt["delta"] === "string") process.stdout.write(evt["delta"]);
        } else {
          const choices = evt["choices"] as Array<Record<string, unknown>> | undefined;
          const delta = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
          if (typeof delta?.["content"] === "string") process.stdout.write(delta["content"]);
        }
      } catch {
        // 非 JSON 的心跳/注释行直接跳过
      }
    }
  }
  process.stdout.write("\n");
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

async function chatCommand(opts: ChatOptions, globals: GlobalArgs): Promise<void> {
  if (!opts.model) {
    throw new Error(
      t("chat.needModel"),
    );
  }
  if (!opts.message && !opts.input) {
    throw new Error(t("chat.needContent"));
  }
  if (opts.area && !allowedRegions(resolveSite(globals)).includes(opts.area)) {
    throw new Error(
      t("chat.badArea", {
        site: resolveSite(globals),
        area: opts.area,
        options: allowedRegions(resolveSite(globals)).join(", "),
      }),
    );
  }

  const req = resolveRequest(opts, globals);
  const payload = buildPayload(opts, req);
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  const start = Date.now();

  let resp: Response;
  try {
    // Anthropic 路径额外带协议版本头与 x-api-key：网关是"兼容实现"，标准
    // Anthropic 客户端用 x-api-key、而本网关 OpenAI 侧用 Bearer，两个都带上
    // 以覆盖两种校验方式（多余的头不会被拒）。
    const headers: Record<string, string> = {
      Authorization: `Bearer ${req.apiKey}`,
      "Content-Type": "application/json",
    };
    if (req.payloadChannel === "anthropic") {
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      headers["x-api-key"] = req.apiKey;
    }
    resp = await fetch(req.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // 网络层错误：请求根本没到网关，不存在 request_id
    logDataPlaneCall(profile, site, {
      channel: req.urlChannel,
      durationMs: Date.now() - start,
      status: "error",
      error: (err as Error).message,
    });
    console.log(t("chat.requestFailed", { message: (err as Error).message }));
    console.log(t("chat.noRequestId"));
    return;
  }

  if (!resp.ok) {
    const text = await resp.text();
    let parsed: Record<string, unknown> | string = text;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // 非 JSON 错误体，原样透传
    }
    const requestId = extractRequestId(
      resp.headers,
      typeof parsed === "string" ? undefined : parsed,
    );
    logDataPlaneCall(profile, site, {
      channel: req.urlChannel,
      requestId,
      durationMs: Date.now() - start,
      status: "error",
      error: `HTTP ${resp.status}`,
    });
    console.log(
      t("chat.httpFailed", { status: resp.status, statusText: resp.statusText, url: req.url }),
    );
    console.log(t("chat.errorDetail", { detail: extractErrorDetail(parsed) }));
    // 业务码已收录时补一条 thcli 侧的修复建议；未收录就不打，避免给出泛泛而谈的噪音
    const businessCode = extractBusinessCode(parsed);
    if (businessCode) {
      const info = lookupError(businessCode);
      if (info) {
        console.log(`  ${t("error.code", { code: businessCode })}`);
        console.log(`  ${t("error.fix", { fix: info.fix })}`);
      }
    }
    console.log(`Request ID: ${requestId ?? "-"}`);
    return;
  }

  if (opts.stream && resp.body) {
    // 流式下只能从响应头取 request_id（body 是 SSE 流，不能当 JSON 解析）
    const requestId = extractRequestId(resp.headers);
    await printStream(resp.body, req.payloadChannel);
    logDataPlaneCall(profile, site, {
      channel: req.urlChannel,
      requestId,
      durationMs: Date.now() - start,
      status: "ok",
      extra: { model: opts.model, stream: true },
    });
    return;
  }

  const body = (await resp.json()) as Record<string, unknown>;
  logDataPlaneCall(profile, site, {
    channel: req.urlChannel,
    requestId: extractRequestId(resp.headers, body),
    durationMs: Date.now() - start,
    status: "ok",
    extra: { model: opts.model },
  });
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
    .option("--input <path>", t("chat.opt.input"))
    .option("--stream", t("chat.opt.stream"))
    .option("--search", t("chat.opt.search"))
    .option("--responses", t("chat.opt.responses"))
    .option("--thinking", t("chat.opt.thinking"))
    .option("--no-thinking", t("chat.opt.noThinking"))
    .option("--plan <type>", t("chat.opt.plan"))
    .option("--anthropic", t("chat.opt.anthropic"))
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
