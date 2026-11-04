/**
 * 生图 / 生视频 / 生 3D / 语音的接口注册表（数据面，Bearer API Key）。
 *
 * 组织方式：thcli +gen <接口> --<字段>。每个接口的参数集合以官方调用指南
 * （tools/文档参数表.xlsx、tools/actions）为准：请求体顶层字段 = 一个 flag，
 * flag 名即字段名（下划线换连字符）；数组传 JSON 数组、对象传 JSON 对象。
 * 没有公共参数、没有自动组装：CLI 写什么字段，请求体里就是什么字段。
 * 任意字段（含已收录的）都可用 --param key=value / key:=json 或 --body 覆盖；覆盖关系：接口参数 < --param < --body。
 *
 * 纯函数：不发请求、不读写文件（本地文件编码由命令层按 ParamSpec.media 处理）。
 */

import { UNSAFE_KEYS } from "./config.js";
import { lang, t } from "./i18n.js";
import type { VendorId } from "./gen-errors.js";

/** 生成类别 */
export type MediaKind = "image" | "video" | "3d" | "audio";

/** 归一化后的任务状态 */
export type TaskState = "queued" | "running" | "succeeded" | "failed";

/**
 * 本地文件的编码方式（字段值是本地路径时生效；URL / Base64 原样传）：
 *   dataUrl  data:<mime>;base64,...
 *   raw      裸 Base64，不带 data: 前缀
 *   urlOnly  只收公网 URL，本地文件直接拦截
 */
type MediaEncoding = "dataUrl" | "raw" | "urlOnly";

/** 查询请求：GET 路径，或 POST 路径 + 体 */
export interface QuerySpec {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

/** 归一化后的任务结果 */
export interface TaskResult {
  state: TaskState;
  urls: string[];
  /** 3D 的预览图等附属地址 */
  extraUrls: string[];
  /** 文本结果（如语音转写正文；--output 时落盘 .txt） */
  texts?: string[];
  /** 附带元数据（如克隆/设计音色返回的 voice_id） */
  meta?: Record<string, string>;
  error?: string;
}

/** 内联双语文案（帮助文本就近维护，随当前语言取值） */
type ParamText = { zh: string; en: string };

/** 对象 / 数组参数里的一个子字段（help 属性树与校验） */
export interface ParamField {
  /** 字段名（请求体里的键） */
  key: string;
  /** object / array / json 不逐层校验类型，object / array 声明了 fields 时在 help 里展开结构 */
  type: "string" | "number" | "integer" | "boolean" | "json" | "object" | "array";
  desc: ParamText;
  required?: boolean;
  choices?: readonly (string | number)[];
  min?: number;
  max?: number;
  /** 嵌套结构的子字段（如 content[].image_url{url}） */
  fields?: ParamField[];
  /** 适用模型（缺省 = 接口全部模型）；仅对 object 参数的直接子字段生效（如 Kling settings.multi_shot 仅 V3） */
  models?: string[];
}

/** 字段值里的本地文件编码规则 */
export interface MediaSpec {
  /** image：按族的格式 / 大小约束编码图片（视频文件只收 URL）；media：音频 / 视频；
   *  auto：图片或视频均可，按文件扩展名分派——图片走族的 formats/sizeLimit，音视频走本规则的 formats/maxBytes
   *  （如 Kling omni 的 contents[].url 同时承载首尾帧图与 feature/base 视频） */
  type: "image" | "media" | "auto";
  encoding: MediaEncoding;
  /** 对象 / 对象数组里承载文件的子路径（点路径，数组自动逐项展开）；缺省 = 值本身（字符串或字符串数组） */
  keys?: string[];
  /** 音视频本地文件的扩展名白名单（不带点，如 mp3）；缺省 = 全部已知音视频格式。图片用族的 formats */
  formats?: string[];
  /** 音视频本地文件的原始字节上限；缺省不限。图片用族的 sizeLimit */
  maxBytes?: number;
}

/** 接口参数：请求体的一个顶层字段 */
export interface ParamSpec {
  /** flag 名：字段名下划线换连字符（--negative-prompt） */
  flag: string;
  /** 请求体字段名（negative_prompt） */
  path: string;
  /** value=单值；object=JSON 对象；array=JSON 数组 */
  kind: "value" | "object" | "array";
  /** value 的取值类型；缺省按 JSON 智能解析（数字 / 布尔 / 字符串） */
  valueType?: "string" | "number" | "boolean";
  /** value 的枚举 */
  choices?: readonly (string | number)[];
  desc: ParamText;
  /** object 的子字段 / array 的元素对象字段 */
  fields?: ParamField[];
  /** 必填：true = 所有模型；模型列表 = 仅这些模型必填 */
  required?: boolean | string[];
  /** 适用模型（缺省 = 接口全部模型）；其它模型传了在本地报错 */
  models?: string[];
  /** 字段值可以是本地文件时的编码规则；数组 = 不同子路径不同规则（如 vidu subjects：images 可本地、videos 仅 URL） */
  media?: MediaSpec | MediaSpec[];
  /** flag 未传时仍写入请求体的默认值（如 minimax 音频的 output_format=url：hex 内联 base64，长音频会超响应体上限被上游拒）。全模型统一且不得与 models 同用；未来需按模型分派时，改为 model→value 并把注入挪到最终 model 确定之后 */
  default?: string | number | boolean;
}

type Obj = Record<string, unknown>;

/** 一个模型族：同一厂商同一任务体系（共享查询 / 结果解析） */
export interface FamilySpec {
  /** 族标识 */
  id: string;
  kind: MediaKind;
  /** 该族包含的模型 ID（精确匹配） */
  models: string[];
  /** 同步族：提交即返回结果，不轮询 */
  sync: boolean;
  /** 本地图片的原始字节上限（十进制）；缺省不限（与网关请求体上限对齐） */
  sizeLimit?: number;
  /** 本地图片允许的格式（MIME 子类型，如 jpeg/png）；缺省不限 */
  formats?: string[];
  /** prompt / text 的长度上限（code point 数，族内模型取最大者）；缺省不校验 */
  maxPromptChars?: number;
  /** 单接口族的参数集合 */
  params?: ParamSpec[];
  /** 多接口族：接口名 → 接口参数集合与校验 */
  apis?: Record<string, ApiSpec>;
  /** 官方调用指南；族对应多份文档时全部列出（如语音识别的 Hy / WAND 同步 + 异步） */
  doc: string | string[];
  /** 请求体结构 / 协议说明（help 展示） */
  requestNote?: ParamText;
  /** 模型厂商：按其错误格式与错误码表解析失败原因（《厂商错误码说明》）；平台自研模型不填 */
  vendor?: VendorId;
  /** 请求体最终合并后（含 --param/--body）的族级校验；返回错误文案 */
  validateBody?(body: Obj): string | undefined;
  /** 从提交响应里取任务 ID（同步族不用） */
  taskIdOf?(resp: Obj): string | undefined;
  query?(model: string, taskId: string): QuerySpec;
  /** 从提交（同步）或查询（异步）响应里归一化结果 */
  parse(resp: Obj): TaskResult;
}

/** 多接口族里的一个接口 */
interface ApiSpec {
  /** 官方支持该接口的模型白名单（缺省 = 族内全部模型） */
  models?: string[];
  params: ParamSpec[];
  validateBody?(body: Obj): string | undefined;
}

// ---------------------------------------------------------------- 取值工具

/** 按点路径取值：pick(resp, "data.task_id") */
export function pick(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Obj)[key];
  }
  return cur;
}

export function str(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/** 依次尝试多个路径，取第一个非空字符串 */
function firstStr(obj: unknown, ...paths: string[]): string | undefined {
  for (const p of paths) {
    const v = str(pick(obj, p));
    if (v) return v;
  }
  return undefined;
}

/** 从数组里收集某字段的 URL */
function urlsOf(list: unknown, field = "url"): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((x) => str((x as Obj)?.[field])).filter((u): u is string => Boolean(u));
}

/** 错误信息：OpenAI 风格 error.message、厂商的 message / ErrMsg / task_status_msg */
function errorOf(resp: unknown): string | undefined {
  const message = firstStr(resp, "error.message", "task.error.message", "task_status_msg", "failed_reason", "ErrMsg", "base_resp.status_msg", "message");
  const code = firstStr(resp, "error.code", "task.error.code");
  // 码与信息都给：信息是给人看的（如「资源不足。」），码便于对照厂商错误码文档。
  // 裸 message 放最低优先级兜底：Kling 视频族把失败原因写在 data[].message（文档 1323 行），族解析传的是 data[0]。
  return code && message ? `${message} (${code})` : message ?? code;
}

/**
 * 状态值归一化。厂商枚举五花八门（succeed / success / Success / completed / 1 …），
 * 用一张映射表收口；表外值一律按 running 处理——宁可多轮询几次，也不误报成功/失败。
 * 例外：unknown（Hy 世界模型，任务异常态）按失败处理，避免一直轮询到超时。
 */
const STATE_MAP: Record<string, TaskState> = {
  queued: "queued",
  queueing: "queued",
  created: "queued",
  submitted: "queued",
  pending: "queued",
  preparing: "running",
  running: "running",
  processing: "running",
  in_progress: "running",
  succeeded: "succeeded",
  succeed: "succeeded",
  success: "succeeded",
  completed: "succeeded",
  failed: "failed",
  fail: "failed",
  cancelled: "failed",
  incomplete: "failed",
  unknown: "failed",
};

export function normalizeState(raw: unknown): TaskState {
  return STATE_MAP[String(raw ?? "").trim().toLowerCase()] ?? "running";
}

function result(state: TaskState, urls: string[], resp: unknown, extraUrls: string[] = []): TaskResult {
  return { state, urls, extraUrls, error: state === "failed" ? errorOf(resp) : undefined };
}

/**
 * 解析提交 / 查询响应，并兜底平台错误信封。
 * 网关有时回 HTTP 200 但响应体是 {"error":{"code":"server_error","message":"ok"}}（实测：Kling 生图查询），
 * 族的 parse 找不到状态字段会按 running 处理，导致一直轮询到超时、任务列表永远显示 running。
 * 解析结果未到终态、且带非空错误信封时，按失败处理。
 */
export function parseResponse(family: FamilySpec, resp: Obj): TaskResult {
  const parsed = family.parse(resp);
  if (parsed.state === "succeeded" || parsed.state === "failed") return parsed;
  const error = resp["error"];
  if (!error || typeof error !== "object" || Array.isArray(error)) return parsed;
  const code = str((error as Obj)["code"]);
  if (code === "0") return parsed;
  if (!code && !str((error as Obj)["message"])) return parsed;
  const type = str((error as Obj)["type"]);
  const reason = errorOf(resp);
  return { state: "failed", urls: [], extraUrls: [], error: type && reason ? `${reason} [${type}]` : reason ?? type };
}

/** 同步族：有结果即成功，带 error 即失败 */
function syncResult(urls: string[], resp: unknown): TaskResult {
  if (urls.length) return result("succeeded", urls, resp);
  return { state: "failed", urls: [], extraUrls: [], error: errorOf(resp) ?? t("gen.result.noUrl") };
}

/**
 * seedream 的结果提取：url 形式优先；response_format=b64_json 时结果在 data[].b64_json
 * （文档 110 行），按 data[].output_format（缺省 png）拼成 data URL，下载层按 MIME 落盘。
 */
function b64UrlsOf(data: unknown): string[] {
  const urls = urlsOf(data);
  if (urls.length || !Array.isArray(data)) return urls;
  const out: string[] = [];
  for (const item of data as Obj[]) {
    const b64 = str(item["b64_json"]);
    if (!b64) continue;
    const fmt = str(item["output_format"]) ?? "png";
    out.push(`data:${fmt === "jpg" || fmt === "jpeg" ? "image/jpeg" : `image/${fmt}`};base64,${b64}`);
  }
  return out;
}

/** 有值即「传了」（空串 / 空数组按未传） */
function has(body: Obj, key: string): boolean {
  const v = body[key];
  if (v === undefined || v === null || v === "") return false;
  return !(Array.isArray(v) && v.length === 0);
}

/** 字段组恰好传一个；返回错误文案 */
function exactlyOne(body: Obj, keys: string[], what: string): string | undefined {
  const n = keys.filter((k) => has(body, k)).length;
  if (n === 1) return undefined;
  const flags = keys.map((k) => `--${k.replace(/_/g, "-")}`).join(" / ");
  return t(n === 0 ? "gen.check.needOne" : "gen.check.onlyOne", { what, flags });
}

// ---------------------------------------------------------------- 参数声明工具

const kebab = (path: string): string => path.replace(/_/g, "-");
const T = (zh: string, en: string): ParamText => ({ zh, en });
type Extra = Partial<Omit<ParamSpec, "flag" | "path" | "kind" | "desc">>;
const spec = (path: string, kind: ParamSpec["kind"], desc: ParamText, extra: Extra = {}): ParamSpec => ({
  flag: kebab(path),
  path,
  kind,
  desc,
  ...extra,
});
/** 字符串字段 */
const S = (path: string, desc: ParamText, extra: Extra = {}) => spec(path, "value", desc, { valueType: "string", ...extra });
/** 数字字段 */
const N = (path: string, desc: ParamText, extra: Extra = {}) => spec(path, "value", desc, { valueType: "number", ...extra });
/** 布尔字段 */
const B = (path: string, desc: ParamText, extra: Extra = {}) => spec(path, "value", desc, { valueType: "boolean", ...extra });
/** 智能标量（数字或字符串，如 series_amount 的 2~9 / auto） */
const J = (path: string, desc: ParamText, extra: Extra = {}) => spec(path, "value", desc, extra);
/** 数组字段 */
const A = (path: string, desc: ParamText, extra: Extra = {}) => spec(path, "array", desc, extra);
/** 对象字段 */
const O = (path: string, desc: ParamText, fields: ParamField[], extra: Extra = {}) => spec(path, "object", desc, { fields, ...extra });
/** 子字段 */
const F = (key: string, type: ParamField["type"], desc: ParamText, extra: Partial<Omit<ParamField, "key" | "type" | "desc">> = {}): ParamField => ({
  key,
  type,
  desc,
  ...extra,
});

/** 本地文件编码规则 */
const IMG = (encoding: MediaEncoding, keys?: string[]): MediaSpec => ({ type: "image", encoding, keys });
const MEDIA = (encoding: MediaEncoding, keys?: string[], limits: { formats?: string[]; maxBytes?: number } = {}): MediaSpec => ({
  type: "media",
  encoding,
  keys,
  ...limits,
});
/** 图片或视频均可（按扩展名分派）：图片走族的 formats/sizeLimit，音视频走 limits 的 formats/maxBytes */
const AUTO = (encoding: MediaEncoding, keys?: string[], limits: { formats?: string[]; maxBytes?: number } = {}): MediaSpec => ({
  type: "auto",
  encoding,
  keys,
  ...limits,
});

/** 提示词（默认必填，extra.required 可覆盖） */
const PROMPT = (desc = T("提示词", "Prompt"), extra: Extra = {}) => S("prompt", desc, { required: true, ...extra });

// ---------------------------------------------------------------- 图像

const HY_IMAGE_V3: FamilySpec = {
  id: "hy-image-v3",
  maxPromptChars: 8192,
  kind: "image",
  models: ["hy-image-v3"],
  sync: true,
  sizeLimit: 10_000_000,
  formats: ["jpeg", "png"],
  params: [
    PROMPT(T("生成图片的文本描述（≤8192 字符）", "Image description (<=8192 chars)")),
    A("images", T("参考图（0~3 张，URL 或本地文件；png/jpeg/jpg，≤10MB）", "Reference images (0~3; URL or local file; png/jpeg/jpg, <=10MB)"), { media: IMG("dataUrl") }),
    S("size", T("宽x高，宽高 [512,2048]，面积 ≤1024x1024", "WxH, sides [512,2048], area <= 1024x1024")),
    N("seed", T("随机种子 [1, 4294967295]（单图生效；0 或不传 = 随机）", "Random seed [1, 4294967295] (single image; 0/absent = random)")),
    S("footnote", T("水印内容，右下角，≤16 字符", "Watermark text, bottom-right, <=16 chars")),
    B("revise", T("是否改写提示词", "Rewrite the prompt")),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135745",
  validateBody: hyImageSizeCheck(512, 2048, 1_048_576, "1024x1024"),
  parse: (resp) => syncResult(urlsOf(resp["data"]), resp),
};

/** 混元生图 size 校验：WxH 格式 + 宽高范围 + 面积上限（v3 与 v3.5 约束不同，参数化；在 --param/--body 合并后执行，旁路也拦） */
function hyImageSizeCheck(minSide: number, maxSide: number, maxArea: number, areaLabel: string): (body: Obj) => string | undefined {
  return (body) => {
    const v = str(body["size"]);
    if (!v) return undefined;
    const m = /^(\d+)x(\d+)$/.exec(v);
    if (!m) return t("gen.check.sizeFormat", { value: v });
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w < minSide || w > maxSide || h < minSide || h > maxSide) {
      return t("gen.check.sizeSide", { value: v, min: minSide, max: maxSide });
    }
    if (w * h > maxArea) return t("gen.check.sizeArea", { value: v, max: areaLabel });
    return undefined;
  };
}

const HY_IMAGE_V35: FamilySpec = {
  id: "hy-image-v3.5",
  maxPromptChars: 8192,
  kind: "image",
  models: ["hy-image-v3.5-preview"],
  sync: true,
  sizeLimit: 20_000_000,
  formats: ["jpeg", "png"],
  params: [
    A("messages", T("多轮会话内容（时间从旧到新，最后一条 role=user 为本轮生图指令）", "Multi-turn messages (oldest first; the last role=user is this turn's instruction)"), {
      required: true,
      media: IMG("dataUrl", ["content.image_url.url"]),
      fields: [
        F("role", "string", T("角色", "Role"), { required: true, choices: ["user", "assistant", "tool"] }),
        F("content", "array", T("消息内容块", "Content blocks"), {
          fields: [
            F("type", "string", T("块类型", "Block type"), { required: true, choices: ["text", "image_url"] }),
            F("text", "string", T("文本（type=text）", "Text (type=text)")),
            F("image_url", "object", T("图片（type=image_url；url 可为本地文件）", "Image (type=image_url; url may be a local file)"), {
              fields: [F("url", "string", T("图片地址", "Image URL"))],
            }),
            F("is_generate", "boolean", T("是否为生成结果", "Whether it is a generated result")),
          ],
        }),
        F("reasoning", "string", T("思考内容（多轮回灌）", "Reasoning (multi-turn)")),
        F("tool_calls", "json", T("工具调用（多轮回灌）", "Tool calls (multi-turn)")),
        F("tool_call_id", "string", T("工具调用 ID（role=tool）", "Tool call ID (role=tool)")),
      ],
    }),
    S("size", T("宽x高，宽高 [256,8192]，面积 ≤16777216", "WxH, sides [256,8192], area <= 16777216")),
    N("seed", T("随机种子 [0, 2^63-1]（0 或不传 = 随机）", "Random seed [0, 2^63-1] (0/absent = random)")),
    N("generate_max_pixels", T("目标面积档位（1K/1.5K 默认/2K；非档位值服务端按最近面积归档；仅未传 size 时生效）", "Target area tier (1K/1.5K default/2K; non-tier values are snapped to the nearest tier server-side; only when size is absent)")),
    N("resize_max_pixels", T("参考图面积上限（像素数，超出等比缩放；默认 1048576）", "Reference image area cap (pixels; default 1048576)")),
    S("session", T("会话 ID（多轮编辑一致性调度）", "Session ID (consistent scheduling across turns)")),
    S("footnote", T("水印内容，右下角，≤16 字符", "Watermark text, bottom-right, <=16 chars")),
    O("use_search_tool", T("外部搜索增强（默认关闭）", "External search enhancement (off by default)"), [F("value", "boolean", T("开关", "On/off"))]),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135745",
  validateBody: hyImageSizeCheck(256, 8192, 16_777_216, "16777216"),
  requestNote: T(
    'Chat/Messages 协议，messages 为多轮会话（最后一条 role=user 是本轮指令）。示例：\n--messages \'[{"role":"user","content":[{"type":"text","text":"一只猫"},{"type":"image_url","image_url":{"url":"./ref.png"}}]}]\'\n多轮编辑：把上轮响应的 assembled_history 原样写进 --messages 再追加本轮 user 消息',
    'Chat/Messages protocol; messages is a multi-turn session (the last role=user is this turn). Example:\n--messages \'[{"role":"user","content":[{"type":"text","text":"a cat"},{"type":"image_url","image_url":{"url":"./ref.png"}}]}]\'\nMulti-turn edit: put the previous assembled_history into --messages and append this turn\'s user message',
  ),
  parse: (resp) => {
    const url = str(pick(resp, "choices.0.delta.image.url"));
    return syncResult(url ? [url] : [], resp);
  },
};

const SEEDREAM_PRO_FLASH = ["seedream-image-v5.0-pro", "seedream-image-v5.0-flash"];
const SEEDREAM_LITE = ["seedream-image-v5.0-lite"];

const SEEDREAM: FamilySpec = {
  id: "seedream",
  maxPromptChars: 600,
  kind: "image",
  models: ["seedream-image-v5.0-pro", "seedream-image-v5.0-lite", "seedream-image-v5.0-flash"],
  sync: true,
  sizeLimit: 30_000_000,
  formats: ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"],
  params: [
    PROMPT(T("文本提示词（≤600 字符，中文建议 ≤300 字）", "Prompt (<=600 chars)")),
    A("images", T("参考图（pro/flash ≤10 张、lite ≤14 张；URL 或本地文件）", "Reference images (pro/flash <=10, lite <=14; URL or local file)"), { media: IMG("dataUrl") }),
    S("size", T("尺寸档位或宽x高（pro/flash：1K/1.5K/2K；lite：2K/3K/4K）", "Size tier or WxH (pro/flash: 1K/1.5K/2K; lite: 2K/3K/4K)")),
    B("layer_decomposition", T("图层拆分（pro / flash）", "Layer decomposition (pro / flash)"), { models: SEEDREAM_PRO_FLASH }),
    O("optimize_prompt_options", T("提示词优化配置", "Prompt optimization options"), [
      F("mode", "string", T("优化模式（lite / flash 不支持 fast）", "Mode (fast is not supported by lite / flash)"), { choices: ["standard", "fast"] }),
    ]),
    S("output_format", T("输出格式", "Output format"), { choices: ["png", "jpeg"] }),
    S("background", T("透明通道", "Transparency"), { choices: ["transparent", "opaque"], models: SEEDREAM_PRO_FLASH }),
    S("response_format", T("返回方式", "Response format"), { choices: ["url", "b64_json"] }),
    S("sequential_image_generation", T("组图模式", "Series mode"), { choices: ["auto", "disabled"], models: SEEDREAM_LITE }),
    O("sequential_image_generation_options", T("组图配置（仅 sequential_image_generation=auto 时生效）", "Series options (only when sequential_image_generation=auto)"), [
      F("max_images", "integer", T("最多生成张数", "Max images"), { min: 1, max: 15 }),
    ], { models: SEEDREAM_LITE }),
    O("tools", T("工具配置", "Tool config"), [F("type", "string", T("工具类型", "Tool type"), { choices: ["web_search"] })], { models: SEEDREAM_LITE }),
    B("watermark", T("水印（右下角「AI 生成」）", 'Watermark ("AI generated" bottom-right)')),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/136609",
  parse: (resp) => syncResult(b64UrlsOf(resp["data"]), resp),
};

const WAND_IMAGE: FamilySpec = {
  id: "wand-image",
  maxPromptChars: 8192,
  kind: "image",
  models: ["wand-vega-image-lite", "wand-vega-image-flash", "wand-vega-image-pro", "wand-vega-image-1.5-pro"],
  sync: false,
  sizeLimit: 20_000_000,
  formats: ["png", "jpeg"],
  params: [
    PROMPT(T("文本提示词（≤8192 字符）", "Prompt (<=8192 chars)")),
    A("input", T("多模态输入（图生图 / 参考图，0~10 张，URL 或本地文件，单张 ≤20MB）", "Multimodal input (image-to-image / reference, 0-10 images, URL or local file, each <=20MB)"), {
      media: IMG("dataUrl", ["content.image_url"]),
      fields: [
        F("content", "array", T("输入块", "Input blocks"), {
          fields: [
            F("type", "string", T("块类型", "Block type"), { choices: ["input_image"] }),
            F("image_url", "string", T("图片地址（URL 或本地文件）", "Image (URL or local file)")),
          ],
        }),
      ],
    }),
    S("size", T("输出尺寸，宽x高", "Output size, WxH")),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/137203",
  taskIdOf: (resp) => firstStr(resp, "task_id", "id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/vega-images/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => result(normalizeState(resp["status"]), urlsOf(resp["data"]), resp),
};

const VIDU_IMAGE: FamilySpec = {
  id: "vidu-image",
  vendor: "vidu",
  maxPromptChars: 2000,
  kind: "image",
  models: ["vidu-image-q2"],
  sync: false,
  sizeLimit: 15_000_000,
  formats: ["jpeg", "png", "webp"],
  params: [
    PROMPT(T("文本提示词（≤2000 字符）", "Prompt (<=2000 chars)")),
    A("images", T("参考图（0~7 张，URL 或本地文件）", "Reference images (0~7; URL or local file)"), { media: IMG("dataUrl") }),
    S("aspect_ratio", T("宽高比（默认 16:9）", "Aspect ratio (default 16:9)"), { choices: ["16:9", "9:16", "1:1", "3:4", "4:3", "21:9", "2:3", "3:2", "auto"] }),
    S("resolution", T("分辨率（默认 1080p）", "Resolution (default 1080p)"), { choices: ["1080p", "2K", "4K"] }),
    N("seed", T("随机种子（0 或不传 = 随机）", "Random seed (0/absent = random)")),
    S("callback_url", T("任务状态回调地址（POST）", "Task state callback URL (POST)")),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135746",
  taskIdOf: (resp) => firstStr(resp, "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/vidu-image/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => result(normalizeState(resp["state"]), urlsOf(resp["creations"]), resp),
};

const KLING_IMAGE_SINGLE = ["kling-image-v3"];
const KLING_IMAGE_LIST = ["kling-image-o1", "kling-image-v3-omni"];

const KLING_IMAGE: FamilySpec = {
  id: "kling-image",
  vendor: "kling",
  maxPromptChars: 2500,
  kind: "image",
  models: ["kling-image-v3", "kling-image-o1", "kling-image-v3-omni"],
  sync: false,
  sizeLimit: 10_000_000,
  formats: ["jpeg", "png"],
  params: [
    PROMPT(T("正向提示词（≤2500 字符）", "Prompt (<=2500 chars)")),
    S("negative_prompt", T("负向提示词（≤2500 字符，仅文生图）", "Negative prompt (<=2500 chars; text-to-image only)"), { models: KLING_IMAGE_SINGLE }),
    S("image", T("参考图（单张，URL 或本地文件；传了即图生图）", "Reference image (single; URL or local file; makes it image-to-image)"), {
      models: KLING_IMAGE_SINGLE,
      media: IMG("raw"),
    }),
    A("image_list", T("参考图列表（最多 10 张，URL 或本地文件）", "Reference image list (up to 10; URL or local file)"), {
      models: KLING_IMAGE_LIST,
      media: IMG("raw"),
    }),
    A("element_list", T("主体参考列表（图片 + 主体 ≤ 10）", "Element references (images + elements <= 10)"), {
      fields: [F("element_id", "string", T("主体 ID（+gen resource kling-element create 产出）", "Element ID (from +gen resource kling-element create)"), { required: true })],
    }),
    S("aspect_ratio", T("宽高比（auto 仅 o1 / v3-omni 且传了 image_list）", "Aspect ratio (auto: o1 / v3-omni with image_list only)"), { choices: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9", "auto"] }),
    S("resolution", T("清晰度（默认 1k；4k 仅 v3-omni）", "Resolution (default 1k; 4k is v3-omni only)"), { choices: ["1k", "2k", "4k"] }),
    N("n", T("生成数量 [1, 9]（默认 1；result_type=series 时无效）", "Image count [1, 9] (default 1; ignored for series)")),
    O("watermark_info", T("水印结果开关", "Watermarked result switch"), [F("enabled", "boolean", T("是否同时生成含水印结果", "Also generate a watermarked result"))]),
    S("result_type", T("单图 / 组图（默认 single；series 仅 v3-omni）", "Single / series (default single; series is v3-omni only)"), {
      choices: ["single", "series"],
      models: KLING_IMAGE_LIST,
    }),
    J("series_amount", T("组图数量：2~9 或 auto（默认 4；仅 result_type=series 生效）", "Series amount: 2~9 or auto (default 4; only for result_type=series)"), {
      models: ["kling-image-v3-omni"],
    }),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/138803",
  validateBody: (body) => {
    const model = str(body["model"]) ?? "";
    if (has(body, "negative_prompt") && has(body, "image")) {
      return t("gen.rule.klingImage.negativePrompt");
    }
    if (body["aspect_ratio"] === "auto" && (model === "kling-image-v3" || !has(body, "image_list"))) {
      return t("gen.rule.klingImage.autoRatio");
    }
    if (body["resolution"] === "4k" && model !== "kling-image-v3-omni") return t("gen.rule.klingImage.res4k");
    if (body["result_type"] === "series" && model === "kling-image-o1") {
      return t("gen.rule.klingImage.series");
    }
    const amount = body["series_amount"];
    if (amount !== undefined && amount !== "auto") {
      const n = Number(amount);
      if (!Number.isInteger(n) || n < 2 || n > 9) return t("gen.rule.klingImage.seriesAmount");
    }
    return undefined;
  },
  taskIdOf: (resp) => firstStr(resp, "data.task_id", "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/kling-image/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    // 查询响应有时裹在 data 里，有时直接在顶层（文档两种示例都有）
    const body = (resp["data"] && typeof resp["data"] === "object" ? resp["data"] : resp) as Obj;
    // 单图在 task_result.images；组图（result_type=series）在 task_result.series_images（此时 images 为空数组）
    const urls = [...urlsOf(pick(body, "task_result.images")), ...urlsOf(pick(body, "task_result.series_images"))];
    // 水印版本（watermark_info.enabled=true 时返回）放 extras，与原图分开
    const wmUrls = [...urlsOf(pick(body, "task_result.images"), "watermark_url"), ...urlsOf(pick(body, "task_result.series_images"), "watermark_url")];
    return result(normalizeState(body["task_status"]), urls, body, wmUrls);
  },
};

// ---------------------------------------------------------------- 视频

const HY_VIDEO: FamilySpec = {
  id: "hy-video",
  maxPromptChars: 8192,
  kind: "video",
  models: ["hy-video-v1.5"],
  sync: false,
  sizeLimit: 10_000_000,
  formats: ["jpeg", "png"],
  params: [
    S("prompt", T("提示词（文生必填，图生可选）", "Prompt (required for text-to-video)")),
    S("negative_prompt", T("负向提示词", "Negative prompt")),
    S("image", T("首帧图 Base64（可传本地文件，自动转 data URL 前缀；与 image_url 二选一）", "First-frame image Base64 (local file allowed, data-URL prefixed; either this or image_url)"), { media: IMG("dataUrl") }),
    S("image_url", T("首帧图公网 URL（与 image 二选一）", "First-frame image public URL (either this or image)"), { media: IMG("urlOnly") }),
    N("n", T("输出视频数量", "Number of videos")),
    N("duration", T("视频时长（秒，当前固定 5）", "Duration in seconds (currently fixed at 5)")),
    S("aspect_ratio", T("宽高比（仅文生）", "Aspect ratio (text-to-video only)"), { choices: ["16:9", "9:16", "1:1", "4:3", "3:4"] }),
    S("resolution", T("清晰度（固定 720p）", "Resolution (fixed 720p)")),
    B("revise", T("提示词智能改写", "Smart prompt rewrite")),
    B("moderation", T("内容审核开关", "Content moderation")),
    N("seed", T("随机种子", "Random seed")),
    S("footnote", T("水印内容，≤16 字符", "Watermark text, <=16 chars")),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/137202",
  validateBody: (body) => {
    const hasImage = has(body, "image") || has(body, "image_url");
    if (has(body, "image") && has(body, "image_url")) return t("gen.rule.hyVideo.onlyOneImage");
    if (!hasImage && !has(body, "prompt")) return t("gen.rule.hyVideo.needInput");
    if (hasImage && has(body, "aspect_ratio")) return t("gen.rule.hyVideo.ratioT2vOnly");
    return undefined;
  },
  taskIdOf: (resp) => firstStr(resp, "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/hunyuan-video/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => result(normalizeState(resp["status"]), urlsOf(resp["videos"]), resp),
};

/** Kling 的 contents 数组字段 */
const KLING_CONTENT_FIELDS = (types: string[], extra: ParamField[] = [], urlDesc?: ParamText): ParamField[] => [
  F("type", "string", T("素材类型", "Block type"), { required: true, choices: types }),
  F("text", "string", T("提示词（type=prompt）", "Prompt text (type=prompt)")),
  F("url", "string", urlDesc ?? T("图片 / 视频素材（图片可为本地文件，视频仅 URL）", "Image / video material (image may be a local file; video URL only)")),
  F("element_id", "string", T("主体 ID（type=element）", "Element ID (type=element)")),
  ...extra,
  F("id", "string", T("素材索引 ID（多素材引用）", "Block index ID (multi-block reference)")),
];

const KLING_OPTIONS = O("options", T("通用配置", "Options"), [
  F("external_task_id", "string", T("自定义任务 ID（账号内唯一）", "Custom task ID (unique per account)")),
  F("watermark_info", "object", T("水印结果开关", "Watermarked result switch"), { fields: [F("enabled", "boolean", T("开关", "On/off"))] }),
]);

// ---- Kling 生视频（以《Kling 生视频调用指南》为准，文档 1823/135742） ----
const KV4 = "kling-video-v4";
const KV3 = "kling-video-v3";
const KV3_TURBO = "kling-video-v3-turbo";
const KV26 = "kling-video-v2.6";
const KV25_TURBO = "kling-video-v2.5-turbo";
const KV3_OMNI = "kling-video-v3-omni";
const KO1 = "kling-video-o1";
const KMC30 = "kling-video-motion-control-v3.0";

const KLING_SET_RESOLUTION = F("resolution", "string", T("清晰度（4k 仅 V3 / V3-Omni；默认 v4 1080p，其余 720p）", "Resolution (4k: V3 / V3-Omni only; default 1080p for v4, 720p otherwise)"), { choices: ["720p", "1080p", "4k"] });
const KLING_SET_RATIO = F("aspect_ratio", "string", T("画面宽高比（21:9 仅 v4；默认 16:9）", "Aspect ratio (21:9: v4 only; default 16:9)"), { choices: ["16:9", "9:16", "1:1", "21:9"] });
const KLING_SET_RATIO_OMNI = F("aspect_ratio", "string", T("画面宽高比（21:9 / adaptive 仅 v4，v4 默认 adaptive；V3-Omni / O1 默认 16:9，无首帧时必填）", "Aspect ratio (21:9 / adaptive: v4 only, v4 defaults to adaptive; V3-Omni / O1 default 16:9, required without a first frame)"), { choices: ["16:9", "9:16", "1:1", "21:9", "adaptive"] });
const KLING_SET_DURATION = F("duration", "integer", T("时长秒（v4 3~30；V3 / V3-Turbo / V3-Omni 3~15；O1 3~10；V2.6 / V2.5-Turbo 5 或 10；默认 5）", "Duration sec (v4 3~30; V3 / V3-Turbo / V3-Omni 3~15; O1 3~10; V2.6 / V2.5-Turbo 5 or 10; default 5)"));
const KLING_SET_MULTI_SHOT = (models: string[]) => F("multi_shot", "boolean", T("多镜头（默认 true）", "Multi-shot (default true)"), { models });
const KLING_SET_AUDIO = (choices: string[], desc: ParamText, models?: string[]) => F("audio", "string", desc, { choices, models });

/** 时长取值：区间（含端点，整数）或离散枚举 */
const KLING_DURATION: Record<string, { min: number; max: number } | number[]> = {
  [KV4]: { min: 3, max: 30 },
  [KV3]: { min: 3, max: 15 },
  [KV3_TURBO]: { min: 3, max: 15 },
  [KV3_OMNI]: { min: 3, max: 15 },
  [KO1]: { min: 3, max: 10 },
  [KV26]: [5, 10],
  [KV25_TURBO]: [5, 10],
};

/** 各素材类型的必带字段 */
const KLING_BLOCK_NEEDS: Record<string, string[]> = {
  prompt: ["text"],
  first_frame: ["url"],
  last_frame: ["url"],
  refer_image: ["url"],
  feature_video: ["url"],
  base_video: ["url"],
  image: ["url"],
  video: ["url"],
  element: ["element_id"],
  voice: ["voice_id", "id"],
};

const isUrl = (v: unknown): boolean => typeof v === "string" && /^https?:\/\//i.test(v);
const blocksOf = (body: Obj): Obj[] => (Array.isArray(body["contents"]) ? (body["contents"] as Obj[]) : []).filter((b) => b && typeof b === "object");
const settingsOf = (body: Obj): Obj => {
  const s = body["settings"];
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Obj) : {};
};

/**
 * 提示词长度：v4 中英加权（英文 ÷26000 + 非英文 ÷11000 ≤ 1）；long 内的模型 ≤3072；其余 ≤2500。
 * long 按接口给：文生 [V3]、全能 [V3-Omni]、图生 []（图生 contents[].text 统一 ≤2500）
 */
function klingPromptError(model: string, text: string, key: string, long: string[]): string | undefined {
  const chars = [...text];
  if (model === KV4) {
    const en = chars.filter((c) => c.codePointAt(0)! < 128).length;
    const other = chars.length - en;
    return en / 26000 + other / 11000 > 1 ? t("gen.rule.kling.v4PromptTooLong", { key, en, other }) : undefined;
  }
  const max = long.includes(model) ? 3072 : 2500;
  return chars.length > max ? t("gen.check.tooLong", { key, len: chars.length, max, model }) : undefined;
}

/** contents 通用：素材类型白名单、必带字段、id 唯一、提示词长度；text 只能放 type=prompt 块 */
function klingBlocksError(model: string, blocks: Obj[], allowed: string[], long: string[] = []): string | undefined {
  const ids = new Set<string>();
  for (const b of blocks) {
    const type = String(b["type"]);
    if (!allowed.includes(type)) return t("gen.rule.kling.typeUnsupported", { type, model, types: allowed.join(" / ") });
    for (const field of KLING_BLOCK_NEEDS[type] ?? []) {
      if (!has(b, field)) return t("gen.rule.kling.blockField", { type, field });
    }
    // Kling 1201：text 挂在素材块上会被识别为「没有 prompt 块」，报 prompt must have non-blank text
    if (type !== "prompt" && typeof b["text"] === "string" && b["text"].trim()) {
      return t("gen.rule.kling.textOnlyPrompt", { type });
    }
    const id = str(b["id"]);
    if (id) {
      if (ids.has(id)) return t("gen.rule.kling.dupId", { id });
      ids.add(id);
    }
    if (type === "prompt" && typeof b["text"] === "string") {
      const err = klingPromptError(model, b["text"], "contents[].text", long);
      if (err) return err;
    }
  }
  return undefined;
}

/** settings 通用：4k / 21:9 / adaptive 的模型限定、时长取值 */
function klingSettingsError(model: string, s: Obj): string | undefined {
  if (s["resolution"] === "4k" && model !== KV3 && model !== KV3_OMNI) return t("gen.rule.kling.res4k", { model });
  const ratio = s["aspect_ratio"];
  if ((ratio === "21:9" || ratio === "adaptive") && model !== KV4) return t("gen.rule.kling.ratioV4Only", { ratio, model });
  const spec = KLING_DURATION[model];
  if (spec && s["duration"] !== undefined) {
    const d = Number(s["duration"]);
    const okd = Array.isArray(spec) ? spec.includes(d) : Number.isInteger(d) && d >= spec.min && d <= spec.max;
    if (!okd) return t("gen.rule.kling.duration", { model, allowed: Array.isArray(spec) ? spec.join(" / ") : `${spec.min}~${spec.max}` });
  }
  return undefined;
}

const countOf = (types: string[], ...want: string[]): number => types.filter((x) => want.includes(x)).length;

function klingParse(resp: Obj): TaskResult {
  // 查询响应是 data 数组（每项一个任务），也兼容单对象
  const data = resp["data"];
  const item = (Array.isArray(data) ? data[0] : data ?? resp) as Obj;
  return result(normalizeState(item["status"] ?? item["task_status"]), urlsOf(item["outputs"]), item);
}

const KLING_VIDEO: FamilySpec = {
  id: "kling-video",
  vendor: "kling",
  // 族级上限取最大者（v4 纯英文 26000）；按模型的精确上限（v4 中英加权 / V3 3072 / 其余 2500）在 validateBody 里校验
  maxPromptChars: 26000,
  kind: "video",
  models: [KV4, KV3, KV3_TURBO, KV26, KV25_TURBO],
  sync: false,
  sizeLimit: 50_000_000,
  formats: ["jpeg", "png"],
  doc: "https://cloud.tencent.com/document/product/1823/135742",
  apis: {
    "text-to-video": {
      params: [
        PROMPT(T("提示词（v4：纯英文 ≤26000 / 纯非英文 ≤11000，混合按 英文÷26000+非英文÷11000≤1；V3 ≤3072 且支持多镜头语法；V3-Turbo / V2.6 / V2.5-Turbo ≤2500）", "Prompt (v4: English <=26000 / non-English <=11000, mixed: en/26000+other/11000<=1; V3 <=3072 with multi-shot syntax; V3-Turbo / V2.6 / V2.5-Turbo <=2500)")),
        O("settings", T("输出配置（v4 / V3-Turbo / V2.5-Turbo 仅 resolution / aspect_ratio / duration）", "Output settings (v4 / V3-Turbo / V2.5-Turbo: resolution / aspect_ratio / duration only)"), [
          KLING_SET_RESOLUTION,
          KLING_SET_RATIO,
          KLING_SET_DURATION,
          KLING_SET_MULTI_SHOT([KV3]),
          KLING_SET_AUDIO(["native", "off"], T("音频（native 原生音频 / off 默认；V2.6 native 仅 1080p）", "Audio (native / off by default; V2.6 native requires 1080p)"), [KV3, KV26]),
        ]),
        KLING_OPTIONS,
      ],
      validateBody: (body) => {
        const model = str(body["model"]) ?? "";
        const s = settingsOf(body);
        if (typeof body["prompt"] === "string") {
          const err = klingPromptError(model, body["prompt"], "prompt", [KV3]);
          if (err) return err;
        }
        const err = klingSettingsError(model, s);
        if (err) return err;
        if (model === KV26 && s["audio"] === "native" && s["resolution"] !== "1080p") return t("gen.rule.kling.v26Native1080p");
        return undefined;
      },
    },
    "image-to-video": {
      params: [
        A("contents", T("参考素材集合（须含 prompt 与 first_frame；尾帧可选；element 仅 V3 ≤3 个；voice 仅 V3 / V2.6 ≤2 个；图片 url 可为本地文件，v4 单张 ≤30MB）", "Reference blocks (prompt and first_frame required; last_frame optional; element: V3 only, <=3; voice: V3 / V2.6 only, <=2; image url may be a local file, v4 <=30MB each)"), {
          required: true,
          media: IMG("dataUrl", ["url"]),
          fields: KLING_CONTENT_FIELDS(["prompt", "first_frame", "last_frame", "element", "voice"], [F("voice_id", "string", T("音色 ID（type=voice，需同时给 id）", "Voice ID (type=voice; id required too)"))]),
        }),
        O("settings", T("输出配置（图生无 aspect_ratio，画幅跟随首帧）", "Output settings (no aspect_ratio; follows the first frame)"), [
          KLING_SET_RESOLUTION,
          KLING_SET_DURATION,
          KLING_SET_MULTI_SHOT([KV3]),
          KLING_SET_AUDIO(["native", "off"], T("音频（native / off 默认；引用音色时不能为 off；V2.6 native 仅 1080p）", "Audio (native / off by default; cannot be off with a voice; V2.6 native requires 1080p)"), [KV3, KV26]),
        ]),
        KLING_OPTIONS,
      ],
      validateBody: (body) => {
        const model = str(body["model"]) ?? "";
        const s = settingsOf(body);
        const blocks = blocksOf(body);
        const types = blocks.map((b) => String(b["type"]));
        const allowed: Record<string, string[]> = {
          [KV4]: ["prompt", "first_frame", "last_frame"],
          [KV3]: ["prompt", "first_frame", "last_frame", "element", "voice"],
          [KV26]: ["prompt", "first_frame", "last_frame", "voice"],
          [KV3_TURBO]: ["prompt", "first_frame", "last_frame"],
          [KV25_TURBO]: ["prompt", "first_frame", "last_frame"],
        };
        const err = klingBlocksError(model, blocks, allowed[model] ?? []) ?? klingSettingsError(model, s);
        if (err) return err;
        if (!types.includes("prompt") || !types.includes("first_frame")) return t("gen.rule.kling.i2vNeedPromptFrame");
        if (countOf(types, "first_frame") > 1 || countOf(types, "last_frame") > 1) return t("gen.rule.kling.oneFrameEach");
        if (countOf(types, "element") > 3) return t("gen.rule.kling.tooMany", { type: "element", max: 3 });
        if (countOf(types, "voice") > 2) return t("gen.rule.kling.tooMany", { type: "voice", max: 2 });
        if (types.includes("voice") && (s["audio"] === undefined || s["audio"] === "off")) return t("gen.rule.kling.voiceNeedsAudio");
        const lastFrame = types.includes("last_frame");
        if (model === KV26 && lastFrame && s["resolution"] !== undefined && s["resolution"] !== "720p") return t("gen.rule.kling.v26Frames720p");
        if (model === KV26 && s["audio"] === "native" && s["resolution"] !== "1080p") return t("gen.rule.kling.v26Native1080p");
        if (model === KV25_TURBO && lastFrame && s["resolution"] !== "1080p") return t("gen.rule.kling.v25Frames1080p");
        return undefined;
      },
    },
  },
  taskIdOf: (resp) => firstStr(resp, "data.task_id", "data.id", "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/kling/tasks/${encodeURIComponent(id)}` }),
  parse: klingParse,
};

/**
 * Kling 全能视频（omni-video）：v4 / V3-Omni / O1。
 * 族 models 只放 V3-Omni / O1（模型 ID 全局唯一，v4 归 kling-video 族）；接口白名单在 APIS 里单独加 v4。
 */
const KLING_VIDEO_OMNI: FamilySpec = {
  id: "kling-video-omni",
  vendor: "kling",
  // contents[].text 的按模型上限在 validateBody 里校验（顶层无 prompt）
  maxPromptChars: 26000,
  kind: "video",
  models: [KV3_OMNI, KO1],
  sync: false,
  sizeLimit: 50_000_000,
  formats: ["jpeg", "png"],
  params: [
    A("contents", T("多模态参考素材集合（V3-Omni / O1：图片 / 视频 url 均可为本地文件，图片 jpg/jpeg/png ≤50MB，视频 mp4/mov ≤75MB；v4：视频仅 URL（≤300MB、3~30 秒），图片 ≤30MB ≤10 张，参考视频 ≤5 段，主体 ≤7，音色 ≤3，素材合计 ≤15，可在 prompt 中以 @image_1 / @video_1 / @element_1 引用）", "Multimodal reference blocks (V3-Omni / O1: image / video url may be local files, image jpg/jpeg/png <=50MB, video mp4/mov <=75MB; v4: video URL only (<=300MB, 3~30 s), images <=30MB and <=10, videos <=5, elements <=7, voices <=3, <=15 in total; reference as @image_1 / @video_1 / @element_1)"), {
      required: true,
      media: AUTO("dataUrl", ["url"], { formats: ["mp4", "mov"], maxBytes: 75_000_000 }),
      fields: KLING_CONTENT_FIELDS(
        ["prompt", "first_frame", "last_frame", "refer_image", "feature_video", "base_video", "element", "voice"],
        [F("voice_id", "string", T("音色 ID（type=voice，需同时给 id，prompt 中以 @id 引用）", "Voice ID (type=voice; id required too, referenced as @id)"))],
        T("图片 / 视频素材（V3-Omni / O1 均可为本地文件；v4 视频仅 URL（≤300MB），图片本地 ≤30MB）", "Image / video material (V3-Omni / O1: local files allowed; v4: video URL only (<=300MB), local images <=30MB)"),
      ),
    }),
    O("settings", T("输出配置（V3-Omni / O1 无首帧时 aspect_ratio 必填，含参考视频场景；v4 仅 resolution / aspect_ratio / duration）", "Output settings (V3-Omni / O1: aspect_ratio required without a first frame, reference videos included; v4: resolution / aspect_ratio / duration only)"), [
      KLING_SET_RESOLUTION,
      KLING_SET_RATIO_OMNI,
      KLING_SET_DURATION,
      KLING_SET_MULTI_SHOT([KV3_OMNI]),
      KLING_SET_AUDIO(["native", "original", "off"], T("音频（V3-Omni：native / original / off；O1：original / off；默认 off；original=保留参考视频原声）", "Audio (V3-Omni: native / original / off; O1: original / off; default off; original keeps the reference video's sound)"), [KV3_OMNI, KO1]),
    ]),
    KLING_OPTIONS,
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135742",
  requestNote: T(
    '视频编辑 / 视频参考示例（无首帧时 settings.aspect_ratio 必填，参考视频场景也一样）：\n--contents \'[{"type":"prompt","text":"把背景换成夜景"},{"type":"base_video","url":"https://…/in.mp4"}]\' --settings \'{"aspect_ratio":"16:9"}\'\n参考视频（feature_video / base_video）的像素宽高比（SAR）须严格为 1:1，否则报 PAR should be 1:1；先转码：ffmpeg -i in.mp4 -vf setsar=1 -c:a copy out.mp4',
    'Video edit / reference example (settings.aspect_ratio is required without a first frame, reference videos included):\n--contents \'[{"type":"prompt","text":"night background"},{"type":"base_video","url":"https://…/in.mp4"}]\' --settings \'{"aspect_ratio":"16:9"}\'\nReference videos (feature_video / base_video) need a sample aspect ratio (SAR) of exactly 1:1, otherwise "PAR should be 1:1"; re-encode first: ffmpeg -i in.mp4 -vf setsar=1 -c:a copy out.mp4',
  ),
  validateBody: (body) => {
    const model = str(body["model"]) ?? "";
    const s = settingsOf(body);
    const blocks = blocksOf(body);
    const types = blocks.map((b) => String(b["type"]));
    const all = ["prompt", "first_frame", "last_frame", "refer_image", "feature_video", "base_video", "element", "voice"];
    if (model === KV4 && types.includes("base_video")) return t("gen.rule.omni.v4NoBaseVideo");
    const err = klingBlocksError(model, blocks, all, [KV3_OMNI]) ?? klingSettingsError(model, s);
    if (err) return err;
    if (countOf(types, "first_frame") > 1 || countOf(types, "last_frame") > 1) return t("gen.rule.kling.oneFrameEach");
    if (types.includes("last_frame") && !types.includes("first_frame")) return t("gen.rule.kling.lastNeedsFirst");
    const images = countOf(types, "first_frame", "last_frame", "refer_image");
    const videos = countOf(types, "feature_video", "base_video");
    const elements = countOf(types, "element");
    const voices = countOf(types, "voice");

    if (model === KV4) {
      // v4：不支持 base_video（已在类型白名单拦）与 settings.audio；视频仅 URL；数量上限
      if (has(s, "audio")) return t("gen.rule.omni.v4NoAudio");
      if (blocks.some((b) => b["type"] === "feature_video" && !isUrl(b["url"]))) return t("gen.rule.kling.v4VideoUrlOnly");
      // v4 图片单张 ≤30MB（调用指南；族级 sizeLimit 50MB 不适用）：本地文件已被编码为 data URL，
      // 按 Base64 载荷长度估算原始字节（误差 ≤2B）；远程 URL 大小属内容属性，由服务端校验
      if (blocks.some((b) => {
        if (!["first_frame", "last_frame", "refer_image"].includes(String(b["type"]))) return false;
        const u = typeof b["url"] === "string" ? (b["url"] as string) : "";
        return /^data:image\//i.test(u) && Math.floor(((u.length - u.indexOf(",") - 1) * 3) / 4) > 30_000_000;
      })) return t("gen.rule.kling.v4ImageMax30m");
      if (images > 10) return t("gen.rule.kling.tooMany", { type: "image", max: 10 });
      if (videos > 5) return t("gen.rule.kling.tooMany", { type: "feature_video", max: 5 });
      // 调用指南另有「有视频角色主体时，视频角色主体与参考视频合计 ≤5」：element 块只有 element_id、
      // 不区分图片/视频主体，本地无从判定，交服务端校验（主体 ≤7 已在下方拦截）
      if (elements > 7) return t("gen.rule.kling.tooMany", { type: "element", max: 7 });
      if (voices > 3) return t("gen.rule.kling.tooMany", { type: "voice", max: 3 });
      if (images + videos + elements + voices > 15) return t("gen.rule.kling.v4TotalMax");
      return undefined;
    }

    // V3-Omni / O1
    // 服务端实测：只有传了首帧才能省略 aspect_ratio（画幅跟随首帧）；feature_video 参考、base_video 编辑都要求传，
    // 官方文档写的「无首帧且无参考视频时必填」与服务端不一致，以服务端为准
    if (!types.includes("first_frame") && !has(s, "aspect_ratio")) {
      const video = types.find((x) => x === "feature_video" || x === "base_video");
      return video ? t("gen.rule.omni.ratioWithVideo", { video }) : t("gen.rule.omni.ratioNoFirstFrame");
    }
    if (videos > 1) return t("gen.rule.kling.tooMany", { type: "feature_video / base_video", max: 1 });
    if (types.includes("feature_video") && types.includes("last_frame")) return t("gen.rule.kling.featureNoLastFrame");
    if (types.includes("base_video")) {
      if (types.includes("first_frame") || types.includes("last_frame")) return t("gen.rule.kling.baseNoFrames");
      if (s["multi_shot"] === true) return t("gen.rule.kling.baseNoMultiShot");
      if (s["audio"] === "native") return t("gen.rule.kling.baseNoNative");
    }
    const refMax = videos ? 4 : 7;
    if (countOf(types, "refer_image") + elements > refMax) return t("gen.rule.kling.referMax", { max: refMax });
    if (voices > 2) return t("gen.rule.kling.tooMany", { type: "voice", max: 2 });
    if (voices && (s["audio"] === undefined || s["audio"] === "off")) return t("gen.rule.kling.voiceNeedsAudio");
    if (model === KO1) {
      if (s["audio"] === "native") return t("gen.rule.kling.o1Audio");
      if (types.includes("last_frame") && (types.includes("refer_image") || elements)) return t("gen.rule.kling.o1FramesExclusive");
      // O1：除提示词与首帧外没有其他参考（参考图 / 尾帧 / 主体 / 视频）时，时长只支持 5 / 10
      const onlyPromptOrFirstFrame = types.every((x) => x === "prompt" || x === "first_frame");
      if (onlyPromptOrFirstFrame && s["duration"] !== undefined && ![5, 10].includes(Number(s["duration"]))) return t("gen.rule.omni.o1Duration");
    }
    if (model === KV3_OMNI && types.includes("feature_video")) {
      if (s["audio"] !== undefined && s["audio"] !== "off") return t("gen.rule.kling.featureAudioOff");
      if (s["multi_shot"] === false) return t("gen.rule.kling.featureMultiShot");
    }
    return undefined;
  },
  taskIdOf: (resp) => firstStr(resp, "data.task_id", "data.id", "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/kling/tasks/${encodeURIComponent(id)}` }),
  parse: klingParse,
};

/** Kling 动作控制：形象参考图 + 动作参考视频 */
const KLING_MOTION_CONTROL: FamilySpec = {
  id: "kling-motion-control",
  vendor: "kling",
  maxPromptChars: 2500,
  kind: "video",
  models: ["kling-video-motion-control-v3.0", "kling-video-motion-control-v2.6"],
  sync: false,
  sizeLimit: 50_000_000,
  formats: ["jpeg", "png"],
  params: [
    A("contents", T("参考素材合集（须含 type=image 形象图与 type=video 动作视频，视频仅 URL；element 仅 v3.0 且最多 1 个，需同时给 id；prompt ≤2500）", "Reference blocks (type=image character image and type=video motion video required, video URL only; element: v3.0 only, at most 1, id required; prompt <=2500)"), {
      required: true,
      media: IMG("dataUrl", ["url"]),
      fields: KLING_CONTENT_FIELDS(["prompt", "image", "video", "element"]),
    }),
    O("settings", T("输出配置（无 duration，输出时长跟随动作视频）", "Output settings (no duration; follows the motion video)"), [
      F("character_orientation", "string", T("人物朝向：image 与形象图一致（参考视频 ≤10s）/ video 与动作视频一致（≤30s）；引用主体时只能 video", "Character orientation: image (motion video <=10s) / video (<=30s); must be video with an element"), { required: true, choices: ["image", "video"] }),
      KLING_SET_AUDIO(["original", "off"], T("音频（original 保留参考视频原声，默认 / off 无声）", "Audio (original keeps the reference sound, default / off silent)")),
      F("resolution", "string", T("清晰度（默认 720p）", "Resolution (default 720p)"), { choices: ["720p", "1080p"] }),
    ], { required: true }),
    KLING_OPTIONS,
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135742",
  validateBody: (body) => {
    const model = str(body["model"]) ?? "";
    const blocks = blocksOf(body);
    const types = blocks.map((b) => String(b["type"]));
    if (!types.includes("image")) return t("gen.rule.motion.needImage");
    if (!types.includes("video")) return t("gen.rule.motion.needVideo");
    const allowed = model === KMC30 ? ["prompt", "image", "video", "element"] : ["prompt", "image", "video"];
    const err = klingBlocksError(model, blocks, allowed);
    if (err) return err;
    if (blocks.some((b) => b["type"] === "video" && !isUrl(b["url"]))) return t("gen.rule.motion.videoUrlOnly");
    if (countOf(types, "element") > 1) return t("gen.rule.kling.tooMany", { type: "element", max: 1 });
    if (blocks.some((b) => b["type"] === "element" && !has(b, "id"))) return t("gen.rule.kling.blockField", { type: "element", field: "id" });
    if (types.includes("element") && settingsOf(body)["character_orientation"] !== "video") return t("gen.rule.motion.elementOrientation");
    return undefined;
  },
  taskIdOf: (resp) => firstStr(resp, "data.task_id", "data.id", "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/kling/tasks/${encodeURIComponent(id)}` }),
  parse: klingParse,
};

// Vidu 四个接口的字段（按官方调用指南各接口的字段表）
const VIDU_DURATION = N("duration", T("时长秒（q4-preview 3~16；q3 系 1~16；q2 系 1~10）", "Duration sec (q4-preview: 3~16; q3: 1~16; q2: 1~10)"));
const VIDU_RESOLUTION = S("resolution", T("分辨率（2K / 4K 仅 q4-preview）", "Resolution (2K / 4K: q4-preview only)"), { choices: ["540p", "720p", "1080p", "2K", "4K"] });
const VIDU_RATIO = S("aspect_ratio", T("宽高比", "Aspect ratio"), { choices: ["16:9", "9:16", "3:4", "4:3", "1:1"] });
const VIDU_MOVEMENT = S("movement_amplitude", T("运动幅度（默认 auto；q2/q3 系、q4-preview 不生效）", "Movement amplitude (default auto; not for q2/q3/q4-preview)"), { choices: ["auto", "small", "medium", "large"] });
const VIDU_BGM = B("bgm", T("背景音乐（q3 系、q4-preview 不生效）", "Background music (not for q3/q4-preview)"));
const VIDU_AUDIO = B("audio", T("音画同出（q3 系、q4-preview；q3 默认 true）", "Audio-video output (q3 / q4-preview; default true on q3)"));
const VIDU_AUDIO_TYPE = S("audio_type", T("音频类型（audio=true 时必填，默认 all）", "Audio type (required when audio=true, default all)"), { choices: ["all", "speech_only", "sound_effect_only"] });
const VIDU_TAIL: ParamSpec[] = [
  N("seed", T("随机种子（0 或不传 = 随机）", "Random seed (0/absent = random)")),
  S("payload", T("透传参数（≤1,048,576 字符）", "Passthrough payload (<=1,048,576 chars)")),
  B("watermark", T("是否加水印（默认 false）", "Add watermark (default false)")),
  N("wm_position", T("水印位置（TokenHub 不支持）", "Watermark position (unsupported on TokenHub)")),
  S("wm_url", T("自定义水印图 URL", "Custom watermark image URL")),
];
const VIDU_IS_REC = B("is_rec", T("推荐提示词（多耗 10 积分/任务）", "Recommended prompt (+10 credits/task)"));
const VIDU_IMAGES = (desc: ParamText, required: boolean) => A("images", desc, { required, media: IMG("dataUrl") });

const VIDU_VIDEO: FamilySpec = {
  id: "vidu-video",
  vendor: "vidu",
  maxPromptChars: 5000,
  kind: "video",
  models: ["vidu-video-q4-preview", "vidu-video-q3-turbo", "vidu-video-q3-pro", "vidu-video-q3", "vidu-video-q2", "vidu-video-q2-pro", "vidu-video-q2-turbo"],
  sync: false,
  sizeLimit: 15_000_000,
  formats: ["jpeg", "png", "webp"],
  doc: "https://cloud.tencent.com/document/product/1823/135756",
  apis: {
    "text-to-video": {
      models: ["vidu-video-q3-turbo", "vidu-video-q3-pro", "vidu-video-q2"],
      params: [
        PROMPT(T("提示词（≤5000 字符）", "Prompt (<=5000 chars)")),
        S("style", T("风格（默认 general；q2/q3 不生效）", "Style (default general; not for q2/q3)"), { choices: ["general", "anime"] }),
        VIDU_DURATION,
        VIDU_RATIO,
        VIDU_RESOLUTION,
        VIDU_MOVEMENT,
        VIDU_BGM,
        VIDU_AUDIO,
        VIDU_AUDIO_TYPE,
        ...VIDU_TAIL,
      ],
    },
    "image-to-video": {
      models: ["vidu-video-q4-preview", "vidu-video-q3-turbo", "vidu-video-q3-pro", "vidu-video-q3", "vidu-video-q2", "vidu-video-q2-pro", "vidu-video-q2-turbo"],
      params: [
        VIDU_IMAGES(T("首帧图（1 张，URL 或本地文件）", "First-frame image (1; URL or local file)"), true),
        S("prompt", T("提示词（≤5000 字符）", "Prompt (<=5000 chars)")),
        VIDU_AUDIO,
        VIDU_AUDIO_TYPE,
        S("voice_id", T("音色 ID（q3 不生效）", "Voice ID (not for q3)")),
        VIDU_IS_REC,
        VIDU_BGM,
        VIDU_DURATION,
        VIDU_RESOLUTION,
        VIDU_MOVEMENT,
        ...VIDU_TAIL,
      ],
    },
    "start-end-to-video": {
      models: ["vidu-video-q3-turbo", "vidu-video-q3-pro", "vidu-video-q3", "vidu-video-q2", "vidu-video-q2-pro", "vidu-video-q2-turbo"],
      params: [
        VIDU_IMAGES(T("首尾帧（2 张，分辨率相近；URL 或本地文件）", "First and last frames (2, similar resolution; URL or local file)"), true),
        S("prompt", T("提示词（≤5000 字符）", "Prompt (<=5000 chars)")),
        VIDU_IS_REC,
        N("duration", T("时长秒（q3 系 1~16；q2 系 1~8）", "Duration sec (q3: 1~16; q2: 1~8)")),
        VIDU_RESOLUTION,
        VIDU_MOVEMENT,
        VIDU_AUDIO,
        VIDU_BGM,
        ...VIDU_TAIL,
      ],
    },
    "reference-to-video": {
      models: ["vidu-video-q4-preview", "vidu-video-q3-turbo", "vidu-video-q3", "vidu-video-q2", "vidu-video-q2-pro", "vidu-video-q2-turbo"],
      params: [
        A("subjects", T("主体集合（方式一；与 images/videos 二选一；prompt 中 @name 引用）", "Subjects (mode 1; either this or images/videos; referenced as @name)"), {
          media: [IMG("dataUrl", ["images"]), MEDIA("dataUrl", ["videos"], { formats: ["mp4", "avi", "mov"], maxBytes: 20_000_000 })],
          fields: [
            F("name", "string", T("主体名称（prompt 中 @name 引用）", "Subject name (@name in prompt)"), { required: true }),
            F("images", "array", T("主体图片（最多 3 张，URL 或本地文件；与 videos 二选一）", "Subject images (up to 3; URL or local file; either this or videos)")),
            F("videos", "array", T("主体视频（仅 q2-pro，URL 或本地文件；与 images 二选一）", "Subject videos (q2-pro only, URL or local file; either this or images)")),
            F("voice_id", "string", T("主体音色 ID（q3 不生效）", "Subject voice ID (not for q3)")),
          ],
        }),
        VIDU_IMAGES(T("参考图（方式二，1~3 张，URL 或本地文件）", "Reference images (mode 2, 1~3; URL or local file)"), false),
        A("videos", T("参考视频（方式二，URL 或本地文件；仅 q2-pro）", "Reference videos (mode 2, URL or local file; q2-pro only)"), { models: ["vidu-video-q2-pro"], media: MEDIA("dataUrl", undefined, { formats: ["mp4", "avi", "mov"], maxBytes: 20_000_000 }) }),
        PROMPT(T("提示词（主体式 ≤5000；直参式 ≤2000）", "Prompt (subjects mode <=5000; direct mode <=2000)")),
        B("auto_subjects", T("智能主体库（默认 false）", "Smart subject library (default false)")),
        VIDU_AUDIO,
        VIDU_AUDIO_TYPE,
        N("duration", T("时长秒（q3 系 / q4-preview 3~16；q2-pro 0~10；q2 1~10）", "Duration sec (q3 / q4-preview: 3~16; q2-pro: 0~10; q2: 1~10)")),
        VIDU_RATIO,
        VIDU_RESOLUTION,
        VIDU_MOVEMENT,
        VIDU_BGM,
        ...VIDU_TAIL,
      ],
      validateBody: (body) => {
        const hasSubjects = has(body, "subjects");
        const hasMedia = has(body, "images") || has(body, "videos");
        if (hasSubjects === hasMedia) {
          return t("gen.rule.viduRef.exactlyOne");
        }
        // subjects[].videos 仅 q2-pro（TokenPlan 表格最终版 9-23）：其他模型本地先拦
        if (str(body["model"]) !== "vidu-video-q2-pro") {
          const subjects = (Array.isArray(body["subjects"]) ? body["subjects"] : []) as Obj[];
          const withVideos = subjects.some((s) => Array.isArray(s?.["videos"]) && (s["videos"] as unknown[]).length > 0);
          if (withVideos) return t("gen.rule.viduRef.videosQ2Pro");
        }
        return undefined;
      },
    },
  },
  taskIdOf: (resp) => firstStr(resp, "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/vidu/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    // creations[].cover_url 是视频封面（文档 566 行）：结果的一部分，放 extras 与主视频分开
    const creations = resp["creations"];
    const covers = Array.isArray(creations) ? ((creations as Obj[]).map((c) => str(c["cover_url"])).filter(Boolean) as string[]) : [];
    return result(normalizeState(resp["state"]), urlsOf(creations), resp, covers);
  },
};

/** PixVerse 的数字状态：1 成功 / 5 生成中 / 6 已删除 / 7 审核失败 / 8 生成失败 */
function pixverseState(status: unknown): TaskState {
  const n = Number(status);
  if (n === 1) return "succeeded";
  if (n === 6 || n === 7 || n === 8) return "failed";
  return "running";
}

const PIX_PROMPT = PROMPT(T("提示词（≤5000 字符）", "Prompt (<=5000 chars)"));
const PIX_DURATION = N("duration", T("时长秒（v5.6：5/8/10；v6/c1：1~15）", "Duration sec (v5.6: 5/8/10; v6/c1: 1~15)"), { required: true });
const PIX_QUALITY = S("quality", T("清晰度", "Quality"), { required: true, choices: ["360p", "540p", "720p", "1080p"] });
const PIX_RATIO = S("aspect_ratio", T("宽高比（v6/c1 额外支持 2:3/3:2/21:9）", "Aspect ratio (v6/c1 also 2:3/3:2/21:9)"));
const PIX_CAMERA = S("camera_movement", T("运镜方式（如 zoom_in）", "Camera movement (e.g. zoom_in)"));
const PIX_SEED = N("seed", T("随机种子 0~2147483647", "Random seed 0~2147483647"));
const PIX_AUDIO = B("generate_audio_switch", T("生成音频（默认 false）", "Generate audio (default false)"));
const PIX_MULTI_CLIP = B("generate_multi_clip_switch", T("多镜头", "Multi-clip"), { models: ["pixverse-video-v6.0"] });
const PIX_IMG = (path: string, desc: ParamText, required = true) => S(path, desc, { required, media: IMG("dataUrl") });

const PIXVERSE: FamilySpec = {
  id: "pixverse",
  vendor: "pixverse",
  maxPromptChars: 5000,
  kind: "video",
  models: ["pixverse-video-v6.0", "pixverse-video-c1", "pixverse-video-v5.6"],
  sync: false,
  sizeLimit: 20_000_000,
  formats: ["jpeg", "png", "webp"],
  doc: "https://cloud.tencent.com/document/product/1823/135325",
  apis: {
    "text-to-video": {
      params: [PIX_PROMPT, PIX_DURATION, PIX_QUALITY, PIX_RATIO, PIX_CAMERA, PIX_SEED, PIX_AUDIO, PIX_MULTI_CLIP],
    },
    "image-to-video": {
      params: [
        PIX_IMG("img_id", T("首帧图（URL 或本地文件，<20MB）", "First-frame image (URL or local file, <20MB)")),
        A("img_ids", T("多图模板图片数组（仅公网 URL，0~7 张）", "Multi-image template images (public URL only, 0-7)"), { media: IMG("urlOnly") }),
        PIX_PROMPT,
        PIX_DURATION,
        PIX_QUALITY,
        PIX_CAMERA,
        PIX_SEED,
        PIX_AUDIO,
        PIX_MULTI_CLIP,
      ],
    },
    "start-end-to-video": {
      params: [
        PIX_PROMPT,
        PIX_IMG("first_frame_img", T("首帧图（URL 或本地文件，<20MB）", "First frame (URL or local file, <20MB)")),
        PIX_IMG("last_frame_img", T("尾帧图（URL 或本地文件，<20MB）", "Last frame (URL or local file, <20MB)")),
        PIX_DURATION,
        PIX_QUALITY,
        PIX_SEED,
        PIX_AUDIO,
      ],
    },
    "reference-to-video": {
      params: [
        A("image_references", T("参考图数组（最多 7 项；prompt 中 @ref_name 引用）", "Reference images (up to 7; @ref_name in prompt)"), {
          required: true,
          media: IMG("dataUrl", ["img_id"]),
          fields: [
            F("img_id", "string", T("参考图（URL 或本地文件）", "Reference image (URL or local file)"), { required: true }),
            F("type", "string", T("参考图类型", "Reference type"), { choices: ["subject", "background"] }),
            F("ref_name", "string", T("参考图名称（≤30 字符）", "Reference name (<=30 chars)")),
          ],
        }),
        PIX_PROMPT,
        PIX_DURATION,
        PIX_QUALITY,
        PIX_RATIO,
        PIX_AUDIO,
        PIX_SEED,
      ],
    },
  },
  taskIdOf: (resp) => firstStr(resp, "Resp.video_id", "Resp.id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/pixverse/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    const r = (resp["Resp"] ?? {}) as Obj;
    const url = str(r["url"]);
    return result(pixverseState(r["status"]), url ? [url] : [], resp);
  },
};

const MINIMAX_V1: FamilySpec = {
  id: "minimax-video",
  vendor: "minimax",
  maxPromptChars: 2000,
  kind: "video",
  models: ["minimax-video-v2.3", "minimax-video-v2.3-fast"],
  sync: false,
  sizeLimit: 20_000_000,
  formats: ["jpeg", "png", "webp"],
  params: [
    S("prompt", T("提示词（≤2000 字符，支持 [指令] 运镜语法）", "Prompt (<=2000 chars; supports [command] camera syntax)")),
    B("prompt_optimizer", T("自动优化提示词（默认 true）", "Auto-optimize prompt (default true)")),
    B("fast_pretreatment", T("缩短优化耗时（默认 false）", "Faster pretreatment (default false)")),
    N("duration", T("时长秒（768P：6/10；1080P：仅 6）", "Duration sec (768P: 6/10; 1080P: 6 only)")),
    S("resolution", T("分辨率（默认 768P）", "Resolution (default 768P)"), { choices: ["768P", "1080P"] }),
    B("aigc_watermark", T("AIGC 水印（默认 false）", "AIGC watermark (default false)")),
    S("first_frame_image", T("首帧图（URL 或本地文件；v2.3-fast 必填）", "First-frame image (URL or local file; required for v2.3-fast)"), {
      required: ["minimax-video-v2.3-fast"],
      media: IMG("dataUrl"),
    }),
    S("last_frame_image", T("尾帧图（URL 或本地文件；v2.3 首尾帧模式条件必选，与 first_frame_image 搭配；v2.3-fast 不支持）", "Last-frame image (URL or local file; required for v2.3 first-and-last-frame mode, paired with first_frame_image; not supported by v2.3-fast)"), {
      models: ["minimax-video-v2.3"],
      media: IMG("dataUrl"),
    }),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135737",
  validateBody: (body) => {
    if (!has(body, "prompt") && !has(body, "first_frame_image")) return t("gen.rule.minimaxVideo.needInput");
    return undefined;
  },
  taskIdOf: (resp) => firstStr(resp, "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/minimax-video/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    const url = str(pick(resp, "content.url"));
    return result(normalizeState(resp["status"]), url ? [url] : [], resp);
  },
};

/** content 数组字段（MiniMax H3 / WAND 生视频） */
const URL_OBJ = (desc: ParamText) => F("", "object", desc, { fields: [F("url", "string", T("地址", "URL"))] });
const CONTENT_FIELDS = (types: string[], roles: string[], media: Array<"image_url" | "video_url" | "audio_url">): ParamField[] => [
  F("type", "string", T("素材类型", "Block type"), { required: true, choices: types }),
  F("text", "string", T("文本（type=text）", "Text (type=text)")),
  ...media.map((k) => ({ ...URL_OBJ(T(`${k}（type=${k}）`, `${k} (type=${k})`)), key: k })),
  F("role", "string", T("素材用途", "Material role"), { choices: roles }),
];

/**
 * content 数组内 text 块的长度校验：checkBody 的 maxPromptChars 只查顶层 prompt / text 键，
 * 数组内块不覆盖（kling 的 contents[].text 由 klingPromptError 拦，MiniMax H3 / WAND vega 需族级自拦）。
 */
const contentTextLengthCheck = (max: number): ((body: Obj) => string | undefined) => (body) => {
  const blocks = (Array.isArray(body["content"]) ? body["content"] : []) as Obj[];
  for (const b of blocks) {
    const text = typeof b?.["text"] === "string" ? b["text"] : undefined;
    if (text && [...text].length > max) {
      return t("gen.check.tooLong", { key: "content[].text", len: [...text].length, max, model: str(body["model"]) ?? "" });
    }
  }
  return undefined;
};

const MINIMAX_V2: FamilySpec = {
  id: "minimax-video-v2",
  vendor: "minimax-h3",
  maxPromptChars: 2000,
  kind: "video",
  models: ["minimax-video-h3", "minimax-video-h3-max"],
  sync: false,
  sizeLimit: 30_000_000,
  formats: ["jpeg", "png", "webp", "heic", "heif"],
  params: [
    A("content", T("多模态素材数组（文生仅一个 text 块；图片 / 视频 / 音频 url 可为本地文件）", "Multimodal blocks (text-only = one text block; image / video / audio url may be a local file)"), {
      required: true,
      media: [
        IMG("dataUrl", ["image_url.url"]),
        MEDIA("dataUrl", ["video_url.url"], { formats: ["mp4", "mov"], maxBytes: 50_000_000 }),
        MEDIA("dataUrl", ["audio_url.url"], { formats: ["wav", "mp3"], maxBytes: 15_000_000 }),
      ],
      fields: CONTENT_FIELDS(["text", "image_url", "video_url", "audio_url"], ["first_frame", "last_frame", "reference_image", "reference_video", "reference_audio"], ["image_url", "video_url", "audio_url"]),
    }),
    S("resolution", T("分辨率（h3：768P/2K；h3-max：480P/768P）", "Resolution (h3: 768P/2K; h3-max: 480P/768P)"), { required: true }),
    N("duration", T("时长秒（h3：4~15；h3-max：5~15）", "Duration sec (h3: 4~15; h3-max: 5~15)"), { required: true }),
    S("ratio", T("宽高比（文生必填且不可 adaptive；图生跟随首帧；多模态参考默认 adaptive）", "Aspect ratio (required for text-to-video, not adaptive; image-to-video follows the frame; reference mode defaults to adaptive)"), {
      choices: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"],
    }),
    B("aigc_watermark", T("AIGC 水印（默认 false）", "AIGC watermark (default false)")),
    O("extra", T("扩展参数", "Extra options"), [
      F("prompt_expansion_mode", "string", T("提示词扩写模式（默认 balanced）", "Prompt expansion mode (default balanced)"), { choices: ["disabled", "balanced", "quality"] }),
    ]),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135737",
  validateBody: (body) => {
    const content = (Array.isArray(body["content"]) ? body["content"] : []) as Obj[];
    const textOnly = content.length > 0 && content.every((c) => c?.["type"] === "text");
    // 文生：ratio 必填，adaptive 会被服务端静默按 16:9 处理，本地先拦
    if (textOnly && (!has(body, "ratio") || body["ratio"] === "adaptive")) {
      return t("gen.rule.minimaxV2.ratio");
    }
    // h3-max 支持多模态参考素材（与 h3 同权）：调用指南口径正确，TokenPlan 表格 9-23「不支持」为错误声明——
    // 2026-11-04 实测：h3-max + reference_image 提交通过且出片成功（300000 tokens），勿再按表格加模型级拦截。
    // text 块长度（与族 maxPromptChars 同口径，checkBody 顶层键检查不覆盖数组内块）
    return contentTextLengthCheck(2000)(body);
  },
  taskIdOf: (resp) => firstStr(resp, "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/minimax-video-v2/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    const url = str(pick(resp, "task.content.url"));
    return result(normalizeState(pick(resp, "task.status")), url ? [url] : [], resp);
  },
};

const WAND_VIDEO: FamilySpec = {
  id: "wand-video",
  // 文档矛盾待反馈：WAND 概览 2000 vs 调用指南 8192；本地取宽值 8192 防误拦
  maxPromptChars: 8192,
  kind: "video",
  models: ["wand-vega-video-1.0-lite"],
  sync: false,
  params: [
    A("content", T("多模态输入（至少 1 个 text 块；图片与音频可传本地文件，自动内联为 data URL（音频须 2~15 秒）；视频素材仅公网 URL）", "Multimodal input (at least one text block; images and audio may be local files, inlined as data URLs (audio 2~15 s); video materials public URL only)"), {
      required: true,
      // 实测（2026-11-03）：image_url / audio_url 的 data URL 上游接受——image_url 出片成功；
      // audio_url 被解码并校验时长（须 2000~15000 ms，实测 1 秒音频报 InvalidParameter，格式本身放行）。
      // video_url 上游明确拒绝内联（400: "video_url does not support inline base64; use a public URL"），维持仅公网 URL。
      // 裸 Base64（无 data: 前缀）提交即 400（scheme "" is not supported, allowed: http/https/asset）——
      // 该 allowed 列表不含 data，系报错文案滞后，以实测为准。
      media: [
        IMG("dataUrl", ["image_url.url"]),
        IMG("urlOnly", ["video_url.url"]),
        MEDIA("dataUrl", ["audio_url.url"], { formats: ["wav", "mp3"], maxBytes: 15_000_000 }),
      ],
      fields: CONTENT_FIELDS(
        ["text", "image_url", "video_url", "audio_url"],
        ["first_frame", "last_frame", "reference_image", "reference_video", "reference_audio"],
        ["image_url", "video_url", "audio_url"],
      ),
    }),
    S("resolution", T("清晰度", "Resolution"), { choices: ["768P", "1080P", "2K", "4K"] }),
    S("ratio", T("宽高比（默认 adaptive，由模型或素材决定）", "Aspect ratio (default adaptive: decided by the model or input)"), {
      choices: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"],
    }),
    N("duration", T("时长秒 4~15（默认 5）", "Duration sec 4~15 (default 5)")),
    O("options", T("高级扩展参数", "Advanced options"), [
      F("return_last_frame", "boolean", T("同时返回尾帧图片（默认 false）", "Also return the last frame (default false)")),
    ]),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/138195",
  // content 内 text 块长度：文档矛盾（概览 2000 / 指南 8192），取宽值防误拦
  validateBody: contentTextLengthCheck(8192),
  taskIdOf: (resp) => firstStr(resp, "id", "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/vega-videos/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    const url = str(pick(resp, "content.video_url"));
    // options.return_last_frame=true 时结果附尾帧图片（文档 338-339 行），放 extras 与主视频分开
    const last = str(pick(resp, "content.last_frame_url"));
    return result(normalizeState(resp["status"]), url ? [url] : [], resp, last && last !== url ? [last] : []);
  },
};

// ---------------------------------------------------------------- 3D

const HY_3D_PRO = ["hy-3d-3.0", "hy-3d-3.1"];

const HY_3D: FamilySpec = {
  id: "hy-3d",
  kind: "3d",
  maxPromptChars: 1024,
  models: ["hy-3d-3.0", "hy-3d-3.1", "hy-3d-express"],
  sync: false,
  params: [
    S("prompt", T("文生 3D 提示词（≤1024 字符；与图片三选一，Sketch 模式可同传）", "Text-to-3D prompt (<=1024 chars; one of prompt/image, Sketch allows both)")),
    S("image_base64", T("输入图 Base64（可传本地文件；128~5000 边、≤6M）", "Input image Base64 (local file allowed; 128~5000 px, <=6M)"), { media: IMG("raw") }),
    S("image_url", T("输入图 URL（128~5000 边、≤8M）", "Input image URL (128~5000 px, <=8M)"), { media: IMG("urlOnly") }),
    A("multi_view_images", T("多视角参考图（每视角一张，总 <100M、单图 <8M）", "Multi-view images (one per view; total <100M, each <8M)"), {
      models: HY_3D_PRO,
      media: IMG("urlOnly", ["view_image_url"]),
      fields: [
        F("view_type", "string", T("视角", "View type"), { required: true, choices: ["left", "right", "back", "top", "bottom", "left_front", "right_front"] }),
        F("view_image_url", "string", T("该视角图片 URL（jpg/png）", "View image URL (jpg/png)"), { required: true }),
      ],
    }),
    B("enable_pbr", T("PBR 材质（默认 false；Geometry 不生效）", "PBR material (default false; not for Geometry)")),
    N("face_count", T("模型面数 [3000, 1500000]（默认 500000；LowPoly 不生效）", "Face count [3000, 1500000] (default 500000; not for LowPoly)"), { models: HY_3D_PRO }),
    S("generate_type", T("生成类型（默认 Normal；Sketch 允许提示词与图同传；3.1 不支持 LowPoly）", "Generation type (default Normal; Sketch allows prompt + image; LowPoly not on 3.1)"), {
      choices: ["Normal", "LowPoly", "Geometry", "Sketch"],
      models: HY_3D_PRO,
    }),
    S("polygon_type", T("多边形类型（默认 triangle；仅 LowPoly）", "Polygon type (default triangle; LowPoly only)"), { choices: ["triangle", "quadrilateral"], models: ["hy-3d-3.0"] }),
    // 服务端只认大写（传 stl 报「ResultFormat为stl，不在支持的模型格式列表[OBJ, GLB, STL, FBX, USDZ…]」）
    S("result_format", T("导出格式（3.0/3.1：额外 STL/USDZ/FBX；express：OBJ/GLB/STL/USDZ/FBX/MP4 任选其一）", "Export format (3.0/3.1: extra STL/USDZ/FBX; express: one of OBJ/GLB/STL/USDZ/FBX/MP4)"), {
      choices: ["STL", "USDZ", "FBX", "OBJ", "GLB", "MP4"],
    }),
    B("enable_geometry", T("单几何白模（默认 false；开启时不支持 OBJ，默认 GLB）", "Geometry-only white model (default false; no OBJ, defaults to GLB)"), { models: ["hy-3d-express"] }),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/137181",
  validateBody: (body) => {
    const hasImage = has(body, "image_url") || has(body, "image_base64");
    if (has(body, "image_url") && has(body, "image_base64")) return t("gen.rule.hy3d.onlyOneImage");
    if (!hasImage && !has(body, "prompt")) return t("gen.rule.hy3d.needInput");
    if (body["generate_type"] === "LowPoly" && str(body["model"]) === "hy-3d-3.1") return t("gen.rule.hy3d.noLowPoly");
    // pro（3.0/3.1）result_format 仅 STL/USDZ/FBX（obj/glb 为默认返回格式，MP4 仅 express 支持）
    if (body["result_format"] === "MP4" && str(body["model"]) !== "hy-3d-express") return t("gen.rule.hy3d.resultFormat");
    if (hasImage && has(body, "prompt") && body["generate_type"] !== "Sketch") {
      return t("gen.rule.hy3d.promptImageExclusive");
    }
    return undefined;
  },
  taskIdOf: (resp) => firstStr(resp, "id"),
  query: (model, id) => ({ method: "POST", path: "/v1/api/3d/query", body: { model, id } }),
  parse: (resp) => result(normalizeState(resp["status"]), urlsOf(resp["data"]), resp, urlsOf(resp["data"], "preview_image_url")),
};

/** 世界模型 360° 全景（同步） */
const WORLD2_PANORAMA: FamilySpec = {
  id: "hy-world2-panorama",
  maxPromptChars: 600,
  kind: "3d",
  models: ["hy-world2-panorama"],
  sync: true,
  params: [
    PROMPT(T("场景文本描述（≤600 字符）", "Scene description (<=600 chars)")),
    S("image_url", T("参考图（公网 URL，≥512×512、≤10M）", "Reference image (public URL, >=512x512, <=10M)"), { media: IMG("urlOnly") }),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/136578",
  parse: (resp) => {
    // 同步接口仍回 status，业务失败可能落在 HTTP 200 下
    const status = String(resp["status"] ?? "").trim().toLowerCase();
    if (status && status !== "succeeded") {
      return { state: "failed", urls: [], extraUrls: [], error: t("gen.result.statusFailed", { status }) };
    }
    const item = (Array.isArray(resp["data"]) ? resp["data"][0] : undefined) as Obj | undefined;
    const sr = str(item?.["super_resolution_image_url"]);
    const cover = str(item?.["cover_image_url"]);
    const main = sr ?? cover;
    if (!main) return { state: "failed", urls: [], extraUrls: [], error: errorOf(resp) ?? t("gen.result.noImage") };
    return { state: "succeeded", urls: [main], extraUrls: cover && cover !== sr ? [cover] : [] };
  },
};

/** 世界模型交互式 3D 场景（异步）：文本或单张参考图 → 可漫游场景 */
const WORLD2_SCENE: FamilySpec = {
  id: "hy-world2-scene",
  maxPromptChars: 600,
  kind: "3d",
  models: ["hy-world2-scene"],
  sync: false,
  params: [
    S("prompt", T("场景文本描述（≤600 字符；与 image_url 二选一）", "Scene description (<=600 chars; either this or image_url)")),
    S("image_url", T("公网图片 URL（≥512×512、≤10M；与 prompt 二选一）", "Public image URL (>=512x512, <=10M; either this or prompt)"), { media: IMG("urlOnly") }),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/136578",
  validateBody: (body) => exactlyOne(body, ["prompt", "image_url"], "world2-scene"),
  taskIdOf: (resp) => firstStr(resp, "id", "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/hunyuan-video/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    const item = (Array.isArray(resp["data"]) ? resp["data"][0] : undefined) as Obj | undefined;
    // 场景一个结果携带多个文件：模型（3DGS / 点云 / 碰撞网格）+ 预览图 + 空间元数据
    const urls = ["scene_url", "point_url", "mesh_url", "mesh_simplified_url"]
      .map((f) => str(item?.[f]))
      .filter((u): u is string => Boolean(u));
    const extras = ["image_url", "super_resolution_image_url"]
      .map((f) => str(item?.[f]))
      .filter((u): u is string => Boolean(u));
    const meta: Record<string, string> = {};
    for (const f of ["position_info", "air_wall"]) {
      const value = item?.[f];
      if (value !== undefined && value !== null) meta[f] = typeof value === "string" ? value : JSON.stringify(value);
    }
    return {
      ...result(normalizeState(resp["status"]), urls, resp, extras),
      meta: Object.keys(meta).length ? meta : undefined,
    };
  },
};

// ---------------------------------------------------------------- 音频域

/** 音频格式 → MIME（hex 结果转 data URL 时用） */
const AUDIO_FORMAT_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  pcm: "audio/pcm",
  pcmu_raw: "audio/pcm",
  pcmu_wav: "audio/wav",
  opus: "audio/opus",
};

/** 音频结果归一：URL 原样；hex 转 data URL，让下载层统一按 URL 处理 */
function audioOf(raw: unknown, format?: unknown): string | undefined {
  const text = str(raw);
  if (!text) return undefined;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
    const mime = AUDIO_FORMAT_MIME[str(format ?? "") ?? ""] ?? "audio/mpeg";
    return `data:${mime};base64,${Buffer.from(text, "hex").toString("base64")}`;
  }
  return undefined;
}

/** MiniMax 家族 base_resp 信封：status_code 非 0 即业务失败，返回错误文案 */
function minimaxErrorOf(resp: Obj): string | undefined {
  const base = resp["base_resp"] as Obj | undefined;
  if (base && base["status_code"] !== undefined && base["status_code"] !== null && Number(base["status_code"]) !== 0) {
    return errorOf(resp) ?? `base_resp status_code=${String(base["status_code"])}`;
  }
  return undefined;
}

/** 同步音频族的失败收口（信封失败 / 无结果） */
function audioFailed(resp: Obj, fallback: string): TaskResult {
  return { state: "failed", urls: [], extraUrls: [], error: minimaxErrorOf(resp) ?? errorOf(resp) ?? fallback };
}

/** 语音识别：同步直转与异步转写两个接口（参数见 APIS） */
const ASR: FamilySpec = {
  id: "asr",
  kind: "audio",
  models: ["hy-asr-3.0-preview", "wand-asr-v1"],
  sync: false,
  // 族内同步 / 异步接口覆盖 Hy 与 WAND 两家：四份文档全部列出（编号取自文档站语音识别分类页）
  doc: [
    "https://cloud.tencent.com/document/product/1823/135791",
    "https://cloud.tencent.com/document/product/1823/135792",
    "https://cloud.tencent.com/document/product/1823/135793",
    "https://cloud.tencent.com/document/product/1823/135794",
  ],
  taskIdOf: (resp) => firstStr(resp, "id", "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/asrproxy/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    // 异步转写的查询响应带 status（queued / in_progress / completed / failed），未完成时还没有 output；同步直转不带 status
    const state = resp["status"] === undefined ? "succeeded" : normalizeState(resp["status"]);
    if (state !== "succeeded") return result(state, [], resp);
    const out = (resp["output"] ?? {}) as Obj;
    const text = str(out["text"]);
    const subtitleUrl = str(out["subtitle_url"]);
    if (!text && !subtitleUrl) return audioFailed(resp, t("gen.result.noText"));
    const source = str(out["source"]);
    return {
      state: "succeeded",
      urls: subtitleUrl ? [subtitleUrl] : [],
      extraUrls: [],
      texts: text ? [text] : [],
      meta: source ? { language: source } : undefined,
    };
  },
};

const ASR_SOURCE = S("source", T("识别语种（缺省自动检测）", "Source language (auto-detected if absent)"));

const ASR_SYNC_PARAMS: ParamSpec[] = [
  S("input_url", T("音视频文件公网 URL（≤100MB / ≤30 分钟；与 data 二选一）", "Audio/video public URL (<=100MB / <=30min; either this or data)"), { media: MEDIA("urlOnly") }),
  S("data", T("音频 Base64（可传本地文件，≤75MB；与 input_url 二选一）", "Audio Base64 (local file allowed, <=75MB; either this or input_url)"), { media: MEDIA("raw", undefined, { maxBytes: 75_000_000 }) }),
  ASR_SOURCE,
  S("voice_encode_format", T("音频编码（如 pcm/wav/mp3，缺省 auto）", "Audio encoding (e.g. pcm/wav/mp3, default auto)")),
];

const ASR_ASYNC_PARAMS: ParamSpec[] = [
  S("input_url", T("音视频文件公网 URL（≤10 小时 / 10GB）", "Audio/video public URL (<=10h / 10GB)"), { required: true, media: MEDIA("urlOnly") }),
  ASR_SOURCE,
  S("subtitle_format", T("字幕格式（缺省 srt）", "Subtitle format (default srt)"), { choices: ["srt", "vtt"] }),
];

/** 语音合成（MiniMax TTS 六模型共用 sync_tts） */
const TTS: FamilySpec = {
  id: "minimax-tts",
  vendor: "minimax",
  maxPromptChars: 10000,
  kind: "audio",
  models: ["minimax-speech-2.8-hd", "minimax-speech-2.8-turbo", "minimax-speech-2.6-hd", "minimax-speech-2.6-turbo", "minimax-speech-02-hd", "minimax-speech-02-turbo"],
  sync: true,
  params: [
    S("text", T("待合成文本（<10000 字符，支持停顿 / 发音标签）", "Text to synthesize (<10000 chars; pause / pronunciation tags)"), { required: true }),
    O("voice_setting", T("音色设置", "Voice settings"), [
      F("voice_id", "string", T("音色 ID", "Voice ID"), { required: true }),
      F("speed", "number", T("语速", "Speed"), { min: 0.5, max: 2 }),
      F("vol", "number", T("音量", "Volume"), { min: 0, max: 10 }),
      F("pitch", "integer", T("音调", "Pitch"), { min: -12, max: 12 }),
      F("emotion", "string", T("情感（2.8-hd / 2.8-turbo 不支持 whisper）", "Emotion (whisper is unsupported on 2.8-hd / 2.8-turbo)"), { choices: ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent", "whisper"] }),
      F("text_normalization", "boolean", T("数字 / 符号标准化", "Number/symbol normalization")),
      F("latex_read", "boolean", T("LaTeX 朗读", "Read LaTeX")),
    ], { required: true }),
    O("audio_setting", T("音频设置", "Audio settings"), [
      F("sample_rate", "integer", T("采样率", "Sample rate"), { choices: [8000, 16000, 22050, 24000, 32000, 44100] }),
      F("bitrate", "integer", T("码率", "Bitrate"), { choices: [32000, 64000, 128000, 256000] }),
      F("format", "string", T("格式", "Format"), { choices: ["mp3", "pcm", "flac", "wav", "pcmu_raw", "pcmu_wav", "opus"] }),
      F("channel", "integer", T("声道", "Channels"), { choices: [1, 2] }),
    ]),
    O("pronunciation_dict", T("发音词典", "Pronunciation dictionary"), [
      F("tone", "array", T("发音规则（字符串数组，格式 原文/替换内容，如 [\"处理/(chu3)(li3)\"]）", 'Rules (string array of original/replacement, e.g. ["处理/(chu3)(li3)"])')),
    ]),
    A("timbre_weights", T("混合音色权重（最多 4 种）", "Timbre blending weights (up to 4)"), {
      fields: [
        F("voice_id", "string", T("音色 ID", "Voice ID"), { required: true }),
        F("weight", "integer", T("权重", "Weight"), { required: true, min: 1, max: 100 }),
      ],
    }),
    S("language_boost", T("小语种 / 方言识别增强（可设 auto）", "Language boost (minor languages / dialects; auto allowed)")),
    O("voice_modify", T("声音效果器", "Voice effects"), [
      F("pitch", "integer", T("音调修饰", "Pitch shift"), { min: -100, max: 100 }),
      F("intensity", "integer", T("强度修饰", "Intensity"), { min: -100, max: 100 }),
      F("timbre", "integer", T("音色修饰", "Timbre shift"), { min: -100, max: 100 }),
      F("sound_effects", "string", T("音效", "Sound effects"), { choices: ["spacious_echo", "auditorium_echo", "lofi_telephone", "robotic"] }),
    ]),
    B("subtitle_enable", T("开启字幕（默认 false）", "Enable subtitles (default false)")),
    S("subtitle_type", T("字幕粒度（默认 sentence）", "Subtitle granularity (default sentence)"), { choices: ["sentence", "word"] }),
    S("output_format", T("返回形式：url 由 CLI 直接下载，长音频不受响应体上限限制；hex 内联 base64，长文本可能报 response size too large", "Output form: url is downloaded directly and long audio stays within the response limit; hex inlines base64 and may hit response size too large"), { choices: ["hex", "url"], default: "url" }),
    B("aigc_watermark", T("末尾添加音频节奏标识（默认 false）", "Append an audio watermark (default false)")),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135796",
  parse: (resp) => {
    const envError = minimaxErrorOf(resp);
    if (envError) return { state: "failed", urls: [], extraUrls: [], error: envError };
    const data = (resp["data"] ?? {}) as Obj;
    const info = (resp["extra_info"] ?? {}) as Obj;
    const url = audioOf(data["audio"], info["audio_format"]);
    const subtitleFile = str(data["subtitle_file"]);
    if (!url) return audioFailed(resp, t("gen.result.noAudio"));
    return { state: "succeeded", urls: [url], extraUrls: subtitleFile ? [subtitleFile] : [] };
  },
};

/** 声音克隆（同步）：参考音频 → 可复用 voice_id + 试听音频 */
const VOICE_CLONE: FamilySpec = {
  id: "minimax-voice-clone",
  vendor: "minimax",
  kind: "audio",
  models: ["minimax-voice-clone"],
  sync: true,
  params: [
    S("audio_url", T("待复刻音频公网 URL（与 audio_data 二选一；mp3/m4a/wav，建议 10 秒~5 分钟，≤20MB）", "Source audio public URL (either this or audio_data; mp3/m4a/wav, 10s~5min recommended, <=20MB)"), { media: MEDIA("urlOnly") }),
    S("audio_data", T("待复刻音频 Base64（可传本地文件：mp3/m4a/wav，≤20MB；与 audio_url 二选一）", "Source audio Base64 (local file allowed: mp3/m4a/wav, <=20MB; either this or audio_url)"), {
      media: MEDIA("raw", undefined, { formats: ["mp3", "m4a", "wav"], maxBytes: 20_000_000 }),
    }),
    N("file_id", T("已上传复刻音频的文件 ID（与 audio_url / audio_data 三选一）", "Uploaded source-audio file ID (one of audio_url / audio_data / file_id)")),
    S("tts_model", T("试听用的语音合成模型（minimax-speech-*）", "Preview TTS model (minimax-speech-*)")),
    S("voice_id", T("自定义音色 ID（不传自动生成）", "Custom voice ID (auto-generated if absent)")),
    S("text", T("试听文本（≤1000 字符）", "Preview text (<=1000 chars)")),
    S("text_validation", T("样本预期文本（≤200 字符）", "Expected text of the sample (<=200 chars)")),
    N("accuracy", T("ASR 相似度阈值（默认 0.7）", "ASR similarity threshold (default 0.7)")),
    S("output_format", T("试听音频返回形式", "Preview audio form"), { choices: ["hex", "url"], default: "url" }),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135798",
  validateBody: (body) =>
    ["audio_url", "audio_data", "file_id"].every((k) => !has(body, k))
      ? t("gen.check.needOne", { what: "voice clone", flags: "--audio-url / --audio-data / --file-id" })
      : undefined,
  parse: (resp) => {
    const envError = minimaxErrorOf(resp);
    if (envError) return { state: "failed", urls: [], extraUrls: [], error: envError };
    const voiceId = str(resp["voice_id"]);
    if (!voiceId) return audioFailed(resp, t("gen.result.noVoiceId"));
    const url = audioOf(resp["demo_audio"]);
    return { state: "succeeded", urls: url ? [url] : [], extraUrls: [], meta: { voice_id: voiceId } };
  },
};

/** 声音设计（同步）：自然语言描述 → voice_id + 试听音频 */
const VOICE_DESIGN: FamilySpec = {
  id: "minimax-voice-design",
  vendor: "minimax",
  kind: "audio",
  models: ["minimax-voice-design"],
  sync: true,
  params: [
    PROMPT(T("音色描述（性别 / 年龄 / 特征 / 情绪 / 场景）", "Voice description (gender / age / traits / mood / scene)")),
    S("preview_text", T("试听文本（≤500 字符）", "Preview text (<=500 chars)"), { required: true }),
    S("voice_id", T("自定义音色 ID（不传自动生成）", "Custom voice ID (auto-generated if absent)")),
    S("output_format", T("试听音频返回形式", "Preview audio form"), { choices: ["hex", "url"], default: "url" }),
    B("aigc_watermark", T("末尾添加音频节奏标识（默认 false）", "Append an audio watermark (default false)")),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135797",
  parse: (resp) => {
    const envError = minimaxErrorOf(resp);
    if (envError) return { state: "failed", urls: [], extraUrls: [], error: envError };
    const voiceId = str(resp["voice_id"]);
    if (!voiceId) return audioFailed(resp, t("gen.result.noVoiceId"));
    const url = audioOf(resp["trial_audio"]);
    return { state: "succeeded", urls: url ? [url] : [], extraUrls: [], meta: { voice_id: voiceId } };
  },
};

/** AI 配音（异步）：视频输入 → 翻译配音视频 */
const DUB: FamilySpec = {
  id: "wand-dubbing",
  kind: "audio",
  models: ["wand-dubbing-clone-v1", "wand-dubbing-clone-v2"],
  sync: false,
  params: [
    // 文档：支持 URL 或 Base64（Base64 须带 data:video/<格式>;base64, 前缀）
    S("input_url", T("待配音视频（URL 或本地文件；mp4/mov/m4v，≤45 分钟；本地文件 ≤75MB，URL ≤1GB）", "Source video (URL or local file; mp4/mov/m4v, <=45 min; local file <=75MB, URL <=1GB)"), {
      required: true,
      media: MEDIA("dataUrl", undefined, { formats: ["mp4", "mov", "m4v"], maxBytes: 75_000_000 }),
    }),
    S("src_language", T("源语言代码（默认 zh）", "Source language code (default zh)")),
    S("dst_language", T("目标语言代码（默认 en）", "Target language code (default en)")),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135800",
  taskIdOf: (resp) => firstStr(resp, "id", "task_id"),
  query: (_m, id) => ({ method: "GET", path: `/v1/wand/dubbing/tasks/${encodeURIComponent(id)}` }),
  parse: (resp) => {
    const out = (resp["output"] ?? {}) as Obj;
    const url = str(out["result_url"]);
    return result(normalizeState(resp["status"]), url ? [url] : [], resp);
  },
};

/** 音乐生成 MiniMax（同步） */
const MINIMAX_MUSIC: FamilySpec = {
  id: "minimax-music",
  vendor: "minimax",
  maxPromptChars: 2000,
  kind: "audio",
  models: ["minimax-music-v3.0", "minimax-music-v2.6"],
  sync: true,
  params: [
    S("prompt", T("音乐描述（纯音乐时必填，≤2000 字符）", "Music description (required for instrumental, <=2000 chars)")),
    S("lyrics", T("歌词（人声歌曲必填，≤3500 字符，带 [Verse] 等标签）", "Lyrics (required for vocal songs, <=3500 chars, with tags like [Verse])")),
    B("lyrics_optimizer", T("按 prompt 自动写词（默认 false）", "Write lyrics from the prompt (default false)")),
    B("is_instrumental", T("纯音乐（默认 false）", "Instrumental (default false)")),
    S("output_format", T("返回形式：url 避免长音频 base64 超限", "Output form: url avoids base64 size limits on long audio"), { choices: ["hex", "url"], default: "url" }),
    O("audio_setting", T("音频输出配置", "Audio output settings"), [
      F("sample_rate", "integer", T("采样率", "Sample rate"), { choices: [16000, 24000, 32000, 44100] }),
      F("bitrate", "integer", T("码率", "Bitrate"), { choices: [32000, 64000, 128000, 256000] }),
      F("format", "string", T("格式", "Format"), { choices: ["mp3", "wav", "pcm"] }),
    ]),
    B("aigc_watermark", T("音频末尾加水印（默认 false）", "Append an audio watermark (default false)")),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/135323",
  validateBody: (body) => {
    if (body["is_instrumental"] === true) return has(body, "prompt") ? undefined : t("gen.rule.minimaxMusic.instrumental");
    if (body["lyrics_optimizer"] === true) return has(body, "prompt") ? undefined : t("gen.rule.minimaxMusic.optimizer");
    if (!has(body, "lyrics")) return t("gen.rule.minimaxMusic.needLyrics");
    const len = [...(str(body["lyrics"]) ?? "")].length;
    if (len > MINIMAX_MUSIC_LYRICS_MAX) return t("gen.rule.minimaxMusic.lyricsTooLong", { len, max: MINIMAX_MUSIC_LYRICS_MAX });
    return undefined;
  },
  parse: (resp) => {
    const envError = minimaxErrorOf(resp);
    if (envError) return { state: "failed", urls: [], extraUrls: [], error: envError };
    const data = (resp["data"] ?? {}) as Obj;
    const url = audioOf(data["audio"]);
    if (!url) return audioFailed(resp, t("gen.result.noAudio"));
    return { state: "succeeded", urls: [url], extraUrls: [] };
  },
};

/** Mureka 歌词上限 */
const MUREKA_LYRICS_MAX = 5000;

/** MiniMax 音乐歌词上限 */
const MINIMAX_MUSIC_LYRICS_MAX = 3500;

/**
 * 音乐生成 Mureka（同步）：目前只支持歌词成曲，--lyrics 必填。
 * 服务端对所有请求都要求 lyrics（缺了返回 "Lyrics is required"），提示词成曲不可用；纯音乐经确认暂不支持，不提供开关。
 * 歌词成曲的风格提示词上限 1024 字符（maxPromptChars）。
 */
const MUREKA_MUSIC: FamilySpec = {
  id: "mureka-music",
  maxPromptChars: 1024,
  kind: "audio",
  models: ["mureka-music-v9"],
  sync: true,
  params: [
    S("lyrics", T("歌词（≤5000 字符，可用 [Verse]/[Chorus] 等分段标签）", "Lyrics (<=5000 chars, section tags like [Verse]/[Chorus])"), { required: true }),
    S("prompt", T("风格提示词（≤1024 字符，如 pop, emotional, female vocal）", "Style prompt (<=1024 chars, e.g. pop, emotional, female vocal)")),
    S("gender", T("人声性别倾向", "Vocal gender"), { choices: ["female", "male"] }),
    N("n", T("生成数量 [1, 3]（默认 2，按量计费）", "Track count [1, 3] (default 2, billed per track)")),
  ],
  doc: "https://cloud.tencent.com/document/product/1823/138805",
  requestNote: T(
    '目前只支持歌词成曲（--lyrics 必填，只传提示词会返回 Lyrics is required）：\n--lyrics $\'[Verse]\\n夏天的风\\n[Chorus]\\n吹过海边\' --prompt "pop, emotional, female vocal" --n 1\n纯音乐：thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --prompt "轻快的钢琴曲" --is-instrumental true\n无歌词成曲（自动写词）：thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --prompt "夏日情歌" --lyrics-optimizer true',
    'Only songs from lyrics are supported for now (--lyrics is required; a prompt alone returns "Lyrics is required"):\n--lyrics $\'[Verse]\\nsummer breeze\\n[Chorus]\\nover the sea\' --prompt "pop, emotional, female vocal" --n 1\nInstrumental: thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --prompt "light piano" --is-instrumental true\nSong without lyrics (auto-written): thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --prompt "summer love song" --lyrics-optimizer true',
  ),
  validateBody: (body) => {
    const lyrics = str(body["lyrics"]) ?? "";
    if ([...lyrics].length > MUREKA_LYRICS_MAX) return t("gen.rule.mureka.lyricsTooLong", { len: [...lyrics].length, max: MUREKA_LYRICS_MAX });
    const n = body["n"];
    if (n !== undefined && !(Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 3)) return t("gen.rule.mureka.badN", { n: JSON.stringify(n) });
    return undefined;
  },
  parse: (resp) => syncResult(urlsOf(resp["choices"]), resp),
};

/** 全部模型族 */
export const FAMILIES: FamilySpec[] = [
  HY_IMAGE_V3,
  HY_IMAGE_V35,
  SEEDREAM,
  WAND_IMAGE,
  VIDU_IMAGE,
  KLING_IMAGE,
  HY_VIDEO,
  KLING_VIDEO,
  KLING_VIDEO_OMNI,
  KLING_MOTION_CONTROL,
  VIDU_VIDEO,
  PIXVERSE,
  MINIMAX_V1,
  MINIMAX_V2,
  WAND_VIDEO,

  HY_3D,
  WORLD2_PANORAMA,
  WORLD2_SCENE,
  ASR,
  TTS,
  VOICE_CLONE,
  VOICE_DESIGN,
  DUB,
  MINIMAX_MUSIC,
  MUREKA_MUSIC,
];

/** 按模型 ID 找族；kind 给了就只在该类别里找 */
export function familyOf(model: string): FamilySpec | undefined {
  return FAMILIES.find((f) => f.models.includes(model));
}

// ---------------------------------------------------------------- 参数解析与校验

/** 校验单个子字段：类型 / 枚举 / 范围，返回错误文案 */
function checkField(path: string, field: ParamField, value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return field.required ? t("gen.check.required", { path }) : undefined;
  }
  if (field.type === "json" || field.type === "object" || field.type === "array") return undefined;
  if (field.type === "boolean" && typeof value !== "boolean") return t("gen.check.boolean", { path });
  if (field.type === "integer" && !Number.isInteger(value)) return t("gen.check.integer", { path });
  if (field.type === "number" && typeof value !== "number") return t("gen.check.number", { path });
  if (field.type === "string" && typeof value !== "string") return t("gen.check.string", { path });
  if (field.choices && !field.choices.includes(value as never)) return t("gen.check.choices", { path, choices: field.choices.join(", ") });
  if (field.min !== undefined && (value as number) < field.min) return t("gen.check.min", { path, min: field.min });
  if (field.max !== undefined && (value as number) > field.max) return t("gen.check.max", { path, max: field.max });
  return undefined;
}

/** 校验一个对象（对象参数本身，或对象数组的一个元素） */
function checkObject(label: string, fields: ParamField[], item: unknown): void {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(t("gen.check.notObject", { label }));
  }
  for (const [key, value] of Object.entries(item as Obj)) {
    const field = fields.find((x) => x.key === key);
    if (!field) {
      throw new Error(t("gen.check.unknownField", { label, key, allowed: fields.map((x) => x.key).join(", ") }));
    }
    const err = checkField(`${label}.${key}`, field, value);
    if (err) throw new Error(err);
  }
  for (const field of fields) {
    if (field.required && (item as Obj)[field.key] === undefined) {
      throw new Error(t("gen.check.missingField", { label, key: field.key }));
    }
  }
}

/**
 * 解析并校验 --<flag> 的值：
 *   value  → 标量（string 直通；其余 JSON 解析优先，choices 校验）
 *   object → JSON 对象，逐字段校验（未知字段 / 类型 / 枚举 / 范围 / 必填）
 *   array  → JSON 数组；字符串数组允许直接给单个值（--images a.png 等价于 '["a.png"]'）
 */
export function parseParamValue(spec: ParamSpec, raw: string): unknown {
  const label = `--${spec.flag}`;
  if (spec.kind === "value") {
    let value: unknown = raw;
    // string 直通：避免 "123"/"true" 被 JSON.parse 转成 number/boolean 导致类型漂移
    if (spec.valueType !== "string") {
      try {
        value = parseJsonSafe(raw);
      } catch {
        // 不是 JSON 就当字符串
      }
    }
    if (spec.valueType === "boolean" && typeof value !== "boolean") {
      throw new Error(t("gen.check.expectBoolean", { label, raw }));
    }
    if (spec.valueType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(t("gen.check.expectNumber", { label, raw }));
    }
    if (spec.choices && !spec.choices.some((c) => String(c) === String(value))) {
      throw new Error(t("gen.check.choices", { path: label, choices: spec.choices.join(", ") }));
    }
    return value;
  }
  const trimmed = raw.trim();
  if (spec.kind === "array" && !spec.fields && !trimmed.startsWith("[")) {
    return [raw];
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(trimmed);
  } catch {
    const example = spec.kind === "array" ? `'[...]'` : `'{...}'`;
    throw new Error(t("gen.check.badJson", { label, example, raw }));
  }
  if (spec.kind === "object") {
    checkObject(label, spec.fields ?? [], parsed);
    return parsed;
  }
  if (!Array.isArray(parsed)) {
    throw new Error(t("gen.check.notArray", { label }));
  }
  if (spec.fields) {
    parsed.forEach((item, i) => checkObject(`${label}[${i}]`, spec.fields!, item));
  }
  return parsed;
}

/** commander 写法（值一律带参，便于校验） */
export function paramFlagSyntax(p: ParamSpec): string {
  if (p.kind !== "value") return `--${p.flag} <json>`;
  if (p.valueType === "boolean") return `--${p.flag} <true|false>`;
  if (p.valueType === "number") return `--${p.flag} <number>`;
  return `--${p.flag} <value>`;
}

/** 按当前语言取双语文本 */
export function paramText(p: ParamText): string {
  return lang() === "zh" ? p.zh : p.en;
}

/** 子字段的 JSON 形状示意：{"type":…,"image_url":{"url":…}} */
function shapeOf(fields: ParamField[] | undefined): string {
  if (!fields?.length) return "…";
  return fields
    .map((f) => {
      if (f.type === "object") return `"${f.key}":{${shapeOf(f.fields)}}`;
      if (f.type === "array") return f.fields?.length ? `"${f.key}":[{${shapeOf(f.fields)}}]` : `"${f.key}":["…"]`;
      return `"${f.key}":…`;
    })
    .join(",");
}

/** 参数用法行：--images '["…","…"]' / --settings '{"aspect_ratio":…}' / --style <general|anime> */
export function paramUsage(p: ParamSpec): string {
  if (p.kind === "array") {
    return p.fields?.length ? `--${p.flag} '[{${shapeOf(p.fields)}}]'` : `--${p.flag} '["…","…"]'`;
  }
  if (p.kind === "object") return `--${p.flag} '{${shapeOf(p.fields)}}'`;
  if (p.choices) return `--${p.flag} <${p.choices.join("|")}>`;
  if (p.valueType === "boolean") return `--${p.flag} <true|false>`;
  if (p.valueType === "number") return `--${p.flag} <number>`;
  return `--${p.flag} <string>`;
}

/** 参数是否对该模型必填 */
export function isRequired(p: ParamSpec, model?: string): boolean {
  if (p.required === true) return true;
  return Array.isArray(p.required) && (model === undefined ? false : p.required.includes(model));
}

/** 子字段树（缩进行） */
function fieldLines(fields: ParamField[], indent: string, zh: boolean): string[] {
  const sep = zh ? "，" : ", ";
  return fields.flatMap((f) => {
    const type = f.type === "integer" || f.type === "number" ? "number" : f.type;
    const range = f.choices ? f.choices.join("|") : f.min !== undefined || f.max !== undefined ? `${f.min ?? "-∞"}~${f.max ?? "∞"}` : "";
    const req = f.required ? (zh ? "，必填" : ", required") : "";
    const line = `${indent}${f.key.padEnd(Math.max(20 - indent.length + 2, 1))} ${type.padEnd(7)} ${[paramText(f.desc), range].filter(Boolean).join(sep)}${req}`;
    return [line, ...(f.fields?.length ? fieldLines(f.fields, `${indent}  `, zh) : [])];
  });
}

/** help 文本：说明 + 必填 / 适用模型 / 本地文件提示 + 子字段树 */
export function paramHelpText(p: ParamSpec): string {
  const zh = lang() === "zh";
  const notes: string[] = [];
  if (p.required === true) notes.push(zh ? "必填" : "required");
  else if (Array.isArray(p.required)) notes.push(zh ? `${p.required.join(" / ")} 必填` : `required for ${p.required.join(" / ")}`);
  if (p.default !== undefined) notes.push(zh ? `默认 ${String(p.default)}` : `default ${String(p.default)}`);
  if (p.models) notes.push(zh ? `仅 ${p.models.join(" / ")}` : `${p.models.join(" / ")} only`);
  if (p.media) {
    const specs = Array.isArray(p.media) ? p.media : [p.media];
    const anyLocal = specs.some((m) => m.encoding !== "urlOnly");
    notes.push(
      anyLocal
        ? zh ? "可传本地文件，自动编码" : "local files are encoded automatically"
        : zh ? "仅公网 URL" : "public URL only",
    );
  }
  // 说明末尾已有括号时并进去（「参考图（≤10 张；必填）」），没有再加一对
  const desc = paramText(p.desc);
  let head = desc;
  if (notes.length) {
    const close = zh ? "）" : ")";
    const joined = notes.join(zh ? "；" : "; ");
    head = desc.endsWith(close) ? `${desc.slice(0, -1)}${zh ? "；" : "; "}${joined}${close}` : zh ? `${desc}（${joined}）` : `${desc} (${joined})`;
  }
  return [head, ...fieldLines(p.fields ?? [], "  ", zh)].join("\n");
}

/**
 * 把 --param 解析成对象（键支持点路径：settings.audio=native）：
 *   key=value    值一律是字符串（--param id=123 → "123"）
 *   key:=json    值按 JSON 解析（--param n:=2 / flag:=true / cfg:='{"a":1}' / l:='[1,2]'）
 */
export function parseParams(pairs: string[]): Obj {
  const out: Obj = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const isJson = eq > 0 && pair[eq - 1] === ":";
    const key = pair.slice(0, isJson ? eq - 1 : eq).trim();
    if (eq <= 0 || !key) {
      throw new Error(t("gen.check.paramSyntax", { pair }));
    }
    const raw = pair.slice(eq + 1);
    let value: unknown = raw;
    if (isJson) {
      try {
        value = parseJsonSafe(raw);
      } catch {
        throw new Error(t("gen.check.paramJson", { key, raw }));
      }
    }
    setPath(out, key, value);
  }
  return out;
}

/** JSON.parse，并在任意嵌套层级剔除会改写原型链的键（防原型污染） */
export function parseJsonSafe(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => (UNSAFE_KEYS.has(key) ? undefined : value));
}

export function setPath(obj: Obj, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  const bad = keys.find((k) => UNSAFE_KEYS.has(k) || k === "");
  if (bad !== undefined) {
    throw new Error(t("gen.check.badKeyPath", { path: dotted }));
  }
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object" || Array.isArray(cur[k])) {
      cur[k] = {};
    }
    cur = cur[k] as Obj;
  }
  cur[keys[keys.length - 1]!] = value;
}

/**
 * 对字段值里承载文件的位置逐个调用 fn（值本身 / 字符串数组 / 对象（数组）的子路径，数组逐项展开）。
 * 返回替换后的新值，原值不改。
 */
export function mapMedia(value: unknown, keys: string[] | undefined, fn: (s: string) => string): unknown {
  const walk = (node: unknown, segs: string[]): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, segs));
    if (segs.length === 0) return typeof node === "string" ? fn(node) : node;
    if (node && typeof node === "object") {
      const [head, ...rest] = segs;
      const obj = node as Obj;
      if (head! in obj) return { ...obj, [head!]: walk(obj[head!], rest) };
    }
    return node;
  };
  if (!keys?.length) return walk(value, []);
  return keys.reduce((acc, k) => walk(acc, k.split(".")), value);
}

// ================================================================ 接口索引
/**
 * 接口（API）：+gen 命令层的唯一入口。
 * 接口 ID = path 去掉 /v1/ 前缀（/v1/wand/vidu/text-to-video → wand/vidu/text-to-video）。
 */
export interface ApiRef {
  /** 接口 ID（命令层入口） */
  id: string;
  /** 提交路径 */
  path: string;
  kind: MediaKind;
  /** 实现族（共享查询 / 解析逻辑） */
  family: FamilySpec;
  /** 该接口支持的模型白名单 */
  models: string[];
  /** 模型级差异说明（help 展示） */
  modelNote?: ParamText;
  /** 接口参数（请求体顶层字段；model 由 --model 统一传） */
  params: ParamSpec[];
  doc: string | string[];
  requestNote?: ParamText;
  /** 接口级校验（请求体合并后） */
  validateBody?(body: Obj): string | undefined;
  /** 同步接口：提交即返回结果（不轮询）。默认跟族走，个别接口覆盖（如 ASR 同步直转） */
  sync: boolean;
}

interface ApiDecl {
  id: string;
  family: FamilySpec;
  /** 多接口族的接口名 */
  apiName?: string;
  /** 提交路径缺省 = "/v1/" + id */
  path?: string;
  models?: string[];
  params?: ParamSpec[];
  modelNote?: ParamText;
  validateBody?(body: Obj): string | undefined;
  /** 覆盖族的 sync（同一族里有同步、异步两种接口时） */
  sync?: boolean;
}

const apiRefOf = (d: ApiDecl): ApiRef => {
  const ep = d.apiName ? d.family.apis?.[d.apiName] : undefined;
  return {
    id: d.id,
    path: d.path ?? `/v1/${d.id}`,
    kind: d.family.kind,
    family: d.family,
    models: d.models ?? ep?.models ?? d.family.models,
    modelNote: d.modelNote,
    params: d.params ?? ep?.params ?? d.family.params ?? [],
    doc: d.family.doc,
    requestNote: d.family.requestNote,
    validateBody: d.validateBody ?? ep?.validateBody,
    sync: d.sync ?? d.family.sync,
  };
};

/** 全部接口。顺序即 +gen apis 的展示顺序 */
export const APIS: ApiRef[] = [
  // ---- 图像 ----
  apiRefOf({ id: "wand/hunyuan-image/v3-generation", family: HY_IMAGE_V3 }),
  apiRefOf({ id: "wand/hunyuan-image/v35-generation", family: HY_IMAGE_V35 }),
  apiRefOf({ id: "wand/si-image/generation", family: SEEDREAM }),
  apiRefOf({ id: "wand/vega-images/generations", family: WAND_IMAGE }),
  apiRefOf({ id: "wand/vidu-image/generation", family: VIDU_IMAGE }),
  apiRefOf({
    id: "wand/kling-image/generation",
    family: KLING_IMAGE,
    modelNote: T(
      "模型差异：kling-image-v3 用 image（单张）并支持 negative_prompt（仅文生图）；kling-image-o1 / v3-omni 用 image_list（最多 10 张），组图 result_type=series 仅 v3-omni",
      "Model differences: kling-image-v3 uses image (single) and supports negative_prompt (text-to-image only); o1 / v3-omni use image_list (up to 10); result_type=series is v3-omni only",
    ),
  }),
  // ---- 视频 ----
  apiRefOf({ id: "wand/hunyuan-video/generation", family: HY_VIDEO }),
  apiRefOf({ id: "wand/kling/text-to-video", family: KLING_VIDEO, apiName: "text-to-video" }),
  apiRefOf({ id: "wand/kling/image-to-video", family: KLING_VIDEO, apiName: "image-to-video" }),
  apiRefOf({ id: "wand/kling/omni-video", family: KLING_VIDEO_OMNI, models: ["kling-video-v4", "kling-video-v3-omni", "kling-video-o1"] }),
  apiRefOf({ id: "wand/kling/motion-control", family: KLING_MOTION_CONTROL }),
  apiRefOf({ id: "wand/vidu/text-to-video", family: VIDU_VIDEO, apiName: "text-to-video" }),
  apiRefOf({ id: "wand/vidu/image-to-video", family: VIDU_VIDEO, apiName: "image-to-video" }),
  apiRefOf({ id: "wand/vidu/start-end-to-video", family: VIDU_VIDEO, apiName: "start-end-to-video" }),
  apiRefOf({ id: "wand/vidu/reference-to-video", family: VIDU_VIDEO, apiName: "reference-to-video" }),
  apiRefOf({ id: "wand/pixverse/text-to-video", family: PIXVERSE, apiName: "text-to-video" }),
  apiRefOf({ id: "wand/pixverse/image-to-video", family: PIXVERSE, apiName: "image-to-video" }),
  apiRefOf({ id: "wand/pixverse/start-end-to-video", family: PIXVERSE, apiName: "start-end-to-video" }),
  apiRefOf({ id: "wand/pixverse/reference-to-video", family: PIXVERSE, apiName: "reference-to-video" }),
  apiRefOf({ id: "wand/minimax-video/generation", family: MINIMAX_V1 }),
  apiRefOf({ id: "wand/minimax-video-v2/generation", family: MINIMAX_V2 }),
  apiRefOf({ id: "wand/vega-videos/tasks", family: WAND_VIDEO }),
  // ---- 3D ----
  apiRefOf({
    id: "api/3d/submit",
    family: HY_3D,
    modelNote: T(
      "模型差异：hy-3d-3.0 / 3.1 支持 generate_type、face_count、multi_view_images（3.1 不支持 LowPoly，polygon_type 仅 3.0）；hy-3d-express 支持 enable_geometry，result_format 含 MP4",
      "Model differences: 3.0 / 3.1 support generate_type, face_count, multi_view_images (no LowPoly on 3.1; polygon_type is 3.0 only); express supports enable_geometry and result_format MP4",
    ),
  }),
  apiRefOf({ id: "wand/hunyuan-image/world2-panorama", family: WORLD2_PANORAMA }),
  apiRefOf({ id: "wand/hunyuan-video/world2-scene", family: WORLD2_SCENE }),
  // ---- 语音 ----
  // ASR：同步 / 异步各是一个接口（path 不同）
  apiRefOf({
    id: "wand/asrproxy/sync_transcribe",
    family: ASR,
    params: ASR_SYNC_PARAMS,
    sync: true,
    validateBody: (body) => exactlyOne(body, ["input_url", "data"], "sync_transcribe"),
  }),
  apiRefOf({ id: "wand/asrproxy/async_create", family: ASR, params: ASR_ASYNC_PARAMS }),
  apiRefOf({ id: "wand/minimax-tts/sync_tts", family: TTS }),
  apiRefOf({ id: "wand/minimax-tts/sync_clone", family: VOICE_CLONE }),
  apiRefOf({ id: "wand/minimax-tts/sync_design", family: VOICE_DESIGN }),
  apiRefOf({ id: "wand/dubbing/async_generation", family: DUB }),
  apiRefOf({ id: "wand/minimax-music/generation", family: MINIMAX_MUSIC }),
  apiRefOf({ id: "wand/mureka-music/generation", family: MUREKA_MUSIC }),
];

/** 按接口 ID 找接口 */
export function apiOf(id: string): ApiRef | undefined {
  return APIS.find((e) => e.id === id);
}

/** 接口支持的模型里，model 是否在白名单内 */
export function apiSupportsModel(api: ApiRef, model: string): boolean {
  return api.models.includes(model);
}

/**
 * 请求体合并后的统一校验：适用模型 → 必填 → 提示词长度 → 接口 / 族级规则。
 * 返回错误文案；通过返回 undefined。
 */
export function checkBody(api: ApiRef, body: Obj): string | undefined {
  const model = str(body["model"]) ?? "";
  for (const p of api.params) {
    if (has(body, p.path) && p.models && !p.models.includes(model)) {
      return t("gen.check.modelOnly", { flag: p.flag, models: p.models.join(" / "), model });
    }
    // object 参数的子字段级模型限定（如 settings.audio 仅 V3 / V2.6）
    const obj = body[p.path];
    if (p.kind === "object" && p.fields && obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const f of p.fields) {
        if (f.models && has(obj as Obj, f.key) && !f.models.includes(model)) {
          return t("gen.check.modelOnly", { flag: `${p.flag}.${f.key}`, models: f.models.join(" / "), model });
        }
      }
    }
  }
  for (const p of api.params) {
    if (isRequired(p, model) && !has(body, p.path)) {
      return t("gen.check.flagRequired", { flag: p.flag, api: api.id });
    }
  }
  const max = api.family.maxPromptChars;
  for (const key of ["prompt", "text"]) {
    const value = body[key];
    if (max && typeof value === "string" && [...value].length > max) {
      return t("gen.check.tooLong", { key, len: [...value].length, max, model });
    }
  }
  return api.validateBody?.(body) ?? api.family.validateBody?.(body);
}
