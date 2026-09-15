/**
 * 双语文案。默认中文，可切英文。
 *
 * 语言解析优先级：
 *   1. --lang <zh|en>       单次执行临时指定
 *   2. THCLI_LANG 环境变量   当前 shell 会话
 *   3. ~/.thcli/settings.json 的 lang（thcli lang set 写入）
 *   4. 默认 zh
 *
 * 为什么存在全局设置里而不是 profile 配置里：语言是 CLI 的显示偏好，与"用哪个账号"
 * 无关——同一个人切 profile 不该跟着换语言。故与当前 profile / 站点同放在
 * settings.json，是 CLI 全局设置。
 *
 * 为什么默认中文：现阶段用户以国内站为主，默认英文会让首次使用体验变差。
 * 英文用户执行一次 `thcli lang set en` 即可。
 *
 * 文案组织：按命令组分文件（locales/zh/*.ts 与 locales/en/*.ts），键用点号分层
 * （`usage.rank.title`）。缺失的键回退到中文而不是报错——文案不全不该让命令挂掉，
 * 但会在 THCLI_I18N_DEBUG=1 时打印告警，便于开发期发现漏译。
 */

import { getSetting, setSetting } from "./settings.js";
import { EN } from "../locales/en.js";
import { ZH } from "../locales/zh.js";

/** 支持的语言 */
export type Lang = "zh" | "en";

/**
 * 文案表：扁平的点号键 → 带占位符的字符串。
 *
 * 占位符写 `{name}`，由 t() 替换。刻意不用函数形式（`({n}) => \`共 ${n} 个\``）：
 *   - 文案是数据而非代码，两侧的占位符可以被自动校验（见 test/i18n.test.ts），
 *     函数体没法这样查
 *   - 译者能自由调语序：中文「已为 {count} 个模型开启」→ 英文
 *     「Enabled for {count} model(s)」，位置不同但占位符集合相同
 *   - 将来要外挂 JSON 文案包时不用改结构
 */
export type Messages = Record<string, string>;

const TABLES: Record<Lang, Messages> = { zh: ZH, en: EN };

let current: Lang | undefined;

/** 把用户输入的语言值归一化；无法识别时返回 undefined 而不是静默当成默认值 */
function normalize(value: string | undefined): Lang | undefined {
  if (!value) {
    return undefined;
  }
  const v = value.trim().toLowerCase();
  if (v === "zh" || v === "zh-cn" || v === "cn" || v === "chinese") {
    return "zh";
  }
  if (v === "en" || v === "en-us" || v === "english") {
    return "en";
  }
  return undefined;
}

/**
 * 解析并缓存当前语言。必须在**注册命令之前**调用——各命令的 description 在注册时
 * 就调用 t() 求值了，晚于这里初始化的话 help 会永远是默认语言。
 */
export function initLang(cliLang?: string): Lang {
  const fromCli = normalize(cliLang);
  if (fromCli) {
    current = fromCli;
    return current;
  }
  const fromEnv = normalize(process.env["THCLI_LANG"]);
  if (fromEnv) {
    current = fromEnv;
    return current;
  }
  const fromFile = normalize(readSavedLang());
  if (fromFile) {
    current = fromFile;
    return current;
  }
  current = "zh";
  return current;
}

/** 读已持久化的语言；未设置或内容非法都返回 undefined */
export function readSavedLang(): string | undefined {
  return getSetting("lang");
}

/** 持久化语言到 ~/.thcli/lang。返回归一化后的值，非法值抛错 */
export function saveLang(value: string): Lang {
  const normalized = normalize(value);
  if (!normalized) {
    throw new Error(`不支持的语言 ${value} / Unsupported language ${value}（可选 zh | en）`);
  }
  setSetting("lang", normalized);
  current = normalized;
  return normalized;
}

/** 可选语言列表，供 lang list 用 */
export const SUPPORTED_LANGS: Array<{ code: Lang; native: string; english: string }> = [
  { code: "zh", native: "中文", english: "Chinese" },
  { code: "en", native: "English", english: "English" },
];

/** 当前语言。未初始化时按默认值 zh，便于单测直接调 t() */
export function lang(): Lang {
  return current ?? "zh";
}

/**
 * 取文案。params 用于插值，例如
 *   t("usage.rank.scope", { from: 1, to: 10, total: 21 })
 *
 * 键缺失时回退中文，再缺失才返回键名本身——让屏幕上出现键名总比抛异常好，
 * 且键名本身能提示该补哪条。
 */
export function t(key: string, params: Record<string, unknown> = {}): string {
  const table = TABLES[lang()];
  let entry = table[key];
  if (entry === undefined && lang() !== "zh") {
    if (process.env["THCLI_I18N_DEBUG"]) {
      console.error(`[i18n] missing ${lang()} key: ${key}`);
    }
    entry = ZH[key];
  }
  if (entry === undefined) {
    return key;
  }
  return interpolate(entry, params, key);
}

/**
 * 替换 `{name}` 占位符。
 *
 * 未提供值的占位符原样保留而不是替换成 "undefined"——留着 `{count}` 能一眼看出
 * 是调用方漏传参数，而 "undefined" 会被误当成数据异常。
 * THCLI_I18N_DEBUG=1 时额外报出来。
 */
function interpolate(template: string, params: Record<string, unknown>, key: string): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in params)) {
      if (process.env["THCLI_I18N_DEBUG"]) {
        console.error(`[i18n] ${key} 缺少参数 ${name}`);
      }
      return whole;
    }
    return String(params[name]);
  });
}

/** 取出文案里的占位符名集合，供一致性校验用 */
export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
}

/** 语言相关的数字/单位习惯：英文用逗号分隔千位，中文沿用现状 */
export function localeNumber(value: number): string {
  return lang() === "en" ? value.toLocaleString("en-US") : String(value);
}
