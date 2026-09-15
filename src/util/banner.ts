/**
 * 裸执行 thcli 时的品牌图。
 */
import { displayWidth } from "../core/format.js";
import { t } from "../core/i18n.js";

const ART = String.raw`
  _   _          _ _
 | |_| |__   ___| (_)
 | __| '_ \ / __| | |
 | |_| | | | (__| | |
  \__|_| |_|\___|_|_|
`;

/** 上手示例：命令 + 说明。原来第三条没有说明文字，补齐后三行一致 */
const STEPS: Array<{ command: string; hintKey: string }> = [
  { command: "thcli auth login", hintKey: "banner.stepLogin" },
  { command: "thcli models list", hintKey: "banner.stepModels" },
  { command: 'thcli +chat --model <id> "hi"', hintKey: "banner.stepChat" },
];

/** 打印品牌图 + 版本 + 上手提示 */
export function printBanner(version: string): void {
  console.log(ART);
  console.log(`  THCLI  v${version}`);
  console.log(`  ${t("banner.tagline")}`);
  console.log("");
  console.log(`  ${t("banner.quickStart")}`);

  // 说明列按最长命令对齐。命令是 ASCII，但用 displayWidth 而非 length——
  // 将来若示例里出现中文，按 2 列算才不会错位
  const width = Math.max(...STEPS.map((s) => displayWidth(s.command)));
  for (const step of STEPS) {
    const gap = " ".repeat(width - displayWidth(step.command) + 3);
    console.log(`    ${step.command}${gap}${t(step.hintKey)}`);
  }

  console.log("");
  console.log(`  ${t("banner.moreHelp")}`);
  console.log("");
}
