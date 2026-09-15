/**
 * 让任意层级的 `thcli ... help` 等价于 `thcli ... --help`。
 *
 * commander 只在有子命令的层级自动提供 `help` 子命令；叶子命令（如 usage rank、
 * doctor error）收到的 `help` 会被当成多余的位置参数静默忽略，直接执行命令。
 * 为让全命令树的 help 行为一致，解析前统一把末位的 `help` 改写成 `--help`。
 */

/**
 * 把末位的 `help` 改写成 `--help`。
 * 前一项是选项名时不改写——避免误伤值恰好是 "help" 的选项（如 --name help）。
 */
export function normalizeHelpArg(argv: string[]): string[] {
  if (argv.length < 3 || argv[argv.length - 1] !== "help") {
    return argv;
  }
  const prev = argv[argv.length - 2];
  if (prev?.startsWith("-")) {
    return argv;
  }
  return [...argv.slice(0, -1), "--help"];
}
