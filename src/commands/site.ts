/**
 * site 命令组：国内站/国际站的列出、查看、切换。
 */
import { Command } from "commander";

import { allowedSites, DEFAULT_SITE } from "../core/config.js";
import { resolveSite, type GlobalArgs } from "../core/credentials.js";
import { clearSetting, getSetting, setSetting } from "../core/settings.js";
import { pad } from "../core/format.js";
import { emitJson } from "../core/output.js";
import { t } from "../core/i18n.js";

function listCommand(globals: GlobalArgs): void {
  const current = resolveSite(globals);
  if (emitJson({ Current: current, Sites: allowedSites() })) return;
  console.log(`   ${pad("SITE", 8)}`);
  for (const site of allowedSites()) {
    const marker = site === current ? "*" : " ";
    const tail = site === current ? `    ${t("common.activeMarker")}` : "";
    console.log(`${marker}  ${pad(site, 8)}${tail}`);
  }
  console.log(t("site.list.hint"));
}

function currentCommand(globals: GlobalArgs): void {
  let source: string;
  if (globals.site) {
    source = t("site.source.cli");
  } else if (process.env["THCLI_SITE"]) {
    source = t("site.source.env");
  } else if (getSetting("site")) {
    source = t("site.source.file");
  } else {
    source = t("site.source.default", { site: DEFAULT_SITE });
  }
  if (emitJson({ Site: resolveSite(globals), Source: source })) return;
  console.log(t("site.current.line", { site: resolveSite(globals), source }));
}

function useCommand(opts: Record<string, string>): void {
  if (opts["clear"]) {
    clearSetting("site");
    console.log(t("site.use.cleared", { site: DEFAULT_SITE }));
    return;
  }
  const name = opts["name"];
  if (!name) {
    throw new Error(t("site.use.missing"));
  }
  if (!allowedSites().includes(name)) {
    throw new Error(t("site.use.unknown", { name, options: allowedSites().join(", ") }));
  }
  setSetting("site", name);
  console.log(t("site.use.switched", { name }));
}

/** 装配 site 命令组 */
export function registerSiteCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const site = program.command("site").description(t("group.site.desc"));

  site.command("list").description(t("site.list.desc")).action(() => listCommand(getGlobals()));
  site
    .command("current")
    .description(t("site.current.desc"))
    .action(() => currentCommand(getGlobals()));
  site
    .command("use")
    .description(t("site.use.desc"))
    .option("--name <name>", "cn | intl")
    .option("--clear", t("site.use.opt.clear"))
    .action((opts) => useCommand(opts));
}
