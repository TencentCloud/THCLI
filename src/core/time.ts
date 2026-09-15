/**
 * 管控面接口的时间参数处理。
 *
 * 这些接口收 RFC3339 字符串，且**必须带时区**（`Z` 或 `±HH:MM`）。不带时区的
 * 写法会被拒绝，而 JS 的 `new Date("2026-09-02T16:12:02")` 却会把它当本地时间
 * 照常解析——所以不能只用 Date 判断有效性，必须显式检查时区部分，否则本地看着
 * 通过、发出去才失败。
 */
import { t } from "./i18n.js";

/** RFC3339：日期 T 时间 [.毫秒] 时区，时区不可省 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 校验用户传入的时间参数。不合法就带上参数名与示例报错，
 * 而不是把它原样发出去等对端拒绝——那样的报错看不出是哪个参数、错在哪。
 */
export function assertRfc3339(value: string | undefined, optName: string): void {
  if (value === undefined) return;
  if (!RFC3339.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new Error(t("time.needRfc3339", { opt: optName, value }));
  }
}

/** 从当前时刻往前推 N 分钟，返回 [start, end] 的 RFC3339 UTC 字符串 */
export function utcRangeMinutesAgo(minutes: number): { start: string; end: string } {
  const now = new Date();
  const from = new Date(now.getTime() - minutes * 60 * 1000);
  const fmt = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;
  return { start: fmt(from), end: fmt(now) };
}
