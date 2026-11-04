/**
 * +chat 的消息内容构造：把 --input（可多个）与问题文本拼成各协议的 content。
 *
 * 平台没有文件上传接口（图片 / 视频理解文档 1823/136956、136957）：图片/视频只有两种传法——
 * 公网 URL（网关自己去下载）或 Base64 data URL 内联进请求体。所以"支持本地文件"的
 * 含义是 CLI 替用户编码，URL 则原样透传、绝不先下载再编码（那样既慢又会撞请求体上限）。
 *
 * 三种协议的块结构不同。图片的写法来自官方文档；视频只有 chat 一种写法在文档里
 * （1823/136957），另两种是 2026-10-02 用 kimi-k3、glm-5.3-flash 实测得到的：
 *   chat       图片 {type:"image_url",image_url:{url}}；视频 {type:"video_url",video_url:{url}}
 *   responses  图片 {type:"input_image",image_url:"<url>"}（扁平字符串）
 *              视频 {type:"input_video",video_url:"<url>"}——**因模型而异**：glm-5.3-flash 能看到，
 *              kimi-k3 返回 200 却回答"没收到视频"（静默丢弃），所以发出时给一条提示
 *   anthropic  图片 / 视频 {type:"image"|"video",source:{type:"base64"|"url",...}}，URL 与 Base64 都可用
 * URL 必须平台能下载到，否则网关返回 400001（与协议无关）。
 *
 * 纯函数（只读文件不发请求），便于单测；告警通过返回值交给命令层打印。
 */
import fs from "node:fs";
import path from "node:path";

import { t } from "./i18n.js";
import { expandHome } from "../util/expand-home.js";

/** body 结构的三种形状 */
export type PayloadShape = "chat" | "responses" | "anthropic";

/** 图片扩展名 → MIME */
export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/** 视频扩展名 → MIME */
export const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

/** 音频扩展名 → MIME（+gen audio 的 --input 本地文件用） */
export const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".pcm": "audio/pcm",
};

/** 能当纯文本读进 prompt 的扩展名（网关不认文件块，只能内联） */
export const TEXT_EXT = new Set([
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

/**
 * 请求体上限 100 MB（文档：图片/视频理解的使用说明）。本地先拦，
 * 免得读完几百 MB、编码、发出去才收到一个 413。
 */
export const MAX_BODY_BYTES = 100 * 1024 * 1024;

/** 一个已识别的输入 */
export interface ChatInput {
  kind: "image" | "video" | "text";
  /** 公网 URL 原样透传；本地文件为绝对路径 */
  origin: "url" | "file";
  /** URL 或绝对路径 */
  ref: string;
  /** 图片/视频的 MIME（URL 输入按扩展名推断，推断不出为空） */
  mime?: string;
}

/** 构造结果：content 交给 payload；warnings 由命令层打到 stderr */
export interface BuiltContent {
  content: unknown;
  warnings: string[];
}

function isUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw);
}

/** 把 --input 的值解析成绝对路径（支持 @path 与 ~） */
export function resolveInputPath(rawPath: string): string {
  const cleaned = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const resolved = expandHome(cleaned);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(t("chat.inputMissing", { path: resolved }));
  }
  return resolved;
}

function unsupported(ext: string): Error {
  return new Error(
    `${t("chat.unsupportedFile", {
      ext: ext || t("chat.unsupportedExtFallback"),
      images: Object.keys(IMAGE_MIME).join("/"),
      texts: [...TEXT_EXT].slice(0, 5).join("/"),
    })}\n${t("chat.unsupportedFileFix")}`,
  );
}

/**
 * 识别一个 --input。
 *
 * URL 按路径扩展名判断图片/视频；认不出扩展名（如 CDN 的无后缀地址）按图片处理——
 * 图片理解远比视频常用，且可用 video: 前缀显式指定（video:https://...）。
 */
export function classifyInput(raw: string): ChatInput {
  const forced = /^(image|video):/i.exec(raw);
  const value = forced ? raw.slice(forced[0].length) : raw;
  const forcedKind = forced?.[1]?.toLowerCase() as "image" | "video" | undefined;

  if (isUrl(value)) {
    const ext = path.extname(new URL(value).pathname).toLowerCase();
    const kind = forcedKind ?? (VIDEO_MIME[ext] ? "video" : "image");
    return { kind, origin: "url", ref: value, mime: (kind === "video" ? VIDEO_MIME : IMAGE_MIME)[ext] };
  }

  const resolved = resolveInputPath(value);
  const ext = path.extname(resolved).toLowerCase();
  if (forcedKind === "video" || (!forcedKind && VIDEO_MIME[ext])) {
    return { kind: "video", origin: "file", ref: resolved, mime: VIDEO_MIME[ext] ?? "video/mp4" };
  }
  if (forcedKind === "image" || IMAGE_MIME[ext]) {
    return { kind: "image", origin: "file", ref: resolved, mime: IMAGE_MIME[ext] ?? "image/jpeg" };
  }
  if (TEXT_EXT.has(ext)) {
    return { kind: "text", origin: "file", ref: resolved };
  }
  throw unsupported(ext);
}

/** 本地文件 → data URL；URL 原样返回 */
function urlOf(input: ChatInput): string {
  if (input.origin === "url") {
    return input.ref;
  }
  return `data:${input.mime};base64,${fs.readFileSync(input.ref).toString("base64")}`;
}

/** Base64 编码后的体积估算（4/3 膨胀），用于本地预检 */
export function encodedSize(inputs: ChatInput[]): number {
  let total = 0;
  for (const input of inputs) {
    if (input.origin === "file" && input.kind !== "text") {
      total += Math.ceil(fs.statSync(input.ref).size / 3) * 4;
    }
  }
  return total;
}

/** 文本类文件内联成一段 text */
function inlineText(input: ChatInput, header: string): string {
  const body = fs.readFileSync(input.ref, "utf8");
  return `${t("chat.fileIntro", { header, name: path.basename(input.ref) })}\n\n${body}`;
}

/** 单个媒体输入 → 对应协议的内容块（图片与视频结构相同，只是类型名不同） */
function mediaBlock(input: ChatInput, shape: PayloadShape): Record<string, unknown> {
  const video = input.kind === "video";
  if (shape === "responses") {
    return video ? { type: "input_video", video_url: urlOf(input) } : { type: "input_image", image_url: urlOf(input) };
  }
  if (shape === "anthropic") {
    const source =
      input.origin === "url"
        ? { type: "url", url: input.ref }
        : { type: "base64", media_type: input.mime, data: fs.readFileSync(input.ref).toString("base64") };
    return { type: video ? "video" : "image", source };
  }
  return video
    ? { type: "video_url", video_url: { url: urlOf(input) } }
    : { type: "image_url", image_url: { url: urlOf(input) } };
}

/** 文本块的类型名随协议变：responses 是 input_text，其余是 text */
function textBlock(text: string, shape: PayloadShape): Record<string, unknown> {
  return { type: shape === "responses" ? "input_text" : "text", text };
}

/**
 * 拼 content。
 *
 * 只有问题文本（或只有文本类文件）时返回纯字符串，与一期行为一致——纯文本请求
 * 不需要块数组，有的网关实现对块数组里只有 text 的情况反而处理得不好。
 * 有媒体时返回块数组：媒体在前、问题文本在后，与官方示例的顺序一致（顺序即模型接收顺序）。
 */
export function buildChatContent(
  shape: PayloadShape,
  message: string | undefined,
  rawInputs: string[],
): BuiltContent {
  const inputs = rawInputs.map(classifyInput);
  const warnings: string[] = [];

  if (encodedSize(inputs) > MAX_BODY_BYTES) {
    throw new Error(t("chat.bodyTooLarge", { limit: "100 MB" }));
  }
  if (inputs.some((i) => i.kind === "video" && i.origin === "file")) {
    warnings.push(t("chat.videoBase64Warn"));
  }
  // Responses 协议下视频是否生效因模型而异，且不生效时不报错——提前说明，免得把"没看到视频"当成模型的结论
  if (shape === "responses" && inputs.some((i) => i.kind === "video")) {
    warnings.push(t("chat.videoResponsesWarn"));
  }

  const media = inputs.filter((i) => i.kind !== "text");
  const texts = inputs.filter((i) => i.kind === "text");

  if (!media.length) {
    if (!texts.length) {
      return { content: message ?? "", warnings };
    }
    const header = message ? `${message}\n\n` : "";
    // 多个文本文件依次内联；问题文本只放在第一段的开头，避免重复
    return { content: texts.map((x, i) => inlineText(x, i === 0 ? header : "")).join("\n\n"), warnings };
  }

  const parts: Array<Record<string, unknown>> = media.map((m) => mediaBlock(m, shape));
  for (const x of texts) {
    parts.push(textBlock(inlineText(x, ""), shape));
  }
  if (message) {
    parts.push(textBlock(message, shape));
  }
  return { content: parts, warnings };
}
