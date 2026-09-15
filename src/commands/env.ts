/**
 * env 命令组：正式环境 / 测试环境的列出、查看、切换。
 *
 * 与 site 正交：site 决定哪个站点（国内/国际），env 决定连哪套网关（正式/测试）。
 * 两者组合出四种目标，各自的凭证不通用——测试环境的临时密钥拿到正式网关会报
 * AuthFailure.TokenFailure（不是过期，是环境不匹配），切换后需重新 auth login。
 */
import { Command } from "commander";

import {
  allowedEnvs,
  apiEndpointOf,
  cloudApiHostOf,
  DEFAULT_ENV,
  envConfigOf,
} from "../core/config.js";
import { type GlobalArgs, resolveEnv } from "../core/credentials.js";
import { resolveIdentity } from "../core/identity.js";
import { clearSetting, getSetting, setSetting } from "../core/settings.js";
import { pad } from "../core/format.js";
import { emitJson, isJson } from "../core/output.js";
import { t } from "../core/i18n.js";

function listCommand(): void {
  const current = resolveEnv();
  if (
    emitJson({
      Current: current,
      Envs: allowedEnvs().map((env) => ({
        Env: env,
        ApiEndpoint: envConfigOf(env).apiEndpoint ?? null,
      })),
    })
  ) {
    return;
  }
  console.log(`   ${pad("ENV", 14)}${pad("API_ENDPOINT", 40)}`);
  for (const env of allowedEnvs()) {
    const marker = env === current ? "*" : " ";
    const endpoint = envConfigOf(env).apiEndpoint ?? t("env.builtinEndpoint");
    const tail = env === current ? `    ${t("common.activeMarker")}` : "";
    console.log(`${marker}  ${pad(env, 14)}${pad(endpoint, 40)}${tail}`);
  }
  console.log(t("env.list.hint"));
}

async function currentCommand(globals: GlobalArgs): Promise<void> {
  const env = resolveEnv();
  let source: string;
  if (process.env["THCLI_ENV"]) {
    source = t("env.source.env");
  } else if (getSetting("env")) {
    source = t("env.source.file");
  } else {
    source = t("env.source.default", { env: DEFAULT_ENV });
  }
  // uin 要发请求才能拿到，故 JSON 模式也在同一处收集后统一输出
  let uinForJson: string | null = null;
  let uinError: string | null = null;
  if (isJson() && envConfigOf(env).routeByUserId) {
    try {
      uinForJson = (await resolveIdentity(globals)).uin;
    } catch (err) {
      uinError = (err as Error).message;
    }
  }
  if (
    emitJson({
      Env: env,
      Source: source,
      ApiEndpoint: apiEndpointOf(env) ?? null,
      CloudApiHost: cloudApiHostOf(env, "cam"),
      RouteByUserId: envConfigOf(env).routeByUserId === true,
      Uin: uinForJson,
      UinError: uinError,
    })
  ) {
    return;
  }

  console.log(t("env.current.line", { env, source }));
  console.log(t("env.current.endpoint", { endpoint: apiEndpointOf(env) ?? t("env.builtinEndpoint") }));

  console.log(t("env.current.cloudApi", { host: cloudApiHostOf(env, "cam") }));

  // 只有会带账号头的环境才提这件事，正式环境说了反而让人以为漏配了。
  // uin 从凭证反查（首次会发一次 cam 请求），未登录时不该因此报错
  if (envConfigOf(env).routeByUserId) {
    try {
      const { uin } = await resolveIdentity(globals);
      console.log(t("env.current.userId", { userId: uin }));
    } catch (err) {
      console.log(t("env.current.userIdFailed", { reason: (err as Error).message }));
    }
  }
}

function useCommand(opts: Record<string, string>): void {
  if (opts["clear"]) {
    clearSetting("env");
    console.log(t("env.use.cleared", { env: DEFAULT_ENV }));
    return;
  }
  const name = opts["name"];
  if (!name) {
    throw new Error(t("env.use.missing"));
  }
  if (!allowedEnvs().includes(name)) {
    throw new Error(t("env.use.unknown", { name, options: allowedEnvs().join(", ") }));
  }
  setSetting("env", name);
  console.log(t("env.use.switched", { name }));
  console.log(t("env.use.reloginHint"));
}

/**
 * 装配 env 命令组。
 *
 * 命令组本身在顶层 help 里隐藏：现网用户接触不到测试环境，列出来只会让人疑惑
 * "我是不是该切一下"。`thcli env --help` 仍能看到全部子命令，命令本身仍可正常调用。
 */
export function registerEnvCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const env = program.command("env", { hidden: true }).description(t("group.env.desc"));

  env.command("list").description(t("env.list.desc")).action(() => listCommand());
  env.command("current").description(t("env.current.desc")).action(() => currentCommand(getGlobals()));
  env
    .command("use")
    .description(t("env.use.desc"))
    .option("--name <name>", t("env.use.opt.name"))
    .option("--clear", t("env.use.opt.clear"))
    .action((opts: Record<string, string>) => useCommand(opts));
}
