/**
 * `--json` 结构化输出。
 *
 * 为什么需要：本 CLI 的主要使用方式是 AI Agent 通过 skills 驱动，而人类可读的表格
 * 无法可靠解析——列宽随中英文混排变化，靠空格切列会错位（实测把模型状态读错）。
 * `--json` 直接给出云 API 的原始响应，Agent 不必逆向解析渲染结果。
 *
 * 输出的是**SDK 原始结构**而非 CLI 内部类型：命令层为渲染方便定义的是"瘦身版"
 * interface，丢字段（例如模型计费的档位标签）。原样透传才不会二次损失信息。
 */
import { mask } from "./credentials.js";

/**
 * 全局开关。做成模块级变量而不是塞进 GlobalArgs：GlobalArgs 的语义是"凭证与环境
 * 维度"，而这是纯展示偏好；且命令层有 40 多个调用点，逐个透传参数不划算。
 */
let jsonMode = false;

/** main.ts 解析完命令行后调用一次 */
export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

/** 当前是否为 JSON 输出模式 */
export function isJson(): boolean {
  return jsonMode;
}

/**
 * JSON 模式下打印数据并返回 true，让调用方据此短路掉后续渲染：
 *
 *   if (emitJson(resp)) return;
 *   printTable(...)          // 非 JSON 模式才走到这里
 *
 * 非 JSON 模式返回 false、不产生任何输出，因此对现有行为零影响。
 */
export function emitJson(data: unknown): boolean {
  if (!jsonMode) {
    return false;
  }
  console.log(JSON.stringify(data, null, 2));
  return true;
}

/**
 * 需要脱敏的字段名。JSON 输出会被 Agent 转发、落盘、进对话历史，比终端里看一眼
 * 的暴露面大得多，所以密钥明文一律按文本模式的规则打码。
 *
 * 例外是 `key reveal` / `plan key reveal`：用户显式索取明文且已过二次确认，那两处
 * 不走本函数，直接打印密钥本身（也不 dump 整个响应，避免带出无关字段）。
 */
const SECRET_FIELDS = new Set(["ApiKey", "Secret", "SecretId", "SecretKey"]);

/**
 * 递归打码响应体里的密钥字段，返回新对象（不改原始数据，调用方后续渲染仍用原值）。
 *
 * 递归而非只扫顶层：密钥常嵌在 ApiKeySet[] / ApiKeyInfo 这类结构里面。
 */
export function sanitize<T>(data: T): T {
  if (Array.isArray(data)) {
    return data.map((item) => sanitize(item)) as unknown as T;
  }
  if (data === null || typeof data !== "object") {
    return data;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    out[key] = SECRET_FIELDS.has(key) && typeof value === "string" ? mask(value) : sanitize(value);
  }
  return out as unknown as T;
}

/** 先脱敏再输出，密钥类响应用这个而不是裸 emitJson */
export function emitJsonSafe(data: unknown): boolean {
  if (!jsonMode) {
    return false;
  }
  return emitJson(sanitize(data));
}
