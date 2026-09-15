/**
 * 终端颜色：只用于图表里区分对象，不用于强调文案。
 *
 * 关掉颜色的三种情况（任一命中即关）：
 *   - 输出不是 TTY（重定向到文件、管道给 grep、CI 日志）——转义序列会变成乱码
 *   - NO_COLOR 环境变量存在（https://no-color.org 的事实标准）
 *   - TERM=dumb
 * FORCE_COLOR 可以强制打开，用于「明知在管道里但想看颜色」的场景（如 less -R）。
 *
 * 关掉颜色时图表仍然可读：调用方需要同时给出字符区分（见 SERIES_MARKS），
 * 不能只靠颜色承载信息。
 */

/** 是否启用颜色，进程内判定一次 */
export const colorEnabled = ((): boolean => {
  if (process.env["FORCE_COLOR"]) {
    return true;
  }
  if (process.env["NO_COLOR"] !== undefined) {
    return false;
  }
  if (process.env["TERM"] === "dumb") {
    return false;
  }
  return process.stdout.isTTY === true;
})();

/**
 * 图表分系列用的 256 色编号，按相邻色差最大化排序。
 *
 * 避开的颜色：太暗的（<33 在深色背景上看不清）、纯红 196（容易被当成报错）、
 * 接近背景的灰白。最后一个 244 灰色留给「其它」这类兜底分组。
 */
const SERIES_COLORS = [39, 208, 42, 201, 220, 105, 51, 214, 141, 154, 171, 80];

/** 兜底分组（「其它 N 个」）用的灰色，与具名系列区分开 */
const REST_COLOR = 244;

/**
 * 颜色不可用时替代的字符标记。颜色只是加分项，信息不能只由颜色承载
 * （色盲用户、黑白终端、日志重定向都需要这条退路）。
 */
export const SERIES_MARKS = ["█", "▓", "▒", "░", "#", "=", "+", "*", "~", ":", ".", "-"];

/** 兜底分组的字符标记 */
export const REST_MARK = "·";

/** 给文本套上第 index 个系列的颜色；颜色关闭时原样返回 */
export function seriesColor(index: number, text: string, isRest = false): string {
  if (!colorEnabled) {
    return text;
  }
  const code = isRest ? REST_COLOR : SERIES_COLORS[index % SERIES_COLORS.length];
  return `\x1b[38;5;${code}m${text}\x1b[0m`;
}

/**
 * 取第 index 个系列在图上的填充字符。
 * 有颜色时统一用实心块（颜色本身足够区分）；无颜色时用不同字符区分。
 */
export function seriesGlyph(index: number, isRest = false): string {
  if (colorEnabled) {
    return "█";
  }
  return isRest ? REST_MARK : (SERIES_MARKS[index % SERIES_MARKS.length] ?? "#");
}

/** 系列颜色的可用数量，调用方据此决定 Top N 取多少 */
export const SERIES_CAPACITY = SERIES_COLORS.length;
