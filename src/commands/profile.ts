/**
 * profile 命令组：多账号身份的列出/查看/切换。
 */
import fs from "node:fs";
import { Command } from "commander";

import type { GlobalArgs } from "../core/credentials.js";
import { readConfigure, resolveProfile, resolveSite } from "../core/credentials.js";
import { DEFAULT_REGION } from "../core/config.js";
import { DEFAULT_ALIAS, loadDataConfig, saveDataConfig, setRegionKey } from "../core/keystore.js";
import { CONFIG_DIR, configurePath } from "../core/paths.js";
import { clearSetting, getSetting, setSetting } from "../core/settings.js";
import { pad } from "../core/format.js";
import { emitJson } from "../core/output.js";
import { t } from "../core/i18n.js";

/** 扫描配置目录，得出每个 profile 在哪些 site 下有凭证 */
function scanProfiles(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  let entries: string[];
  try {
    entries = fs.readdirSync(CONFIG_DIR);
  } catch {
    return found;
  }
  for (const name of entries) {
    const credMatch = /^(.+)\.(.+)\.credential$/.exec(name);
    if (credMatch?.[1] && credMatch[2]) {
      const set = found.get(credMatch[1]) ?? new Set<string>();
      set.add(credMatch[2]);
      found.set(credMatch[1], set);
      continue;
    }
    // 只有配置没凭证的 profile 也要列出来，否则用户会以为没建过
    const otherMatch = /^(.+)\.(configure|tokenhub\.json)$/.exec(name);
    if (otherMatch?.[1] && !found.has(otherMatch[1])) {
      found.set(otherMatch[1], new Set<string>());
    }
  }
  return found;
}

function listCommand(globals: GlobalArgs): void {
  const profiles = scanProfiles();
  const current = resolveProfile(globals);

  if (
    emitJson({
      Current: current,
      Profiles: [...profiles].sort().map(([name, sites]) => ({
        Name: name,
        Sites: [...sites].sort(),
      })),
    })
  ) {
    return;
  }

  if (!profiles.size) {
    console.log(t("profile.list.empty"));
    return;
  }
  console.log(`   ${pad("PROFILE", 20)} ${t("profile.list.headerSites")}`);
  for (const [name, sites] of [...profiles].sort()) {
    const marker = name === current ? "*" : " ";
    const desc = sites.size ? [...sites].sort().join(", ") : t("profile.list.noCred");
    const tail = name === current ? `    ${t("common.activeMarker")}` : "";
    console.log(`${marker}  ${pad(name, 20)} ${desc}${tail}`);
  }
  console.log(t("profile.list.hint"));
}

function currentCommand(globals: GlobalArgs): void {
  let source: string;
  if (globals.profile) {
    source = t("profile.source.cli");
  } else if (process.env["THCLI_PROFILE"]) {
    source = t("profile.source.env");
  } else if (getSetting("profile")) {
    source = t("profile.source.file");
  } else {
    source = t("profile.source.default");
  }
  const profile = resolveProfile(globals);
  const cfgForJson = readConfigure(profile);
  if (emitJson({ Profile: profile, Source: source, Config: cfgForJson })) return;

  console.log(t("profile.current.line", { profile, source }));

  // 顺带回显该 profile 的配置项——否则用户 profile set 之后无从确认写进去了没有
  const cfg = readConfigure(profile);
  const configured = Object.entries(cfg).filter(([, v]) => v !== undefined && v !== "");
  if (configured.length) {
    console.log(t("profile.current.savedHeader"));
    for (const [key, value] of configured) {
      console.log(`  ${pad(key, 10)}: ${String(value)}`);
    }
  } else {
    console.log(t("profile.current.savedNone"));
  }
  // 界面语言不在这里显示——它是 CLI 全局设置，见 thcli lang current
}

function useCommand(opts: Record<string, string>): void {
  if (opts["clear"]) {
    clearSetting("profile");
    console.log(t("profile.use.cleared"));
    return;
  }
  const name = opts["name"];
  if (!name) {
    throw new Error(t("profile.use.missing"));
  }
  // default 允许直接切（可能还没登录），其余要求至少有一份凭证，避免切到空身份
  if (name !== "default" && !scanProfiles().has(name)) {
    throw new Error(
      t("profile.use.noCred", { name }),
    );
  }
  setSetting("profile", name);
  console.log(t("profile.use.switched", { name }));
}

/**
 * 创建新的账号身份 profile（用于同站多账号隔离）。凭证只能 auth login 产生，
 * create 只写占位配置 + 切过去 + 引导登录，不伪造凭证。
 */
function createCommand(opts: Record<string, string>): void {
  const name = opts["name"];
  if (!name) {
    throw new Error(t("profile.create.missing"));
  }
  if (name === "default") {
    throw new Error(t("profile.create.isDefault"));
  }
  if (scanProfiles().has(name)) {
    throw new Error(t("profile.create.exists", { name }));
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // 写空配置作为占位，让 profile list 能显示它（状态「无凭证，仅配置」）
  fs.writeFileSync(configurePath(name), "{}\n");
  // create 的目的就是开始用这个身份，直接切过去
  setSetting("profile", name);
  console.log(t("profile.create.created", { name }));
  console.log(t("profile.create.next", { name }));
}

/** 写一项到 {profile}.configure，其余键保持不动 */
function writeConfigure(profile: string, key: string, value: string): void {
  const cfg = readConfigure(profile);
  cfg[key] = value;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(configurePath(profile), `${JSON.stringify(cfg, null, 2)}\n`);
}

/**
 * 修改当前 profile 的配置：--region 锁地域、--api-key 改默认 Key。
 *
 * 界面语言不在这里：它是 CLI 级的显示偏好，与"用哪个账号"无关，切 profile 不该
 * 跟着换语言，故独立成 `thcli lang` 命令组、写 settings.json。
 */
function setCommand(opts: Record<string, string>, globals: GlobalArgs): void {
  const profile = resolveProfile(globals);

  if (opts["region"]) {
    writeConfigure(profile, "region", opts["region"]);
    console.log(t("profile.set.regionDone", { profile, region: opts["region"] }));
    return;
  }

  if (opts["apiKey"]) {
    // 默认数据面 Key 即当前 site + 默认地域 + th/default，直接写进 key 存储
    const site = resolveSite(globals);
    const cfg = loadDataConfig(profile);
    setRegionKey(cfg, site, DEFAULT_REGION, "th", opts["apiKey"], DEFAULT_ALIAS);
    saveDataConfig(profile, cfg);
    console.log(
      t("profile.set.apiKeyDone", {
        profile,
        scope: `${site}/${DEFAULT_REGION}/th/${DEFAULT_ALIAS}`,
      }),
    );
    return;
  }

  throw new Error(
    `${t("profile.set.missing")}\n  ${t("profile.set.langHint")}`,
  );
}

/** 装配 profile 命令组 */
export function registerProfileCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const profile = program.command("profile").description(t("group.profile.desc"));

  profile.command("list").description(t("profile.list.desc")).action(() => listCommand(getGlobals()));
  profile
    .command("current")
    .description(t("profile.current.desc"))
    .action(() => currentCommand(getGlobals()));
  profile
    .command("use")
    .description(t("profile.use.desc"))
    .option("--name <name>", t("profile.use.opt.name"))
    .option("--clear", t("profile.use.opt.clear"))
    .action((opts) => useCommand(opts));

  profile
    .command("create")
    .description(t("profile.create.desc"))
    .requiredOption("--name <name>", t("profile.create.opt.name"))
    .action((opts) => createCommand(opts));

  profile
    .command("set")
    .description(t("profile.set.desc"))
    .option("--region <region>", t("profile.set.opt.region"))
    .option("--api-key <key>", t("profile.set.opt.apiKey"))
    .action((opts) => setCommand(opts, getGlobals()));
}
