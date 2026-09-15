/**
 * lang 命令组：界面语言。
 *
 * 独立成组而非挂在 profile 下：语言是 CLI 的显示偏好，与"用哪个账号"无关，
 * 切 profile 不该跟着换语言。持久化到 ~/.thcli/settings.json 的 lang 字段。
 *
 * 命令组的描述与输出刻意做成中英并排。一个只读英文的用户面对满屏中文时，
 * 必须能在 `thcli --help` 里一眼认出这是切语言的入口——若描述只有中文，
 * 他根本找不到出路。
 */
import { Command } from "commander";

import { lang, readSavedLang, saveLang, SUPPORTED_LANGS } from "../core/i18n.js";
import { emitJson } from "../core/output.js";

/** 显示当前语言与它的来源 */
function currentCommand(cliLang: string | undefined): void {
  const effective = lang();
  const saved = readSavedLang();
  const source = cliLang
    ? "--lang"
    : process.env["THCLI_LANG"]
      ? "THCLI_LANG"
      : saved
        ? "~/.thcli/settings.json"
        : "default";
  const meta = SUPPORTED_LANGS.find((l) => l.code === effective);
  if (emitJson({ Lang: effective, Native: meta?.native ?? effective, Source: source })) return;
  console.log(`${effective}（${meta?.native ?? effective}）· source: ${source}`);
  if (effective === "zh") {
    console.log("Switch to English: thcli lang set en");
  } else {
    console.log("切换回中文：thcli lang set zh");
  }
}

/** 列出可选语言，标出当前项 */
function listCommand(): void {
  const now = lang();
  if (
    emitJson({
      Current: now,
      Langs: SUPPORTED_LANGS.map((l) => ({ Code: l.code, Native: l.native })),
    })
  ) {
    return;
  }
  for (const item of SUPPORTED_LANGS) {
    const mark = item.code === now ? "*" : " ";
    console.log(`${mark} ${item.code.padEnd(4)} ${item.native}`);
  }
  console.log("");
  console.log("* = current · thcli lang set <code>");
}

/** 设置并持久化语言 */
function setCommand(value: string): void {
  const applied = saveLang(value);
  // 用切换后的语言回显，让用户立刻确认生效
  if (applied === "en") {
    console.log("Interface language set to English (saved to ~/.thcli/settings.json)");
    console.log("Switch back anytime: thcli lang set zh");
  } else {
    console.log("界面语言已设为中文（已保存到 ~/.thcli/settings.json）");
    console.log("随时切回英文：thcli lang set en");
  }
}

/** 装配 lang 命令组 */
export function registerLangCommands(program: Command, getCliLang: () => string | undefined): void {
  const langCmd = program
    .command("lang")
    // 双语描述：英文用户在满屏中文的 help 里也能找到这个入口
    .description("界面语言 / Interface language (zh | en)");

  // 默认动作既要支持 `thcli lang`（看当前）也要支持 `thcli lang en`（直接设置）——
  // 后者是很自然的写法，若只当未知子命令静默落到 current，用户会以为设置成功了
  // 但实际没变（实测踩过：`thcli lang en` 输出"当前是 zh"）
  langCmd
    .command("current", { isDefault: true })
    .description("显示当前语言 / Show current language")
    .argument("[lang]", "zh | en · 给了就直接设置 / set directly if given")
    .action((value: string | undefined) => {
      if (value) {
        setCommand(value);
        return;
      }
      currentCommand(getCliLang());
    });

  langCmd
    .command("list")
    .description("列出可选语言 / List available languages")
    .action(() => listCommand());

  langCmd
    .command("set")
    .description("设置并保存语言 / Set and save language")
    .argument("<lang>", "zh | en")
    .action((value: string) => setCommand(value));
}
