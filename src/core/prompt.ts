/**
 * 写操作/计费操作前的二次确认。
 */
import readline from "node:readline";

import { t } from "./i18n.js";

/**
 * 二次确认。--yes 直接放行；非交互环境（管道/脚本）没给 --yes 一律拒绝执行，
 * 不能默默当成"同意"。
 */
export async function confirm(prompt: string, yes?: boolean): Promise<boolean> {
  if (yes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    console.log(t("prompt.nonInteractive"));
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${prompt}${t("confirm.suffix")}`, resolve);
    });
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}
