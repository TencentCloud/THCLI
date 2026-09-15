/**
 * 静默特定的 Node.js 内置弃用警告。
 *
 * 只屏蔽以下两条——它们由 Node 内置模块与老旧依赖共同触发，与 thcli 自身无关，
 * 但会在每次命令启动时污染控制台：
 *
 *   - DEP0040: `punycode` 模块已弃用（腾讯云 SDK 的传递依赖里仍在 require）
 *   - DEP0169: `url.parse()` 已弃用（同上）
 *
 * 做法：包一层 process.emitWarning，只吃掉命中上述 code 的 DeprecationWarning，
 * 其它任何警告（含未来 SDK 出现的新迁移提示）原样透传。
 *
 * 必须在模块顶层最早执行——所以 main.ts 用副作用 import 引入本文件放在第一行。
 */

const SILENCED = new Set<string>(["DEP0040", "DEP0169"]);

const originalEmitWarning = process.emitWarning.bind(process);

function shouldSilence(warning: string | Error, typeOrOptions?: unknown, maybeCode?: unknown): boolean {
  let type: string | undefined;
  let code: string | undefined;
  if (typeof typeOrOptions === "string") {
    type = typeOrOptions;
    code = typeof maybeCode === "string" ? maybeCode : undefined;
  } else if (typeOrOptions && typeof typeOrOptions === "object") {
    const opts = typeOrOptions as { type?: string; code?: string };
    type = opts.type;
    code = opts.code;
  }
  if (type && type !== "DeprecationWarning") return false;
  if (code && SILENCED.has(code)) return true;
  // 少数场景 code 不在 options 里而放到 Error 对象上
  if (typeof warning !== "string") {
    const asAny = warning as unknown as { code?: string };
    if (asAny.code && SILENCED.has(asAny.code)) return true;
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).emitWarning = function patchedEmitWarning(
  warning: string | Error,
  ...rest: unknown[]
): void {
  if (shouldSilence(warning, rest[0], rest[1])) return;
  // 透传所有非命中场景
  // @ts-expect-error 与原始签名转发一致
  return originalEmitWarning(warning, ...rest);
};
