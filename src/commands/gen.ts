/**
 * +gen：生图 / 生视频 / 生 3D / 语音（数据面，Bearer API Key，按量计费）。
 *
 * 与 +chat 同属数据面直连（命令名同样带 + 前缀），Key 解析也与 +chat 一致
 * （--api-key > keystore th/<alias>）。厂商差异全部在 core/gen-registry.ts 的
 * 注册表里，这里只做：接口字段解析与本地文件编码 → --param / --body 分层合并 → 校验 →
 * 提交 → 轮询 → 打印 / 下载。
 *
 * 结果 URL 是临时签名地址（约 12 小时），所以 --output 时直接下载到本地。
 */
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

import { AUDIO_MIME, IMAGE_MIME, resolveInputPath, VIDEO_MIME } from "../core/chat-content.js";
import { authHeadersOf } from "../core/data-plane.js";
import { allowedRegions, chatHostOf, DEFAULT_REGION, deepMerge } from "../core/config.js";
import { Agent } from "undici";
import { type GlobalArgs, resolveEnv, resolveProfile, resolveSite } from "../core/credentials.js";
import { collect, printTable, printWrappedTable, type WrapColumn } from "../core/format.js";
import { findTask, forEachLimit, type GenTask, loadTasks, needsRefresh, recordState, recordSubmitted, scopeOf } from "../core/gen-tasks.js";
import { t } from "../core/i18n.js";
import { DEFAULT_ALIAS, listSiteKeyScopes, loadDataConfig, resolveRegionKey } from "../core/keystore.js";
import {
  checkBody,
  APIS,
  apiOf,
  apiSupportsModel,
  type ApiRef,
  type FamilySpec,
  mapMedia,
  type MediaSpec,
  normalizeState,
  paramFlagSyntax,
  paramHelpText,
  paramText,
  paramUsage,
  type ParamSpec,
  parseJsonSafe,
  parseParams,
  parseParamValue,
  parseResponse,
  pick,
  type QuerySpec,
  setPath,
  str,
  type TaskResult,
} from "../core/gen-registry.js";
import { emitJson, isJson, redactLong, traceRequest, traceResponse } from "../core/output.js";
import { diagnoseCommandOf, extractRequestId, parseGatewayBody } from "../core/errors.js";
import { extractVendorError, genErrorLines, type VendorId, vendorErrorLines } from "../core/gen-errors.js";
import { logDataPlaneCall } from "../core/telemetry.js";
import { expandHome } from "../util/expand-home.js";

type Obj = Record<string, unknown>;

/** +gen 生成的参数（commander 解析后；接口字段 flag 按接口动态挂载，取值见 apiFlagValues） */
interface GenOptions {
  model?: string;
  param?: string[];
  body?: string;
  wait?: boolean;
  output?: string;
  timeout?: string;
  interval?: string;
  /** 429 限流退避重试次数（提交段；轮询由 --timeout 兜底） */
  retry?: string;
  apiKey?: string;
  alias?: string;
  area?: string;
  verbose?: boolean;
  dryRun?: boolean;
}

/** +gen resource 子命令额外的参数 */
interface ResourceOptions extends GenOptions {
  images?: string[];
  input?: string;
  refVideo?: string;
  taskId?: string;
  elementId?: string;
  voiceId?: string;
}

/** 轮询缺省值：文档建议 3~5 秒一次；视频通常数分钟 */
const DEFAULT_INTERVAL_SEC = 5;
/** 同步单次请求与异步轮询共用的默认超时（秒）：同步接口也在等结果，与轮询统一时间 */
const DEFAULT_TIMEOUT_SEC = 1800;

/** 数据面上下文：origin + Key + 日志维度 */
interface GenContext {
  origin: string;
  apiKey: string;
  profile: string;
  site: string;
  /** 数据面地域（记进本地任务记录：之后查询要用同一地域的 Key） */
  area: string;
  /** 把每次请求与原始响应打到 stderr（Key 打码，Base64 截断），排查与核对参数用 */
  verbose: boolean;
  /** 本次调用的模型：报错时按它给修复建议（如未开后付费 → models activate <模型>） */
  model?: string;
  /** 本次用的 Key 别名（报错时拼 doctor model 诊断命令） */
  alias?: string;
  /** Key 来自 --api-key（不在本地 keystore） */
  adHocKey?: boolean;
  /** 模型厂商：报错时按厂商错误格式与错误码表解析 */
  vendor?: VendorId;
  /** 单次请求超时（毫秒）：取 --timeout（同步提交 / 异步查询 / 资源接口共用），覆盖 undici 默认的 300s */
  timeoutMs: number;
}

function contextOf(opts: GenOptions, globals: GlobalArgs, model?: string, vendor?: VendorId): GenContext {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  const region = opts.area ?? DEFAULT_REGION;
  if (!allowedRegions(site).includes(region)) {
    throw new Error(t("chat.badArea", { site, area: region, options: allowedRegions(site).join(", ") }));
  }
  const keyConfig = loadDataConfig(profile);
  const apiKey = opts.apiKey ?? resolveRegionKey(keyConfig, site, region, "th", opts.alias);
  if (!apiKey) {
    // 默认地域查不到 Key 时列出该站点已配置的地域（国际站 Key 常在 sg，
    // 缺省 gz 查不到会让用户误以为 Key 没配/配错）
    const scopes = listSiteKeyScopes(keyConfig, site, "th");
    const areaHint = scopes.length ? `\n${t("chat.noKeyAreaHint", { scopes: scopes.join("、") })}` : "";
    throw new Error(
      `${t("chat.noKey", { site, area: region, type: "th", alias: opts.alias ?? DEFAULT_ALIAS })}\n${t(
        "chat.noKeyFix",
        { type: "th", area: region },
      )}${areaHint}`,
    );
  }
  return {
    origin: `https://${chatHostOf(site, region, resolveEnv())}`,
    apiKey,
    profile,
    site,
    area: region,
    verbose: Boolean(opts.verbose),
    model,
    alias: opts.alias,
    adHocKey: Boolean(opts.apiKey),
    vendor,
    timeoutMs: (numberOpt(opts.timeout, "--timeout") ?? DEFAULT_TIMEOUT_SEC) * 1000,
  };
}

/** 失败时附带的 doctor 诊断命令；--api-key 临时传入的 Key 不在本地，doctor 查不到它，不附 */
function diagnoseOf(ctx: GenContext): string | undefined {
  return ctx.model && !ctx.adHocKey ? diagnoseCommandOf(ctx.model) : undefined;
}

/** 按接口 ID 取接口，未知则报错并指向接口列表 */
function requireApi(id: string): ApiRef {
  const api = apiOf(id);
  if (!api) throw new Error(t("gen.unknownApi", { api: id, cmd: "thcli +gen apis" }));
  return api;
}

/**
 * 一次数据面请求。失败时把网关错误体原样带出（含 request_id），不吞信息——
 * 生成类接口的报错（内容审核、未开通后付费、并发超限）只有原文能看出原因。
 */
/** 按 --timeout 缓存 dispatcher：undici 全局默认 headersTimeout/bodyTimeout 各 300s，同步生成可能超过，
 *  用 Agent 把这两个超时也统一到 --timeout（1800s 默认），否则 signal 等再久也会先被 undici 掐断 */
const dispatchers = new Map<number, Agent>();

function dispatcherFor(timeoutMs: number): Agent {
  let agent = dispatchers.get(timeoutMs);
  if (!agent) {
    agent = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    dispatchers.set(timeoutMs, agent);
  }
  return agent;
}

/**
 * 单次请求的宽超时（毫秒）：异步路径的提交 / 查询不跟 --timeout——小值会把正常提交掐死
 * （--timeout 1 的语义是「最多等 1 秒结果」，不是「提交只能花 1 秒」）；轮询总超时仍由 --timeout 控制。
 * 同步提交是单次请求即结果，例外地跟 --timeout（默认 1800s）。
 */
const WIDE_REQUEST_MS = DEFAULT_TIMEOUT_SEC * 1000;

/** 请求超时的中性基座错误：带 requestTimeout 标记，由调用方 catch 后按场景补指引——
 *  同步提交 = 未提交可重试；异步提交 = 无法确认是否已创建（防重复扣费）；查询 = 任务已提交给重查命令 */
function requestTimeoutError(seconds: number): Error {
  return Object.assign(new Error(t("gen.requestTimeout", { seconds })), { requestTimeout: true });
}

function isRequestTimeout(err: unknown): boolean {
  return err instanceof Error && (err as { requestTimeout?: boolean }).requestTimeout === true;
}

function isNetworkError(err: unknown): boolean {
  return err instanceof Error && (err as { networkError?: boolean }).networkError === true;
}

/** 429 退避重试默认次数 */
const DEFAULT_RETRY = 3;
/** 429 重试的累计等待预算（毫秒）：防止 Retry-After 巨值或过多重试把提交段拖死 */
const RETRY_BUDGET_MS = 60_000;

/** Retry-After 头解析：只认纯数字秒数（HTTP 日期形式极少用于限流，忽略），无/非法 → undefined */
function parseRetryAfterSec(raw: string | null): number | undefined {
  return raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
}

function isRateLimited(err: unknown): boolean {
  return err instanceof Error && (err as { rateLimited?: boolean }).rateLimited === true;
}

function retryAfterSecOf(err: unknown): number | undefined {
  return (err as { retryAfterSec?: number }).retryAfterSec;
}

/** 第 attempt 次重试（1 起）前应等待的毫秒：1s/2s/4s，之后每次 4s；Retry-After 优先（单次也受总预算约束） */
export function backoffMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined) return Math.min(retryAfterSec * 1000, RETRY_BUDGET_MS);
  return 2 ** Math.min(attempt - 1, 2) * 1000;
}

/** 耗尽 429 重试后的错误：原错误信息（含 Request ID 等）+ 已重试次数与去向 */
function rateLimitExhaustedError(err: unknown, attempts: number): Error {
  return new Error(`${(err as Error).message}\n${t("gen.rateLimitExhausted", { n: attempts })}`);
}

/**
 * 429 退避重试包装：只拦带 rateLimited 标记的错误（HTTP 429 = 请求未受理，重试无重复扣费风险；
 * 超时/其它错误原样抛出）。重试耗尽或预算用尽时抛「原错误 + 已重试次数」。
 * sleepFn 可注入（测试用）。
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  onWait?: (info: { attempt: number; total: number; sec: number }) => void,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  let spent = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimited(err)) throw err;
      if (attempt >= retries) throw attempt > 0 ? rateLimitExhaustedError(err, attempt) : err;
      const waitMs = backoffMs(attempt + 1, retryAfterSecOf(err));
      if (spent + waitMs > RETRY_BUDGET_MS) throw rateLimitExhaustedError(err, attempt);
      spent += waitMs;
      onWait?.({ attempt: attempt + 1, total: retries, sec: Math.round(waitMs / 1000) });
      await sleepFn(waitMs);
    }
  }
}

/** 参数含空白 / 引号时按 POSIX 单引号转义，保证提示里的命令复制后可原样执行 */
function shellQuote(arg: string): string {
  return /[\s'"]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg;
}

/** 用户敲的原始命令（超时指引里给可复制的重试命令）：bin 名取 argv[1]（npm link 后即 thcli/th），直跑产物回退 thcli */
function retryCommand(): string {
  const bin = path.basename(process.argv[1] ?? "thcli");
  return `${bin === "main.cjs" ? "thcli" : bin} ${process.argv.slice(2).map(shellQuote).join(" ")}`;
}

/** 查询请求超时 / 网络中断 → 补「任务已提交 + 重查命令」；其他错误原样抛出（调用方直接 throw 本函数结果） */
function queryTimeoutHint(err: unknown, cmd: string): Error {
  if (isRequestTimeout(err) || isNetworkError(err)) return new Error(`${(err as Error).message}\n${t("gen.queryTimeout", { cmd })}`);
  return err as Error;
}

/** Ctrl+C 中断指引：等待期间挂上「下一步怎么办」，退出前打到 stderr——
 *  异步任务的 ID 只在「已提交」一行里，不提示的话中断后用户找不回任务 */
let interruptHint: string | null = null;
let sigintInstalled = false;

function setInterruptHint(hint: string): void {
  interruptHint = hint;
  if (sigintInstalled) return;
  sigintInstalled = true;
  process.on("SIGINT", () => {
    if (interruptHint) console.error(`\n${interruptHint}`);
    process.exit(130); // 128 + SIGINT(2)：shell 惯例的中断退出码
  });
}

async function request(ctx: GenContext, method: "GET" | "POST", urlPath: string, body?: Obj, timeoutMs: number = ctx.timeoutMs): Promise<Obj> {
  const start = Date.now();
  // 生成类接口都是 Bearer（各厂商调用指南）；GET 查询没有请求体，不带 Content-Type
  const { "Content-Type": contentType, ...auth } = authHeadersOf("openai", ctx.apiKey);
  const headers: Record<string, string> = body ? { ...auth, "Content-Type": contentType! } : auth;
  if (ctx.verbose) traceRequest(method, `${ctx.origin}${urlPath}`, headers, body);
  let resp: Response;
  try {
    // undici 版本须与 @types/node 内置的 undici-types 同代（6.x）：7.x 的类型与全局 fetch 的
    // RequestInit 不兼容。dispatcher 让 --timeout 真正生效：仅靠 signal 时 undici 默认的
    // headersTimeout/bodyTimeout（各 300s）会先掐断请求
    const init: RequestInit & { dispatcher?: Agent } = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: dispatcherFor(timeoutMs),
    };
    resp = await fetch(`${ctx.origin}${urlPath}`, init);
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw requestTimeoutError(Math.round(timeoutMs / 1000));
    }
    // 网络层错误（undici 的 fetch failed / terminated：连接失败或响应中断）：
    // 请求未完成、无 Request ID。挂标记由调用方分流——轮询跳过本轮、下载退避重试、
    // 提交按「无法确认是否已创建」给指引（与超时同性质，不能盲目重试防重复扣费）
    throw Object.assign(err as Error, { networkError: true });
  }
  const text = await resp.text();
  const respBody = parseGatewayBody(text);
  const parsed: Obj = typeof respBody === "string" ? {} : respBody;
  const requestId = extractRequestId(resp.headers, parsed);
  logDataPlaneCall(ctx.profile, ctx.site, {
    channel: `gen:${urlPath.split("/").slice(0, 5).join("/")}`,
    requestId: requestId ?? undefined,
    durationMs: Date.now() - start,
    status: resp.ok ? "ok" : "error",
    error: resp.ok ? undefined : `HTTP ${resp.status}`,
  });
  if (ctx.verbose) traceResponse(resp.status, Date.now() - start, text);
  if (!resp.ok) {
    // 与 +chat 同一套展示：说明、业务码 + 修复建议（按 +gen 场景）、Request ID；非 JSON 错误体截断原文
    const shown = typeof respBody === "string" ? text.slice(0, 2000) : respBody;
    const lines = genErrorLines(shown, requestId, {
      genModel: ctx.model,
      diagnose: diagnoseOf(ctx),
      vendor: ctx.vendor,
      retryAfter: resp.headers.get("retry-after") ?? undefined,
      status: resp.status,
    });
    const err = new Error([t("gen.httpFailed", { status: resp.status, url: urlPath }), ...lines].join("\n"));
    // 429：挂标记交给调用方退避重试（请求未受理，重试安全）；其它状态码原样抛
    if (resp.status === 429) {
      Object.assign(err, { rateLimited: true, retryAfterSec: parseRetryAfterSec(resp.headers.get("retry-after")) });
    }
    // 401：除 Key 本身错误外，地域不匹配也会 401（默认 gz，国际站 Key 常在 sg）——
    // 本地存储的 Key 提示换地域，--api-key 临时指定的不涉及本地存储
    if (resp.status === 401 && !ctx.adHocKey) {
      err.message += `\n${t("gen.authAreaHint", { area: ctx.area, cmd: "thcli key list" })}`;
    }
    throw err;
  }
  return parsed;
}

/** 缺省单张图片上限：75MB 原始 → 100MB base64，压网关请求体上限（本地先拦，免得发出 413） */
const DEFAULT_IMAGE_BYTES = 75 * 1000 * 1000;

/** 字节数 → "12.3MB"（十进制） */
function mb(n: number): string {
  return `${(n / 1000000).toFixed(1).replace(/\.0$/, "")}MB`;
}

/** data URL 的 MIME → 落盘扩展名（hex 转 data URL 的音频结果下载用） */
const DATA_URL_EXT: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/pcm": ".pcm",
};

/**
 * 字段值是否为本地文件引用：@路径，或磁盘上存在的文件路径。
 * URL / data URI / Base64 / ID 等一律不算，原样传。
 */
function localPathOf(value: string): string | undefined {
  if (/^(https?:|data:)/i.test(value)) return undefined;
  if (value.startsWith("@")) return resolveInputPath(value);
  const candidate = expandHome(value);
  try {
    return candidate.length < 4096 && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 单个字段值的本地文件编码：URL / Base64 原样；本地文件按字段的 media 规则编码。
 * 只收 URL 的字段遇到本地文件直接拦截——发出去也只会收到一个看不出原因的 400；
 * 非 URL 形态的值（如写错的不存在路径）同样拦截——否则会被当 URL 字符串发到
 * 服务端，用户等到 url 校验 400 才知道路径写错，且已消耗一次提交。
 * 图片的字节上限与格式白名单只对本地文件生效（URL 留给服务端校验）。
 */
function encodeMediaValue(family: FamilySpec, p: ParamSpec, media: MediaSpec, value: string): string {
  const file = localPathOf(value);
  if (!file) {
    if (media.encoding === "urlOnly" && !/^(https?:|data:)/i.test(value)) {
      throw new Error(t("gen.fieldNotUrl", { flag: `--${p.flag}`, value }));
    }
    return value;
  }
  if (media.encoding === "urlOnly") {
    throw new Error(t("gen.fieldUrlOnly", { flag: `--${p.flag}`, name: path.basename(file) }));
  }
  const ext = path.extname(file).toLowerCase();
  // auto：图片或视频均可，按扩展名分派（图片走族 formats/sizeLimit，音视频走字段 formats/maxBytes）
  const kind = media.type === "auto"
    ? (IMAGE_MIME[ext] ? "image" : AUDIO_MIME[ext] || VIDEO_MIME[ext] ? "media" : "unknown")
    : media.type;
  let mime: string | undefined;
  if (kind === "image") {
    if (VIDEO_MIME[ext]) throw new Error(t("gen.fieldUrlOnly", { flag: `--${p.flag}`, name: path.basename(file) }));
    mime = IMAGE_MIME[ext];
    if (!mime) throw new Error(t("gen.imageBadFormat", { model: family.id, mime: ext || "?", formats: (family.formats ?? []).join("/") }));
    if (family.formats && !family.formats.includes(mime.split("/")[1] ?? "")) {
      throw new Error(t("gen.imageBadFormat", { model: family.id, mime, formats: family.formats.join("/") }));
    }
    const limit = family.sizeLimit ?? DEFAULT_IMAGE_BYTES;
    const size = fs.statSync(file).size;
    if (size > limit) {
      throw new Error(t("gen.imageTooLarge", { model: family.id, name: path.basename(file), size: mb(size), limit: mb(limit) }));
    }
  } else if (kind === "media") {
    mime = AUDIO_MIME[ext] ?? VIDEO_MIME[ext];
    if (!mime) throw new Error(t("gen.inputBadFile", { name: path.basename(file) }));
    // 字段级约束（如音色复刻只收 mp3/m4a/wav ≤20MB）：发出去才被拒会白等一次上传
    if (media.formats && !media.formats.includes(ext.slice(1))) {
      throw new Error(t("gen.mediaBadFormat", { flag: `--${p.flag}`, name: path.basename(file), formats: media.formats.join("/") }));
    }
    const size = fs.statSync(file).size;
    if (media.maxBytes !== undefined && size > media.maxBytes) {
      throw new Error(t("gen.mediaTooLarge", { flag: `--${p.flag}`, name: path.basename(file), size: mb(size), limit: mb(media.maxBytes) }));
    }
  } else {
    throw new Error(t("gen.inputBadFile", { name: path.basename(file) }));
  }
  const b64 = fs.readFileSync(file).toString("base64");
  return media.encoding === "raw" ? b64 : `data:${mime};base64,${b64}`;
}

/** 接口字段 flag 的取值：解析 + 本地文件编码，返回请求体顶层字段；flag 未传时写入注册表声明的默认值 */
function apiFlagValues(api: ApiRef, opts: Obj): Obj {
  const values: Obj = {};
  for (const p of api.params) {
    const raw = opts[kebabToCamel(p.flag)];
    if (raw === undefined) {
      // 默认值仍可被 --param / --body 覆盖（generate 里 base 先组装、layerBody 后合并）
      if (p.default !== undefined) values[p.path] = p.default;
      continue;
    }
    let value = parseParamValue(p, String(raw));
    const specs = p.media ? (Array.isArray(p.media) ? p.media : [p.media]) : undefined;
    if (specs) for (const m of specs) value = mapMedia(value, m.keys, (s) => encodeMediaValue(api.family, p, m, s));
    values[p.path] = value;
  }
  return values;
}

/** --body：内联 JSON 或 @file（如回放 --dry-run 打出的请求体）；优先级最高 */
function readBodyOverride(raw: string | undefined): Obj {
  if (!raw) return {};
  let text = raw;
  if (raw.startsWith("@")) {
    const file = raw.slice(1);
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      throw new Error(t("gen.bodyFileMissing", { file }));
    }
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(text);
  } catch (err) {
    throw new Error(t("gen.bodyBadJson", { reason: (err as Error).message }));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(t("gen.badBody"));
  }
  return parsed as Obj;
}

/**
 * 请求体覆盖关系（后者覆盖前者）：接口参数 < --param < --body。
 * 对象逐层合并，数组和值整体替换。--param / --body 原样写入，不做本地文件编码；校验统一在合并后的最终请求体上做。
 */
function layerBody(base: Obj, opts: GenOptions): Obj {
  return deepMerge(deepMerge(base, parseParams(opts.param ?? [])), readBodyOverride(opts.body));
}

/** --voice-setting → voiceSetting（commander 的 camelCase 映射键） */
function kebabToCamel(name: string): string {
  return name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
}

function numberOpt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(t("gen.badNumber", { name }));
  }
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询间隔与截止时间（毫秒）；seconds 一并返回，超时提示里要告诉用户等了多久 */
function pollTiming(opts: GenOptions): { interval: number; deadline: number; seconds: number } {
  const seconds = numberOpt(opts.timeout, "--timeout") ?? DEFAULT_TIMEOUT_SEC;
  return {
    interval: (numberOpt(opts.interval, "--interval") ?? DEFAULT_INTERVAL_SEC) * 1000,
    deadline: Date.now() + seconds * 1000,
    seconds,
  };
}

/**
 * 轮询到终态或超时。进度打到 stderr，stdout 只留结果（便于管道）。
 * apiId：超时提示里拼 +gen status 查询命令用（status 的第一个参数是接口，不是模型）。
 */
async function poll(ctx: GenContext, family: FamilySpec, apiId: string, model: string, taskId: string, opts: GenOptions): Promise<{ result: TaskResult; raw: Obj }> {
  const { interval, deadline, seconds } = pollTiming(opts);
  const spec = family.query!(model, taskId);
  // Ctrl+C：任务已在云端跑，退出前把任务 ID 和重查命令留给用户（status --wait 也走这里）
  setInterruptHint(t("gen.interruptedWait", { id: taskId, cmd: statusCommandOf(apiId, taskId) }));
  let last = "";
  let rateStreak = 0;
  try {
    for (;;) {
      let raw: Obj | undefined;
      try {
        raw = await queryOnce(ctx, spec);
        rateStreak = 0;
      } catch (err) {
        // 429 / 网络瞬断（连接失败、响应中断）：都不算失败——任务已在云端，跳过本轮继续等
        // （--timeout 总超时兜底）；每连续 3 次提示一句，避免长时间静默让用户以为卡死
        if (isRateLimited(err) || isNetworkError(err)) {
          rateStreak++;
          if (rateStreak % 3 === 0 && !isJson()) console.error(t("gen.pollRateLimited", { n: rateStreak }));
        } else {
          // 查询中断时任务已提交：给重查命令——笼统的「可重试」会误导用户重新提交、重复扣费
          throw queryTimeoutHint(err, statusCommandOf(apiId, taskId));
        }
      }
      if (raw) {
        const result = parseResponse(family, raw);
        if (result.state === "succeeded" || result.state === "failed") {
          return { result, raw };
        }
        if (result.state !== last) {
          recordState(taskId, result.state, new Date());
          if (!isJson()) console.error(t("gen.progress", { state: result.state }));
          last = result.state;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(t("gen.timeout", { seconds, id: taskId, cmd: statusCommandOf(apiId, taskId) }));
      }
      await sleep(interval);
    }
  } finally {
    interruptHint = null;
  }
}

function queryOnce(ctx: GenContext, spec: QuerySpec): Promise<Obj> {
  return request(ctx, spec.method, spec.path, spec.body, WIDE_REQUEST_MS);
}

function statusCommandOf(apiId: string, taskId: string): string {
  return `thcli +gen status ${apiId} ${taskId} --wait`;
}

/**
 * 下载产物用的 fetch：网络错误（连接失败 / 响应中断）与 HTTP 429/5xx 退避重试（1s/2s/4s，共 3 次）。
 * 产物是已计费结果且 URL 幂等，重试安全；网络错误耗尽后抛带产物去向的提示（地址 12 小时内有效）。
 * fetchFn / sleepFn 可注入（测试用）。
 */
export async function fetchWithRetry(
  url: string,
  fetchFn: (u: string) => Promise<Response> = fetch,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let resp: Response | undefined;
    try {
      resp = await fetchFn(url);
    } catch (err) {
      if (attempt >= 2) throw new Error(t("gen.downloadNetworkFailed", { n: attempt, cause: (err as Error).message }));
      await sleepFn(2 ** attempt * 1000);
      continue;
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < 2) {
      // 丢弃前消费响应体：undici 的连接不读完不归还连接池
      await resp.body?.cancel().catch(() => {});
      await sleepFn(2 ** attempt * 1000);
      continue;
    }
    return resp;
  }
}

/**
 * 目标文件已被占用（磁盘已存在或本批已保存）时加序号找空位：result-1.txt → result-1-2.txt。
 * --output 的语义是「攒产物」：默认永不静默覆盖——批量循环与重跑同一任务都不丢数据。
 * 注：existsSync 与写入间存在 TOCTOU 窗口，多进程并发写同一目录时可能退化为覆盖
 * （不劣于旧行为），单进程场景无影响。
 */
export function dedupePath(file: string, taken: Set<string>): string {
  if (!taken.has(file) && !fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let n = 2; ; n++) {
    const next = `${stem}-${n}${ext}`;
    if (!taken.has(next) && !fs.existsSync(next)) return next;
  }
}

/** 落盘前统一防覆盖，改名时 stderr 提示一句（批量场景的可见性；--json 下静默） */
function reserveFile(file: string, taken: Set<string>): string {
  const target = dedupePath(file, taken);
  if (target !== file && !isJson()) {
    console.error(t("gen.savedRenamed", { file: path.basename(file), next: path.basename(target) }));
  }
  return target;
}

/** 下载结果到目录，文件名取 URL 路径的 basename（去掉签名参数，重名加序号）；data URL（hex 音频转来）直接解码 */
export async function download(urls: string[], dir: string): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const saved: string[] = [];
  const taken = new Set<string>();
  for (const [i, url] of urls.entries()) {
    if (url.startsWith("data:")) {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      const ext = m ? (DATA_URL_EXT[m[1]!] ?? ".bin") : ".bin";
      const file = reserveFile(path.join(dir, `result-${i}${ext}`), taken);
      fs.writeFileSync(file, Buffer.from(m ? m[2]! : "", "base64"));
      saved.push(file);
      taken.add(file);
      continue;
    }
    const resp = await fetchWithRetry(url);
    if (!resp.ok) {
      throw new Error(t("gen.downloadFailed", { status: resp.status, url }));
    }
    const base = path.basename(new URL(url).pathname) || `result-${i}`;
    const file = reserveFile(path.join(dir, base), taken);
    fs.writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
    saved.push(file);
    taken.add(file);
  }
  return saved;
}

/** 文本结果落盘（语音转写正文；下载与 URL 共用同一个 --output 目录，同样防覆盖） */
export function saveTexts(texts: string[] | undefined, dir: string, offset: number, taken: Set<string> = new Set()): string[] {
  if (!texts?.length) return [];
  return texts.map((text, i) => {
    const file = reserveFile(path.join(dir, `result-${offset + i}.txt`), taken);
    fs.writeFileSync(file, text, "utf8");
    taken.add(file);
    return file;
  });
}

/**
 * 厂商格式的错误（提交期的错误信封、生成期的失败任务）→ 带厂商错误码说明与修复建议的错误；
 * 不是厂商模型或响应里没有厂商错误时返回 undefined，调用方走原有兜底。
 */
function vendorFailure(ctx: GenContext, title: string, raw: Obj): Error | undefined {
  if (!ctx.vendor) return undefined;
  const hit = extractVendorError(ctx.vendor, raw);
  if (!hit) return undefined;
  return new Error([title, ...vendorErrorLines(hit, extractRequestId(new Headers(), raw), diagnoseOf(ctx))].join("\n"));
}

/** 终态输出：成功打印 URL / 文本 / 元数据（可选下载），失败抛错带原因（--json 时输出 JSON 并以非零码退出） */
async function finish(ctx: GenContext, result: TaskResult, raw: Obj, opts: GenOptions, taskId?: string): Promise<void> {
  // --output 在此统一做 ~ 展开（与 shell 一致）：不展开会在当前目录静默建出名为 ~ 的目录
  const outDir = opts.output ? expandHome(opts.output) : undefined;
  const saved = result.state === "succeeded" && outDir ? await download(result.urls, outDir) : [];
  const savedTexts = result.state === "succeeded" && outDir ? saveTexts(result.texts, outDir, saved.length, new Set(saved)) : [];
  const allSaved = [...saved, ...savedTexts];
  if (taskId) recordState(taskId, result.state, new Date(), allSaved);
  if (
    emitJson({
      TaskId: taskId ?? null,
      State: result.state,
      Urls: result.urls,
      ExtraUrls: result.extraUrls,
      Texts: result.texts,
      Meta: result.meta,
      // 失败原因：文本模式走下方 gen.failed 的报错文案，JSON 模式在此给出（脚本消费者不必翻 Raw）
      Error: result.error ?? null,
      Saved: allSaved,
      Raw: raw,
    })
  ) {
    if (result.state === "failed") process.exitCode = 1;
    return;
  }
  if (result.state === "failed") {
    throw vendorFailure(ctx, t("gen.taskFailed"), raw) ?? new Error(t("gen.failed", { reason: result.error ?? JSON.stringify(raw).slice(0, 500) }));
  }
  for (const text of result.texts ?? []) console.log(text);
  // data URL（hex 音频转来）可能极长，不整段打印；--output 时已落盘，否则走下面的过期提示
  for (const url of result.urls) {
    if (!url.startsWith("data:")) console.log(url);
  }
  for (const url of result.extraUrls) console.log(t("gen.preview", { url }));
  // 平台注入的用量（tokenhub_usage.total_tokens；个别族文档写 usage.total_tokens）：有才显示
  const tokens = str(pick(raw, "tokenhub_usage.total_tokens")) ?? str(pick(raw, "usage.total_tokens"));
  if (result.state === "succeeded" && tokens) console.log(t("gen.usage", { tokens }));
  if (result.meta) {
    for (const [key, value] of Object.entries(result.meta)) {
      if (value) console.log(`${key}: ${value}`);
    }
  }
  if (allSaved.length) {
    for (const file of allSaved) console.log(t("gen.saved", { file }));
  } else {
    console.error(t("gen.expiryHint"));
  }
}

// ==================== Kling 资源管理（+gen resource） ====================

/** Kling 资源描述符：自定义主体 / 自定义音色共用同一套创建（异步）- 查询 - 删除流程 */
interface KlingResource {
  name: string;
  /** create 结果里资源 ID 的字段名（element_id / voice_id） */
  idLabel: string;
  /** --element-id / --voice-id 经 commander 解析出的 camelCase 属性名 */
  idKey: "elementId" | "voiceId";
  /** create 的媒体输入形态：参考图 / 参考音频 */
  createMedia: "image" | "audio";
  createPath: string;
  queryPath: (id: string) => string;
  deletePath: string;
  resultPath: string;
  resultFields: string[];
  /** create 建模参数（--element-name 等；未建模的仍走 --param） */
  createParams?: ParamSpec[];
  /** 由专属媒体 flag 组装请求体（媒体编码 + flag 间互斥）；没给媒体 flag 时返回 {}，留给 --param / --body */
  buildCreate: (o: ResourceOptions) => Obj;
  buildDelete: (id: string) => Obj;
  /** 参数合并后（最终请求体）的必填校验 */
  require: (body: Obj) => void;
}

/**
 * 资源媒体输入：URL 原样；本地文件内联裸 base64（Kling 图片 / 音频 slot 收 Base64，视频仅 URL）。
 * 字节 / 尺寸约束留给服务端校验（文档：图片 ≤10MB ≥300px，音频 ≤5min）。
 */
function encodeResourceMedia(raw: string, mode: "raw" | "urlOnly"): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (mode === "urlOnly") throw new Error(t("gen.resource.videoUrlOnly"));
  return fs.readFileSync(resolveInputPath(raw)).toString("base64");
}

/** Kling 业务信封：code 非 0 抛错（creation / query / deletion 通用） */
function assertKling(resp: Obj, stage: "creation" | "query" | "deletion"): void {
  if (resp["code"] === undefined || resp["code"] === null || Number(resp["code"]) === 0) return;
  // 与 +gen 生成同一套：Kling 错误码表给说明与修复建议
  const hit = { vendor: "kling" as const, code: String(resp["code"]), message: str(resp["message"]) };
  throw new Error([t(`gen.resource.stage.${stage}`), ...vendorErrorLines(hit, str(resp["request_id"]))].join("\n"));
}

/** 创建结果里的资源信息（data.task_result.{elements|voices}[0]） */
function extractResource(resp: Obj, resultPath: string, fields: string[]): Record<string, string> {
  const item = ((pick(resp, resultPath) ?? []) as Obj[])[0] ?? {};
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = str(item[field]);
    if (value) out[field] = value;
  }
  return out;
}

function resourceQueryCmd(res: KlingResource, taskId: string): string {
  return `thcli +gen resource ${res.name} get --task-id ${taskId}`;
}

const KLING_RESOURCES: Record<string, KlingResource> = {
  "kling-element": {
    name: "kling-element",
    idLabel: "element-id",
    idKey: "elementId",
    createMedia: "image",
    createPath: "/v1/wand/kling/advanced-custom-elements",
    queryPath: (id) => `/v1/wand/kling/advanced-custom-elements/${encodeURIComponent(id)}`,
    deletePath: "/v1/wand/kling/delete-advanced-elements",
    resultPath: "data.task_result.elements",
    resultFields: ["element_id", "element_name", "element_description", "status"],
    createParams: [
      { flag: "element-name", path: "element_name", kind: "value", valueType: "string", desc: { zh: "主体名称（≤20 字符，必填）", en: "Element name (<=20 chars, required)" } },
      { flag: "element-description", path: "element_description", kind: "value", valueType: "string", desc: { zh: "主体描述（≤100 字符，必填）", en: "Element description (<=100 chars, required)" } },
      { flag: "element-voice-id", path: "element_voice_id", kind: "value", valueType: "string", desc: { zh: "绑定音色 ID（可空）", en: "Bound voice ID (optional)" } },
      {
        flag: "tag-list",
        path: "tag_list",
        kind: "array",
        desc: { zh: "标签（JSON 数组）:", en: "Tags (JSON array):" },
        fields: [{ key: "tag_id", type: "string", required: true, desc: { zh: "标签 ID：o_101 热梗/o_102 人物/o_103 动物/o_104 道具/o_105 服饰/o_106 场景/o_107 特效/o_108 其他", en: "Tag ID: o_101 meme/o_102 person/o_103 animal/o_104 prop/o_105 clothing/o_106 scene/o_107 effect/o_108 other" } }],
      },
      { flag: "external-task-id", path: "external_task_id", kind: "value", valueType: "string", desc: { zh: "自定义任务 ID（账号内唯一）", en: "Custom task ID (unique per account)" } },
    ],
    buildCreate: (o) => {
      const images = (o.images ?? []).map((raw) => encodeResourceMedia(raw, "raw"));
      const videos = o.refVideo ? [encodeResourceMedia(o.refVideo, "urlOnly")] : [];
      if (images.length > 4) throw new Error(t("gen.resource.tooManyImages"));
      if (videos.length > 1) throw new Error(t("gen.resource.tooManyVideos"));
      if (images.length && videos.length) throw new Error(t("gen.resource.imageVideoExclusive"));
      if (!images.length && !videos.length) return {};
      if (videos.length) {
        return { reference_type: "video_refer", element_video_list: { refer_videos: videos.map((url) => ({ video_url: url })) } };
      }
      // 文档 + 上游校验：image_refer 需 1 张正面 + 1~3 张其他角度（单张正面会被拒）
      if (images.length < 2) throw new Error(t("gen.resource.needMoreImages"));
      const [frontal, ...refers] = images;
      return {
        reference_type: "image_refer",
        element_image_list: {
          frontal_image: frontal,
          refer_images: refers.map((url) => ({ image_url: url })),
        },
      };
    },
    buildDelete: (id) => ({ element_id: id }),
    require: (body) => {
      for (const field of ["element_name", "element_description"]) {
        if (!str(body[field])) throw new Error(t("gen.resource.needParam", { field: field.replace(/_/g, "-") }));
      }
      if (!body["element_image_list"] && !body["element_video_list"]) throw new Error(t("gen.resource.needMedia"));
    },
  },
  "kling-voice": {
    name: "kling-voice",
    idLabel: "voice-id",
    idKey: "voiceId",
    createMedia: "audio",
    createPath: "/v1/wand/kling/custom-voices",
    queryPath: (id) => `/v1/wand/kling/custom-voices/${encodeURIComponent(id)}`,
    deletePath: "/v1/wand/kling/delete-voice",
    resultPath: "data.task_result.voices",
    resultFields: ["voice_id", "voice_name", "trial_url", "status"],
    createParams: [
      { flag: "voice-name", path: "voice_name", kind: "value", valueType: "string", desc: { zh: "音色名称（必填）", en: "Voice name (required)" } },
      { flag: "video-id", path: "video_id", kind: "value", valueType: "string", desc: { zh: "含目标音频的视频 ID（与 --input 二选一）", en: "Video ID containing the target audio (either this or --input)" } },
      { flag: "external-task-id", path: "external_task_id", kind: "value", valueType: "string", desc: { zh: "自定义任务 ID（账号内唯一）", en: "Custom task ID (unique per account)" } },
    ],
    buildCreate: (o) => (o.input ? { voice_url: encodeResourceMedia(o.input, "raw") } : {}),
    buildDelete: (id) => ({ voice_id: id }),
    require: (body) => {
      if (!str(body["voice_name"])) throw new Error(t("gen.resource.needParam", { field: "voice-name" }));
      const hasUrl = Boolean(body["voice_url"]);
      const hasVideo = Boolean(body["video_id"]);
      if (!hasUrl && !hasVideo) throw new Error(t("gen.resource.needVoiceMedia"));
      if (hasUrl && hasVideo) throw new Error(t("gen.resource.voiceMediaExclusive"));
    },
  },
};

/**
 * 资源创建 / 查询的终态输出：成功打印资源信息，失败抛错；未到终态返回 false。
 */
function resourceOutcome(res: KlingResource, taskId: string, raw: Obj): boolean {
  const state = normalizeState(pick(raw, "data.task_status"));
  if (state === "failed") {
    const reason = str(pick(raw, "data.task_status_msg"));
    throw new Error(t("gen.resource.failed", { reason: reason ?? JSON.stringify(raw).slice(0, 500) }));
  }
  if (state !== "succeeded") return false;
  const meta = extractResource(raw, res.resultPath, res.resultFields);
  if (emitJson({ TaskId: taskId, State: state, Meta: meta, Raw: raw })) return true;
  for (const [key, value] of Object.entries(meta)) console.log(`${key}: ${value}`);
  return true;
}

/** 创建资源（异步）：提交 → 轮询 data.task_status 到 succeed / failed */
async function resourceCreate(res: KlingResource, opts: ResourceOptions, globals: GlobalArgs): Promise<void> {
  // 覆盖关系：内置组装 + 专属 flag < --param < --body
  const flagParams: Obj = {};
  for (const p of res.createParams ?? []) {
    const raw = (opts as unknown as Obj)[kebabToCamel(p.flag)];
    if (raw !== undefined) setPath(flagParams, p.path, parseParamValue(p, String(raw)));
  }
  const body = layerBody(deepMerge(res.buildCreate(opts), flagParams), opts);
  res.require(body);
  if (opts.dryRun) {
    if (emitJson({ Method: "POST", Path: res.createPath, Body: body })) return;
    console.log(`POST ${res.createPath}`);
    console.log(redactLong(body));
    return;
  }
  const ctx = contextOf(opts, globals, undefined, "kling");
  let resp: Obj;
  try {
    setInterruptHint(t("gen.interruptedSubmit"));
    resp = await withRateLimitRetry(
      () => request(ctx, "POST", res.createPath, body, WIDE_REQUEST_MS),
      numberOpt(opts.retry, "--retry") ?? DEFAULT_RETRY,
      (info) => {
        if (!isJson()) console.error(t("gen.rateLimitRetry", info));
      },
    );
  } catch (err) {
    if (!isRequestTimeout(err) && !isNetworkError(err)) throw err;
    throw new Error(`${(err as Error).message}\n${t("gen.requestTimeoutUnknown", { cmd: retryCommand() })}`);
  } finally {
    interruptHint = null;
  }
  assertKling(resp, "creation");
  const taskId = str(pick(resp, "data.task_id"));
  if (!taskId) throw new Error(t("gen.resource.noTaskId"));
  if (opts.wait === false) {
    if (emitJson({ TaskId: taskId, Raw: resp })) return;
    console.log(t("gen.submitted", { id: taskId }));
    console.log(`  ${resourceQueryCmd(res, taskId)}`);
    return;
  }
  if (!isJson()) console.error(t("gen.submittedWaiting", { id: taskId }));
  const { interval, deadline, seconds } = pollTiming(opts);
  // Ctrl+C：创建任务已在云端跑，退出前把任务 ID 和重查命令留给用户
  setInterruptHint(t("gen.interruptedWait", { id: taskId, cmd: resourceQueryCmd(res, taskId) }));
  let last = "";
  let rateStreak = 0;
  try {
    for (;;) {
      if (Date.now() >= deadline) {
        throw new Error(t("gen.resource.timeout", { seconds, id: taskId, cmd: resourceQueryCmd(res, taskId) }));
      }
      let raw: Obj | undefined;
      try {
        raw = await request(ctx, "GET", res.queryPath(taskId), undefined, WIDE_REQUEST_MS);
        rateStreak = 0;
      } catch (err) {
        // 429 / 网络瞬断：跳过本轮继续等（--timeout 总超时兜底）；每连续 3 次提示一句
        if (isRateLimited(err) || isNetworkError(err)) {
          rateStreak++;
          if (rateStreak % 3 === 0 && !isJson()) console.error(t("gen.pollRateLimited", { n: rateStreak }));
        } else {
          throw queryTimeoutHint(err, resourceQueryCmd(res, taskId));
        }
      }
      if (raw) {
        assertKling(raw, "query");
        const state = normalizeState(pick(raw, "data.task_status"));
        if (state !== last && !isJson()) {
          console.error(t("gen.progress", { state }));
          last = state;
        }
        if (resourceOutcome(res, taskId, raw)) return;
      }
      await sleep(interval);
    }
  } finally {
    interruptHint = null;
  }
}

/** 查询创建任务（get 用任务 ID，不是资源 ID） */
async function resourceGet(res: KlingResource, opts: ResourceOptions, globals: GlobalArgs): Promise<void> {
  const ctx = contextOf(opts, globals, undefined, "kling");
  const taskId = opts.taskId!;
  let raw: Obj;
  try {
    raw = await request(ctx, "GET", res.queryPath(taskId), undefined, WIDE_REQUEST_MS);
  } catch (err) {
    throw queryTimeoutHint(err, resourceQueryCmd(res, taskId));
  }
  assertKling(raw, "query");
  if (resourceOutcome(res, taskId, raw)) return;
  const state = normalizeState(pick(raw, "data.task_status"));
  if (emitJson({ TaskId: taskId, State: state, Raw: raw })) return;
  console.log(t("gen.progress", { state }));
}

/** 删除资源（按资源 ID） */
async function resourceDelete(res: KlingResource, opts: ResourceOptions, globals: GlobalArgs): Promise<void> {
  const ctx = contextOf(opts, globals, undefined, "kling");
  // requiredOption 已保证非空；按 commander 解析出的 camelCase 属性取（--element-id → elementId）
  const id = opts[res.idKey]!;
  let raw: Obj;
  try {
    raw = await withRateLimitRetry(
      () => request(ctx, "POST", res.deletePath, res.buildDelete(id), WIDE_REQUEST_MS),
      numberOpt(opts.retry, "--retry") ?? DEFAULT_RETRY,
      (info) => {
        if (!isJson()) console.error(t("gen.rateLimitRetry", info));
      },
    );
  } catch (err) {
    if (!isRequestTimeout(err) && !isNetworkError(err)) throw err;
    // 重删已删的资源只会报「不存在」，无害
    throw new Error(`${(err as Error).message}\n${t("gen.requestTimeoutUnknown", { cmd: retryCommand() })}`);
  }
  assertKling(raw, "deletion");
  if (emitJson({ Deleted: id, Raw: raw })) return;
  console.log(t("gen.resource.deleted", { id }));
}

async function generate(apiId: string, opts: GenOptions, globals: GlobalArgs): Promise<void> {
  const api = requireApi(apiId);
  const family = api.family;
  // 覆盖关系：接口参数（含 --model）< --param < --body；任何字段（含 model）都可被后两者重新传
  const base: Obj = apiFlagValues(api, opts as unknown as Obj);
  const defaultModel = opts.model ?? (api.models.length === 1 ? api.models[0] : undefined);
  const body: Obj = layerBody(defaultModel ? { model: defaultModel, ...base } : base, opts);
  // model 以最终请求体为准：白名单校验、任务记录、轮询都用发出去的这个值
  const model = str(body["model"]);
  if (!model) {
    throw new Error(t("gen.needModel", { api: apiId, models: api.models.join(" | ") }));
  }
  if (!apiSupportsModel(api, model)) {
    throw new Error(t("gen.modelNotInApi", { model, api: apiId, models: api.models.join(" | ") }));
  }
  // 适用模型 / 必填 / 长度 / 接口规则，都在合并后的最终请求体上校验
  const bodyError = checkBody(api, body);
  if (bodyError) throw new Error(bodyError);
  const promptText = str(body["prompt"]) ?? str(body["text"]) ?? "";

  // --dry-run：只打印最终请求（接口 + 请求体），不发请求、不消耗 token。
  // 已走完请求体相关的本地校验（参数解析 / 文件编码 / 接口校验）；Key 与地域不检查。
  if (opts.dryRun) {
    if (emitJson({ Api: apiId, Method: "POST", Path: api.path, Body: body })) return;
    console.log(`POST ${api.path}`);
    console.log(redactLong(body));
    return;
  }

  const ctx = contextOf(opts, globals, model, family.vendor);
  if (api.sync && !isJson()) {
    // 同步接口一次请求即返回结果，但生图仍要等十几到几十秒；不打提示用户会以为卡住
    console.error(t("gen.generating"));
  }
  // 提交的超时：同步接口一次请求即结果，跟 --timeout；异步提交只是领任务号，
  // 用宽超时（小 --timeout 表示「最多等这么久拿结果」，不应把提交本身掐死）
  let resp: Obj;
  try {
    // Ctrl+C 指引：同步 = 结果丢弃可重跑；异步提交段 = 结果未知（提交成功后 poll 会换成任务级指引）
    setInterruptHint(api.sync ? t("gen.interruptedSync", { cmd: retryCommand() }) : t("gen.interruptedSubmit"));
    // 429 退避重试：限流时提示走 stderr（--json 下静默，不污染 stdout）
    resp = await withRateLimitRetry(
      () => request(ctx, "POST", api.path, body, api.sync ? ctx.timeoutMs : WIDE_REQUEST_MS),
      numberOpt(opts.retry, "--retry") ?? DEFAULT_RETRY,
      (info) => {
        if (!isJson()) console.error(t("gen.rateLimitRetry", info));
      },
    );
    if (api.sync) {
      await finish(ctx, parseResponse(family, resp), resp, opts);
      return;
    }
  } catch (err) {
    if (!isRequestTimeout(err) && !isNetworkError(err)) throw err;
    // 超时 / 网络中断（均无回包）：同步 = 未提交，重试无副作用；异步 = 无法确认是否已创建——
    // 先查任务列表防重复提交（生成任务重复提交 = 重复扣费）
    const hint = api.sync
      ? t("gen.requestTimeoutRetry", { cmd: retryCommand() })
      : t("gen.requestTimeoutAsync", { tasks: "thcli +gen tasks", cmd: retryCommand() });
    throw new Error(`${(err as Error).message}\n${hint}`);
  } finally {
    // 同步整个流程（请求 + 下载）结束清指引；异步正常路径交给 poll 接管，异常路径一并清掉
    interruptHint = null;
  }
  const taskId = family.taskIdOf!(resp);
  if (!taskId) {
    // 厂商提交期错误：参数过了平台校验但厂商拒绝，或平台按厂商格式返回的鉴权 / 限流 / 参数错误，
    // HTTP 可能仍是 2xx（PixVerse ErrCode≠0、Kling code≠0、MiniMax base_resp.status_code≠0 等）
    const rejected = vendorFailure(ctx, t("gen.submitFailed", { api: apiId }), resp);
    if (rejected) throw rejected;
    // 部分厂商提交即失败时仍回 HTTP 200，失败原因在 body 里（如混元 3D 的
    // {"id":"","status":"failed","error":{"code":"ResourceInsufficient"}}）——先按失败解读
    const submitted = parseResponse(family, resp);
    if (submitted.state === "failed") {
      throw new Error(t("gen.failed", { reason: submitted.error ?? JSON.stringify(resp).slice(0, 500) }));
    }
    throw new Error(t("gen.noTaskId", { body: JSON.stringify(resp).slice(0, 1000) }));
  }
  // 先落本地记录再做别的：之后无论是 --no-wait、等待超时还是终端被关，都能用 +gen status 找回任务 ID
  recordSubmitted({
    taskId,
    api: apiId,
    model,
    kind: api.kind,
    prompt: promptText,
    createdAt: new Date().toISOString(),
    profile: ctx.profile,
    site: ctx.site,
    area: ctx.area,
  });
  if (opts.wait === false) {
    if (emitJson({ Api: apiId, TaskId: taskId, Model: model, Raw: resp })) return;
    console.log(t("gen.submitted", { id: taskId }));
    console.log(`  ${statusCommandOf(apiId, taskId)}`);
    return;
  }
  if (!isJson()) {
    console.error(t("gen.submittedWaiting", { id: taskId }));
  }
  const { result, raw } = await poll(ctx, family, apiId, model, taskId, opts);
  await finish(ctx, result, raw, opts, taskId);
}

/** +gen status 的参数 */
interface StatusOptions {
  model?: string;
  wait?: boolean;
  /** 同 --wait */
  result?: boolean;
  output?: string;
  timeout?: string;
  interval?: string;
  apiKey?: string;
  alias?: string;
  area?: string;
  verbose?: boolean;
}

/**
 * +gen status <api> <task-id>：查单个任务（--wait / --result 等到结束并输出结果）。
 * 接口 ID 给出族（查询/解析逻辑），--model 可从本机提交记录补全。
 * areaGiven：命令行显式给了 --area（否则沿用提交时的地域）。
 */
async function statusCommand(apiId: string, taskId: string, opts: StatusOptions, areaGiven: boolean, timingGiven: boolean, globals: GlobalArgs): Promise<void> {
  const api = requireApi(apiId);
  const family = api.family;
  if (api.sync) {
    throw new Error(t("gen.statusUnsupported", { api: apiId }));
  }
  // 本机提交过的任务有记录：--model 可省，账号 / 站点 / 地域也沿用提交时的（命令行显式给了则以命令行为准）
  const known = findTask(taskId);
  const model = opts.model ?? known?.model;
  if (!model) {
    // 无记录 = 不是本机提交的，或在本机记录功能加入之前提交的
    throw new Error(t("gen.status.needModel", { id: taskId }));
  }
  if (!apiSupportsModel(api, model)) {
    throw new Error(t("gen.modelNotInApi", { model, api: apiId, models: api.models.join(" | ") }));
  }
  const area = areaGiven ? opts.area : known?.area ?? opts.area;
  const ctx = contextOf({ ...opts, area }, known ? scopeOf(known, globals) : globals, model, family.vendor);
  if (ctx.profile !== resolveProfile(globals) || ctx.site !== resolveSite(globals)) {
    // 沿用了提交时的账号 / 站点，与当前默认不同：说一声，免得用户以为查错了号
    console.error(t("gen.status.scope", { profile: ctx.profile, site: ctx.site }));
  }
  if (opts.wait || opts.result) {
    const { result, raw } = await poll(ctx, family, apiId, model, taskId, opts);
    await finish(ctx, result, raw, opts, taskId);
    return;
  }
  // 显式给了 --timeout/--interval 却没 --wait：这两个参数只在等待模式下生效，
  // 静默忽略会让用户以为在等待（实际单次查询就返回了）——说一声
  if (timingGiven && !isJson()) {
    console.error(t("gen.status.timingNeedsWait"));
  }
  let raw: Obj;
  try {
    raw = await queryOnce(ctx, family.query!(model, taskId));
  } catch (err) {
    throw queryTimeoutHint(err, statusCommandOf(apiId, taskId));
  }
  const result = parseResponse(family, raw);
  if (result.state === "succeeded" || result.state === "failed") {
    await finish(ctx, result, raw, opts, taskId);
    return;
  }
  recordState(taskId, result.state, new Date());
  if (emitJson({ Api: apiId, TaskId: taskId, State: result.state, Raw: raw })) return;
  console.log(t("gen.progress", { state: result.state }));
}

/** +gen tasks 的参数 */
interface TasksOptions {
  limit?: string;
  refresh?: boolean;
  all?: boolean;
  alias?: string;
  verbose?: boolean;
}

const DEFAULT_TASKS_LIMIT = 20;
/**
 * tasks 表格各列宽度上限（提交时间 / 接口 / 模型 / 状态 / 任务 ID / 提示词 / 账号站点地域）：
 * 行宽固定（默认约 110 列，--all 约 125 列），超长的在本列内折行。
 * 任务 ID 折行不截断：常见 ID 是「前缀 + 32 位 hex」，32 列正好折成前缀一行、hex 一行；提示词最多 2 行。
 */
const TASK_COLUMNS: WrapColumn[] = [{}, { max: 18 }, { max: 16 }, {}, { max: 32 }, { max: 12, maxLines: 2 }, { max: 14 }];

/** 任务对应的接口：记录里有就用记录的，早期记录按模型找第一个异步接口（同一模型在各接口的查询方式一致） */
function apiForTask(task: GenTask): ApiRef | undefined {
  const recorded = task.api ? apiOf(task.api) : undefined;
  if (recorded) return recorded;
  return APIS.find((e) => !e.sync && e.models.includes(task.model));
}

/** ISO 时间 → 本地 YYYY-MM-DD HH:mm */
function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * +gen tasks：列出本机提交过的异步任务（~/.thcli/gen-tasks.jsonl），不用记任务 ID。
 * 默认先向平台刷新未完成任务的状态（只查询，不提交、不消耗 token）；用各任务提交时的账号 / 站点 / 地域查。
 */
async function tasksCommand(opts: TasksOptions, globals: GlobalArgs): Promise<void> {
  const limit = opts.limit === undefined ? DEFAULT_TASKS_LIMIT : Number(opts.limit);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(t("gen.tasks.badLimit", { value: opts.limit }));
  }
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  const tasks = loadTasks()
    .filter((x) => opts.all || (x.profile === profile && x.site === site))
    .slice(0, limit);
  if (!tasks.length) {
    if (emitJson([])) return;
    console.log(t("gen.tasks.none"));
    return;
  }
  const now = new Date();
  let failed = 0;
  if (opts.refresh !== false) {
    await forEachLimit(tasks.filter((x) => needsRefresh(x, now)), 4, async (task) => {
      const ep = apiForTask(task);
      if (!ep?.family.query) return;
      try {
        const ctx = contextOf({ area: task.area, alias: opts.alias, verbose: opts.verbose }, scopeOf(task, globals), task.model, ep.family.vendor);
        const result = parseResponse(ep.family, await queryOnce(ctx, ep.family.query(task.model, task.taskId)));
        recordState(task.taskId, result.state, new Date());
        task.state = result.state;
      } catch {
        // 没有该账号 / 地域的 Key、网络失败等：保留上次记录的状态，汇总提示一次
        failed++;
      }
    });
  }
  const rows = tasks.map((x) => ({ task: x, api: apiForTask(x)?.id ?? "-" }));
  if (
    emitJson(
      rows.map(({ task, api }) => ({
        TaskId: task.taskId,
        Api: api,
        Model: task.model,
        Kind: task.kind,
        State: task.state,
        Prompt: task.prompt,
        CreatedAt: task.createdAt,
        UpdatedAt: task.updatedAt,
        Profile: task.profile,
        Site: task.site,
        Area: task.area,
        Saved: task.saved ?? [],
      })),
    )
  ) {
    return;
  }
  const headers = [t("gen.tasks.col.time"), t("gen.col.api"), t("gen.tasks.col.model"), t("gen.tasks.col.state"), t("gen.tasks.col.id"), t("gen.tasks.col.prompt")];
  printWrappedTable(
    opts.all ? [...headers, t("gen.tasks.col.scope")] : headers,
    rows.map(({ task, api }) => {
      const row = [localTime(task.createdAt), api, task.model, task.state, task.taskId, task.prompt.replace(/\s+/g, " ")];
      return opts.all ? [...row, `${task.profile}/${task.site}/${task.area}`] : row;
    }),
    TASK_COLUMNS,
  );
  console.log("");
  if (failed) console.log(t("gen.tasks.refreshFailed", { count: failed }));
  if (tasks.some((x) => x.state !== "succeeded" && x.state !== "failed" && !needsRefresh(x, now))) {
    console.log(t("gen.tasks.stale"));
  }
  console.log(t("gen.tasks.footer"));
}

/** 调用方式：同步（提交即返回结果）/ 异步（默认等完成，--no-wait 只提交） */
function modeText(api: ApiRef): string {
  return api.sync ? t("gen.mode.syncDetail") : t("gen.mode.asyncDetail");
}

/** 异步接口的查询命令（接口 ID 已填好） */
function statusUsage(api: ApiRef): string {
  return `thcli +gen status ${api.id} <${t("gen.status.idPlaceholder")}> [--wait] [--output <dir>]`;
}

/** --model 的说明行 */
function modelLine(api: ApiRef): { usage: string; desc: string } {
  return {
    usage: `--model <${api.models.join("|")}>`,
    desc: api.models.length === 1 ? t("gen.detail.modelOptional") : t("gen.detail.modelRequired"),
  };
}

/** 运行时选项，无缩进（--timeout 同步 / 异步都有效：同步=单次请求最长等待，异步=轮询总超时） */
function runtimeFlags(api: ApiRef): string[] {
  const rows: Array<[string, string]> = [
    ["--param <key=value|key:=json>", t("gen.opt.param")],
    ["--body <json|@file>", t("gen.opt.body")],
    ["--output <dir>", t("gen.opt.output")],
    ["--timeout <sec>", t("gen.opt.timeout", { default: DEFAULT_TIMEOUT_SEC })],
    ["--retry <n>", t("gen.opt.retry", { default: DEFAULT_RETRY })],
    ...(api.sync
      ? []
      : ([
          ["--no-wait", t("gen.opt.noWait")],
          ["--interval <sec>", t("gen.opt.interval", { default: DEFAULT_INTERVAL_SEC })],
        ] as Array<[string, string]>)),
    ["--dry-run", t("gen.opt.dryRun")],
    ["--api-key / --alias / --area / --verbose", t("gen.detail.ctxOptions")],
  ];
  const width = Math.max(...rows.map(([flag]) => flag.length)) + 2;
  return rows.map(([flag, desc]) => `${flag.padEnd(width)}${desc}`);
}

/** 单个接口的 JSON 说明（models <接口ID> --json） */
function apiJson(api: ApiRef): Obj {
  const model = modelLine(api);
  return {
    Api: api.id,
    Path: api.path,
    Kind: api.kind,
    Models: api.models,
    Sync: api.sync,
    Params: [
      { Flag: "--model", Field: "model", Kind: "value", Required: api.models.length > 1, Desc: model.desc },
      ...api.params.map((p) => ({
        Flag: `--${p.flag}`,
        Field: p.path,
        Kind: p.kind,
        Required: p.required ?? false,
        Models: p.models,
        Usage: paramUsage(p),
        Desc: paramText(p.desc),
        Default: p.default,
      })),
    ],
    Runtime: runtimeFlags(api),
    Doc: docsOf(api.doc),
  };
}

/** 族的官方文档链接：string | string[] 归一成数组（展示与 JSON 输出一致） */
function docsOf(doc: string | string[]): string[] {
  return Array.isArray(doc) ? doc : [doc];
}

function modelsCommand(opts: { api?: string }): void {
  if (opts.api) {
    const api = requireApi(opts.api);
    if (!emitJson(apiJson(api))) printApiBlock(api);
    return;
  }
  if (
    emitJson(
      APIS.map((e) => ({
        Api: e.id,
        Path: e.path,
        Kind: e.kind,
        Models: e.models,
        Sync: e.sync,
        Params: e.params.map((p) => `--${p.flag}`),
        Doc: docsOf(e.doc),
      })),
    )
  ) {
    return;
  }
  printTable(
    [t("gen.col.api"), t("gen.col.kind"), t("gen.col.models"), t("gen.col.mode"), t("gen.col.params")],
    APIS.map((e) => [e.id, e.kind, e.models.join(","), e.sync ? t("gen.mode.sync") : t("gen.mode.async"), String(e.params.length + 1)]),
  );
  console.log("");
  console.log(t("gen.apis.detailHint"));
  console.log(t("gen.apis.footer"));
}

/** 数据面请求共用的上下文选项（Key / 地域 / 日志） */
function withContextOptions(cmd: Command): Command {
  return cmd
    .option("--api-key <key>", t("chat.opt.apiKey"))
    .option("--alias <alias>", t("opt.aliasPick"), DEFAULT_ALIAS)
    .option("--area <area>", t("opt.areaChat"), DEFAULT_REGION)
    .option("--verbose", t("gen.opt.verbose"));
}

/** 提交类命令（+gen <接口> 与 resource create）共用的选项；resource create 没有结果文件，不挂 --output */
function withCommonOptions(cmd: Command, { omitOutput = false } = {}): Command {
  let out = cmd
    .option("--param <key=value|key:=json>", t("gen.opt.param"), collect)
    .option("--body <json|@file>", t("gen.opt.body"))
    .option("--dry-run", t("gen.opt.dryRun"))
    .option("--no-wait", t("gen.opt.noWait"));
  if (!omitOutput) out = out.option("--output <dir>", t("gen.opt.output"));
  return withContextOptions(
    out
      .option("--timeout <sec>", t("gen.opt.timeout", { default: DEFAULT_TIMEOUT_SEC }))
      .option("--interval <sec>", t("gen.opt.interval", { default: DEFAULT_INTERVAL_SEC }))
      .option("--retry <n>", t("gen.opt.retry", { default: DEFAULT_RETRY })),
  );
}

/** 打印某个接口的用法与完整参数说明（<接口ID> --help 与 models <接口ID> 共用） */
function printApiBlock(api: ApiRef): void {
  const lines: string[] = [];
  // 用法行：接口 ID + 必填字段（多模型接口含 --model），其余字段见下方参数清单
  const required = [
    ...(api.models.length > 1 ? ["--model <model>"] : []),
    ...api.params.filter((p) => p.required === true).map((p) => paramUsage(p)),
  ];
  lines.push(t("gen.help.apiUsage", { api: api.id, required: required.length ? `${required.join(" ")} ` : "" }));
  lines.push("");
  lines.push(`${api.id}:`);
  lines.push(`  ${t("gen.detail.path")} ${api.path}`);
  lines.push(`  ${t("gen.col.models")} ${api.models.join(" | ")}`);
  lines.push(`  ${t("gen.col.mode")} ${modeText(api)}`);
  if (!api.sync) lines.push(`  ${t("gen.detail.query")} ${statusUsage(api)}`);
  if (api.modelNote) lines.push(`  ${t("gen.detail.modelNote")} ${paramText(api.modelNote)}`);
  lines.push(`  ${t("gen.detail.params")}`);
  const model = modelLine(api);
  lines.push(`    ${model.usage}`);
  lines.push(`      ${model.desc}`);
  for (const p of api.params) {
    lines.push(`    ${paramUsage(p)}`);
    for (const line of paramHelpText(p).split("\n")) {
      lines.push(`      ${line}`);
    }
  }
  if (api.requestNote) {
    lines.push(`  ${t("gen.detail.requestNote")}`);
    for (const line of paramText(api.requestNote).split("\n")) {
      lines.push(`      ${line}`);
    }
  }
  lines.push(`  ${t("gen.detail.runtime")}`);
  for (const line of runtimeFlags(api)) {
    lines.push(`    ${line}`);
  }
  lines.push(`  ${t("gen.detail.doc")}`);
  for (const d of docsOf(api.doc)) {
    lines.push(`    ${d}`);
  }
  lines.push("", t("gen.detail.paramHint"));
  console.log(lines.join("\n"));
  console.log("");
}

/** +gen 的子命令名（不是接口 ID） */
const GEN_SUBCOMMANDS = new Set(["status", "tasks", "apis", "resource", "help"]);

/**
 * 接口字段 flag 按接口动态挂载：解析前从 argv 里取 +gen 后的第一个位置参数，只挂该接口的字段。
 * 这样 commander 能对未知 flag 报错，且不同接口的同名字段（如 --images）各自独立。
 * 返回 unknown：位置参数既不是接口也不是子命令（多半是接口 ID 写错）。
 */
function apiFromArgv(argv: string[]): ApiRef | "unknown" | undefined {
  const at = argv.indexOf("+gen");
  const token = at < 0 ? undefined : argv.slice(at + 1).find((x) => !x.startsWith("-"));
  if (!token || GEN_SUBCOMMANDS.has(token)) return undefined;
  return apiOf(token) ?? "unknown";
}

/** 装配 +gen */
export function registerGenCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const gen = program.command("+gen").description(t("group.gen.desc"));

  // 主命令：接口 ID 是位置参数，参数集合跟接口走。
  // commander 处理 --help 时不会收集位置参数，所以关掉默认 help 改自定义：--help 才能按接口输出参数详细说明。
  const cmd = gen
    .helpOption(false)
    .argument("[api]", t("gen.arg.api"))
    .option("--help", t("gen.opt.help"))
    .option("--model <model>", t("gen.opt.model", { cmd: "thcli +gen apis" }));
  // 接口字段：--<字段名>（下划线换连字符），只挂当前接口的；任意字段都可再用 --param / --body 覆盖
  const argvApi = apiFromArgv(process.argv.slice(2));
  if (argvApi === "unknown") {
    // 接口 ID 写错时不挂字段 flag：放行未知选项，由 action 报「未知接口」
    cmd.allowUnknownOption();
  } else {
    for (const p of argvApi?.params ?? []) {
      cmd.option(paramFlagSyntax(p), paramText(p.desc));
    }
  }
  withCommonOptions(cmd).action(async (api: string | undefined, opts: GenOptions & { help?: boolean }) => {
    if (opts.help) {
      // 带接口：只输出该接口的用法与参数；不带接口（或接口未知）才输出 +gen 总体用法
      const ep = api ? apiOf(api) : undefined;
      if (ep) {
        printApiBlock(ep);
        return;
      }
      if (api) console.error(t("gen.unknownApi", { api, cmd: "thcli +gen apis" }));
      console.log(t("gen.help.text", { timeout: DEFAULT_TIMEOUT_SEC }));
      return;
    }
    if (!api) {
      throw new Error(t("gen.needApi", { cmd: "thcli +gen apis" }));
    }
    await generate(api, opts, getGlobals());
  });

  // status 只查不提交：不挂 --param / --body / --dry-run / --no-wait；--output / --timeout / --interval 配合 --wait 使用
  withContextOptions(
    gen
      .command("status")
      .helpOption(true)
      .description(t("gen.status.desc"))
      .argument("<api>", t("gen.arg.api"))
      .argument("<task-id>", t("gen.status.arg.taskId"))
      .option("--model <model>", t("gen.status.opt.model"))
      .option("--wait", t("gen.status.opt.wait"))
      .option("--result", t("gen.status.opt.result"))
      .option("--output <dir>", t("gen.opt.output"))
      .option("--timeout <sec>", t("gen.opt.timeout", { default: DEFAULT_TIMEOUT_SEC }))
      .option("--interval <sec>", t("gen.opt.interval", { default: DEFAULT_INTERVAL_SEC })),
  ).action(async (api: string, taskId: string, opts: StatusOptions, command: Command) =>
    statusCommand(
      api,
      taskId,
      opts,
      command.getOptionValueSource("area") === "cli",
      command.getOptionValueSource("timeout") === "cli" || command.getOptionValueSource("interval") === "cli",
      getGlobals(),
    ),
  );

  gen
    .command("tasks")
    .helpOption(true)
    .description(t("gen.tasks.desc"))
    .option("--limit <n>", t("gen.tasks.opt.limit", { default: DEFAULT_TASKS_LIMIT }))
    .option("--no-refresh", t("gen.tasks.opt.noRefresh"))
    .option("--all", t("gen.tasks.opt.all"))
    .option("--alias <alias>", t("opt.aliasPick"), DEFAULT_ALIAS)
    .option("--verbose", t("gen.opt.verbose"))
    .action(async (opts: TasksOptions) => tasksCommand(opts, getGlobals()));

  gen
    .command("apis")
    .helpOption(true)
    .description(t("gen.apis.desc"))
    .argument("[api]", t("gen.apis.arg.api"))
    .action((api: string | undefined) => modelsCommand({ api }));

  const resource = gen.command("resource").helpOption(true).description(t("gen.resource.desc"));
  for (const [name, res] of Object.entries(KLING_RESOURCES)) {
    const sub = resource.command(name).description(t(`gen.resource.${name}.desc`));
    const create = sub.command("create").description(t("gen.resource.create.desc"));
    if (res.createMedia === "image") {
      create
        .option("--images <path|url>", t("gen.resource.opt.image"), collect)
        .option("--ref-video <url>", t("gen.resource.opt.refVideo"));
    } else {
      create.option("--input <path|url>", t("gen.resource.opt.input"));
    }
    for (const p of res.createParams ?? []) {
      create.option(paramFlagSyntax(p), paramHelpText(p));
    }
    withCommonOptions(create, { omitOutput: true }).action(async (opts: ResourceOptions) => resourceCreate(res, opts, getGlobals()));
    withContextOptions(
      sub
        .command("get")
        .description(t("gen.resource.get.desc"))
        .requiredOption("--task-id <id>", t("gen.resource.opt.taskId")),
    ).action(async (opts: ResourceOptions) => resourceGet(res, opts, getGlobals()));
    withContextOptions(
      sub
        .command("delete")
        .description(t("gen.resource.delete.desc"))
        .requiredOption(`--${res.idLabel} <id>`, t("gen.resource.opt.resourceId", { id: res.idLabel }))
        .option("--retry <n>", t("gen.opt.retry", { default: DEFAULT_RETRY })),
    ).action(async (opts: ResourceOptions) => resourceDelete(res, opts, getGlobals()));
  }
}
