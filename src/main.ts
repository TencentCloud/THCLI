#!/usr/bin/env node
/**
 * thcli 入口：装配命令树、全局选项，处理裸执行时的品牌图。
 */
// 必须在其它 import 之前：拦截无关的 Node 内置弃用警告（DEP0040/DEP0169），
// 否则第一次 require SDK 时就已经打印过了。
import "./core/mute-node-warnings.js";

import { Command } from "commander";

import { registerAuthCommands } from "./commands/auth.js";
import { registerChatCommands } from "./commands/chat.js";
import { registerDoctorCommands } from "./commands/doctor.js";
import { registerEndpointCommands } from "./commands/endpoint.js";
import { registerKeyCommands } from "./commands/key.js";
import { registerModelCommands } from "./commands/models.js";
import { registerPlanCommands } from "./commands/plan.js";
import { registerProfileCommands } from "./commands/profile.js";
import { registerSiteCommands } from "./commands/site.js";
import { registerEnvCommands } from "./commands/env.js";
import { registerLangCommands } from "./commands/lang.js";
import { registerMonitorCommands } from "./commands/monitor.js";
import { registerUsageCommands } from "./commands/usage.js";
import { registerConnectCommands } from "./commands/connect.js";
import type { GlobalArgs } from "./core/credentials.js";
import { initLang, t } from "./core/i18n.js";
import { setJsonMode } from "./core/output.js";
import { errorCodeOf, lookupError } from "./core/errors.js";
import { printBanner } from "./util/banner.js";
import { normalizeHelpArg } from "./util/help-alias.js";

// 版本号由 tsup 编译期注入（见 tsup.config.ts 的 define.__VERSION__）。
// dev 模式下 __VERSION__ 未定义时，回退用 "0.0.0-dev" 避免运行时崩。
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev";

/**
 * 语言必须在**任何 t() 求值之前**定好，包括下面 program 的选项定义——
 * 那些 description 在模块顶层就求值了，晚于这里初始化的话 help 永远是默认语言。
 * 这里只手工扫 argv，不走 commander 解析（解析时 help 已经要输出了）。
 */
const cliLangValue = ((): string | undefined => {
  const argv = process.argv.slice(2);
  const at = argv.lastIndexOf("--lang");
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
})();
initLang(cliLangValue);

const program = new Command();

program
  .name("thcli")
  .description("THCLI — Tencent Cloud LLM platform command line interface")
  .version(VERSION, "--version", t("global.opt.version"))
  .option("--profile <name>", t("global.opt.profile"))
  .option("--site <site>", t("global.opt.site"))
  .option("--region <region>", t("global.opt.region"))
  .option("--secret-id <id>", t("global.opt.secretId"))
  .option("--secret-key <key>", t("global.opt.secretKey"))
  .option("--lang <lang>", t("global.opt.lang"))
  .option("--json", t("global.opt.json"))
  .enablePositionalOptions();

// --json 是布尔开关，不能走 getGlobals 里那套「读取下一个 argv」的取值逻辑，
// 直接扫一遍即可。放在装配命令之前设置：命令 action 执行时就能读到。
setJsonMode(process.argv.slice(2).includes("--json"));

/**
 * 全局选项在子命令 action 里按需读取。
 *
 * commander 的全局选项只在子命令**之前**生效（thcli --region x key list）；放在
 * 子命令之后会报 unknown option。用户很难记住这个位置要求，所以这里额外扫一遍
 * 原始 argv，让这几个凭证/环境选项出现在任意位置都能被拾取（命令行显式值的
 * 优先级本来就最高，兜底解析不改变优先级语义）。
 */
function getGlobals(): GlobalArgs {
  const opts = program.opts<GlobalArgs>();
  const argv = process.argv.slice(2);
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const i = argv.lastIndexOf(name);
      if (i >= 0 && i + 1 < argv.length) {
        return argv[i + 1];
      }
    }
    return undefined;
  };
  return {
    profile: opts.profile ?? pick("--profile"),
    site: opts.site ?? pick("--site"),
    region: opts.region ?? pick("--region"),
    secretId: opts.secretId ?? pick("--secret-id"),
    secretKey: opts.secretKey ?? pick("--secret-key"),
    lang: opts.lang ?? pick("--lang"),
  };
}

/**
 * 给所有叶子命令补上全局凭证/环境选项，使它们出现在子命令之后也能被解析。
 *
 * 选项定义从 program 自身读取，不再抄一份字面量——抄写的那份曾与 program 上的
 * 描述文案不同步（改了一处漏另一处），同一个选项在两级 help 里说法不一致。
 */
function addGlobalOptionsToLeaves(root: Command): void {
  const globalOpts: Array<[string, string]> = root.options
    .filter((o) => o.long !== "--version" && o.long !== "--help")
    .map((o) => [o.flags, o.description]);
  const walk = (cmd: Command): void => {
    if (!cmd.commands.length) {
      // 叶子命令：补全局选项。已声明同名选项的（如 auth set 的 --secret-id）跳过，避免冲突
      const existing = new Set(cmd.options.map((o) => o.long));
      for (const [flags, desc] of globalOpts) {
        const long = flags.split(" ")[0];
        if (long && !existing.has(long)) {
          cmd.option(flags, desc);
        }
      }
      return;
    }
    for (const sub of cmd.commands) {
      walk(sub);
    }
  };
  walk(root);
}

registerAuthCommands(program, getGlobals);
registerKeyCommands(program, getGlobals);
registerModelCommands(program, getGlobals);
registerEndpointCommands(program, getGlobals);
registerChatCommands(program, getGlobals);
registerPlanCommands(program, getGlobals);
registerUsageCommands(program, getGlobals);
registerMonitorCommands(program, getGlobals);
registerDoctorCommands(program, getGlobals);
registerProfileCommands(program, getGlobals);
registerSiteCommands(program, getGlobals);
registerEnvCommands(program, getGlobals);
registerLangCommands(program, () => cliLangValue);
registerConnectCommands(program);

// 全局凭证/环境选项默认只在子命令之前生效；给每个叶子命令也补一份，让它们出现在
// 子命令之后也不报 unknown option（值由 getGlobals 统一读取，这里只为通过解析）。
addGlobalOptionsToLeaves(program);

// 裸执行显示品牌图而不是 commander 默认的 usage
if (process.argv.length <= 2) {
  printBanner(VERSION);
  process.exit(0);
}

program.parseAsync(normalizeHelpArg(process.argv)).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  // 云 API 错误带结构化 code 时，当场附上原因与修复建议，省去用户再去 doctor error 查
  const code = errorCodeOf(err);
  if (code) {
    const info = lookupError(code);
    if (info) {
      console.error(`  ${t("error.code", { code })}`);
      console.error(`  ${t("error.reason", { reason: info.reason })}`);
      console.error(`  ${t("error.fix", { fix: info.fix })}`);
    } else {
      console.error(`  ${t("error.codeUnknown", { code })}`);
    }
  }
  process.exit(1);
});
