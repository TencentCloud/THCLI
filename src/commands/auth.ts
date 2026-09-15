/**
 * auth 命令组：login / logout / set / status。
 *
 * login 走 OAuth 授权码模式，复用官方 app_id + loopback 回调，用户无需申请
 * app_id 或配回调域名。set 用于手填永久密钥（type=static）。
 */
import fs from "node:fs";
import readline from "node:readline";
import { randomBytes } from "node:crypto";
import { Command } from "commander";

import { startCallbackServer } from "../core/browser-flow.js";
import { allowedSites, callbackUrlOf, portalOf } from "../core/config.js";
import {
  type GlobalArgs,
  mask,
  parseGlobalArgs,
  resolveProfile,
  resolveSite,
} from "../core/credentials.js";
import { getTempCred, type OAuthToken, saveCredential } from "../core/oauth.js";
import { resolveIdentity } from "../core/identity.js";
import { CONFIG_DIR, credentialPath } from "../core/paths.js";
import { ensureDataPlaneKey } from "../core/provision.js";
import { printAligned } from "../core/format.js";
import { emitJson, isJson } from "../core/output.js";
import { t } from "../core/i18n.js";
import { openBrowser } from "../util/browser.js";

/**
 * 拼授权 URL。redirect_url 是嵌套的两层：
 *   外层给腾讯云 = 鉴权后端的回调地址（必须是已登记的回调域名，见 callbackUrlOf）
 *   内层是后端的 query 参数 redirect_url = 本机 loopback（告诉后端换完令牌往哪跳回来）
 * localhost 不是任何注册域名，故必须由后端中转一次。
 */
function buildAuthUrl(state: string, site: string, port?: number): string {
  const portal = portalOf(site);
  // 授权页语言按站点取：国内站中文、国际站英文
  const language = portal.lang;
  const callbackURL = callbackUrlOf(site);
  const redirectParams = new URLSearchParams(
    port === undefined
      ? { browser: "no", lang: language, site }
      : { redirect_url: `http://localhost:${port}`, lang: language, site },
  );
  const params = new URLSearchParams({
    scope: "login",
    app_id: String(portal.appId),
    redirect_url: `${callbackURL}?${redirectParams.toString()}`,
    state,
  });
  return `${portal.authUrl}?${params.toString()}`;
}

/**
 * 无浏览器模式（--browser no）：本机没有图形浏览器时（SSH、容器、CI）用。
 *
 * 与浏览器模式的差异：不起 loopback 服务（浏览器在另一台机器上，访问不到本机
 * loopback），改由后端在 browser=no 时渲染页面显示凭据串，用户手工粘贴回来。
 * 凭据串是 base64 编码的令牌 JSON（含 accessToken/refreshToken/openId），
 * 不是原始 code——code 只有 6 分钟有效期，跨机器复制来不及。
 */
async function loginWithoutBrowser(state: string, site: string, profile: string): Promise<void> {
  console.log(t("auth.noBrowser.line1"));
  console.log(t("auth.noBrowser.line2"));
  console.log("");
  console.log(buildAuthUrl(state, site));
  console.log("");

  const pasted = await promptLine(t("auth.noBrowser.prompt"));
  if (!pasted) {
    console.error(t("auth.noBrowser.empty"));
    process.exit(1);
  }

  let token: OAuthToken;
  try {
    token = JSON.parse(Buffer.from(pasted, "base64").toString("utf8")) as OAuthToken;
  } catch {
    console.error(t("auth.noBrowser.badFormat"));
    process.exit(1);
  }
  if (!token.accessToken) {
    console.error(t("auth.noBrowser.noToken"));
    process.exit(1);
  }
  // 无浏览器模式下 state 由授权页原样带进凭据串，仍需比对防止串号。
  // 不能写成 `token.state && token.state !== state`：凭据串是用户粘贴进来的，
  // 空 state 会让 && 短路、整个校验被跳过，等于给伪造的凭据串开了后门。
  if (token.state !== state) {
    console.error(t("auth.noBrowser.stateMismatch"));
    process.exit(1);
  }

  const cred = await getTempCred(token.accessToken, token.site || site);
  saveCredential(token, cred, profile, site);
  await prefetchIdentity(profile, site);
  console.log("");
  console.log(t("auth.login.saved", { path: credentialPath(profile, site) }));
}

/** 读一行用户输入（用于粘贴凭据串） */
function promptLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * 登录成功后顺带把账号身份（uin/appId）查出来存进凭证。
 *
 * monitor 用 uin 做云监控的查询维度，测试环境还要用它做请求头路由——趁刚拿到
 * 凭证时一并取好，后续命令就不必各自触发一次查询。失败只是少了这份缓存，
 * 用到时会再查，所以不打断登录、也不打扰用户。
 */
async function prefetchIdentity(profile: string, site: string): Promise<void> {
  try {
    await resolveIdentity({ profile, site });
  } catch {
    // 该接口在部分环境可能不可用；不影响登录本身
  }
}

/**
 * 登录成功后备一把对话用的 Key（供 +chat）。
 *
 * **两条登录路径都必须调用它**：曾经它只写在 loginCommand 尾部，而 --browser no
 * 分支在中途就 return 了，于是 SSH / 容器 / CI 用户登录后永远拿不到 Key——偏偏
 * 这些环境的用户最不方便去控制台建 Key 再复制粘贴。抽成函数就是为了让"新增一种
 * 登录方式时漏掉这步"不再可能发生。
 *
 * 失败只提示不中断：登录本身已经成功了，没有 Key 只影响 +chat，用户仍可用其它命令。
 * 它要连调 2~3 个云 API（查/建/取明文），耗时数秒，先给个进度提示免得像卡住。
 */
async function provisionChatKey(globals: GlobalArgs): Promise<void> {
  console.log(t("auth.login.provisioning"));
  const note = await ensureDataPlaneKey(globals);
  if (note) {
    console.log(note);
  }
}

async function loginCommand(opts: { browser?: string }, globals: GlobalArgs): Promise<void> {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  if (!allowedSites().includes(site)) {
    console.error(t("auth.login.badSite", { site, options: allowedSites().join(", ") }));
    process.exit(1);
  }

  // state 用于防 CSRF：回调带回来的必须与本地生成的一致
  const state = randomBytes(8).toString("hex");

  if (opts.browser === "no") {
    await loginWithoutBrowser(state, site, profile);
    await provisionChatKey(globals);
    return;
  }

  const server = await startCallbackServer(state);
  const authUrl = buildAuthUrl(state, site, server.port);

  if (!(await openBrowser(authUrl))) {
    // 拉不起浏览器通常意味着这是台无图形界面的机器（SSH / 容器 / CI）。
    // 此时回调地址 localhost:{port} 指向的是**用户浏览器所在的机器**，而服务
    // 在这台机器上、且只绑 127.0.0.1，跨机器必然 ERR_CONNECTION_REFUSED。
    // 所以不再打印那个注定失败的链接，直接引导去 --browser no。
    server.close();
    console.log(t("auth.login.browserFailed"));
    console.log("");
    console.log(t("auth.login.useNoBrowser"));
    console.log("");
    console.log("    thcli auth login --browser no");
    return;
  }
  console.log(t("auth.login.browserOpened"));
  console.log(authUrl);

  try {
    // state 已在回调服务里换密钥前校验过（见 startCallbackServer）
    const { token, cred } = await server.result;
    saveCredential(token, cred, profile, site);
    await prefetchIdentity(profile, site);
    console.log("");
    console.log(t("auth.login.saved", { path: credentialPath(profile, site) }));
  } finally {
    server.close();
  }

  await provisionChatKey(globals);
}

function logoutCommand(globals: GlobalArgs): void {
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  const path = credentialPath(profile, site);
  try {
    fs.unlinkSync(path);
    console.log(t("auth.logout.done", { path }));
  } catch {
    console.log(t("auth.logout.notFound", { path }));
  }
}

function setCommand(
  opts: { secretId?: string; secretKey?: string; token?: string },
  globals: GlobalArgs,
): void {
  if (!opts.secretId || !opts.secretKey) {
    console.error(t("auth.set.missing"));
    process.exit(1);
  }
  const profile = resolveProfile(globals);
  const site = resolveSite(globals);
  const payload: Record<string, string> = {
    type: "static",
    secretId: opts.secretId,
    secretKey: opts.secretKey,
  };
  if (opts.token) {
    payload["token"] = opts.token;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const path = credentialPath(profile, site);
  fs.writeFileSync(path, `${JSON.stringify(payload, null, 4)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(path, 0o600);
  } catch {
    // 某些文件系统不支持 chmod
  }
  console.log(t("auth.set.done", { path }));
}

function statusCommand(globals: GlobalArgs): void {
  const cred = parseGlobalArgs(globals);

  /**
   * 凭证是否「当前就能用」。
   *
   * 不能只看凭证文件存不存在：临时密钥过期后文件仍在，若据此返回 0，脚本与 Agent
   * 会拿到假绿灯——文案明明写着「已过期」，退出码却说没事，于是它们跳过登录、
   * 直接执行后续命令，撞上 AuthFailure.TokenFailure 却归因不到这里。
   *
   * 注意这与「自动续期」不冲突：续期发生在真正调用云 API 之前（见 oauth.ts 的
   * maybeRefreshCredential），而 status 是纯本地检查、不发请求，所以它只能如实
   * 报告手上这份密钥的状态。已过期就该判为未就绪，让调用方重新登录。
   */
  const expired =
    cred.raw.type === "oauth" &&
    typeof cred.raw.expiresAt === "number" &&
    cred.raw.expiresAt - Date.now() / 1000 <= 0;
  const ready = cred.source !== "none" && !expired;

  // 本地凭证状态没有云端响应可 dump，故自行定义结构。SecretId 打码，与文本模式一致。
  if (isJson()) {
    const expiresAt = cred.raw.type === "oauth" ? (cred.raw.expiresAt ?? null) : null;
    emitJson({
      LoggedIn: ready,
      Expired: expired,
      Profile: cred.profile,
      Site: cred.site,
      Source: cred.source,
      SecretId: mask(cred.secretId),
      Region: cred.region,
      Type: cred.raw.type ?? (cred.token ? "temporary" : "permanent"),
      ExpiresAt: expiresAt,
      // 临时密钥会自动续期，这里只是当前这份的剩余时间，不代表需要重新登录
      ExpiresInMinutes: expiresAt ? Math.round((expiresAt - Date.now() / 1000) / 60) : null,
      OAuthSite: cred.raw.oauth?.site ?? null,
    });
    // 退出码语义与文本模式保持一致：未登录或已过期为 1，便于脚本判断
    if (!ready) {
      process.exit(1);
    }
    return;
  }

  // 标签列宽按实际标签自适应：中英文标签长度不同，硬编码空格会让英文界面错位
  const rows: Array<[string, string]> = [
    ["profile", cred.profile],
    ["site", cred.site],
  ];

  if (cred.source === "none") {
    rows.push([t("auth.status.labelCred"), t("auth.status.none")]);
    printAligned(rows);
    // 非 0 退出，让脚本与 Agent 能靠退出码判断"是否已登录"，
    // 不必去匹配随语言变化的提示文案
    process.exit(1);
  }

  rows.push([t("auth.status.labelSource"), t(`cred.source.${cred.source}`)]);
  rows.push(["SecretId", mask(cred.secretId)]);
  rows.push(["Region", cred.region]);
  rows.push([
    t("auth.status.labelType"),
    cred.raw.type ?? (cred.token ? t("auth.status.temp") : t("auth.status.permanent")),
  ]);

  if (cred.raw.type === "oauth" && cred.raw.expiresAt) {
    const remaining = Math.round((cred.raw.expiresAt - Date.now() / 1000) / 60);
    const when = new Date(cred.raw.expiresAt * 1000).toLocaleString();
    rows.push([
      t("auth.status.labelTempKey"),
      remaining > 0
        ? t("auth.status.expiry", { when, minutes: remaining })
        : t("auth.status.expired", { when }),
    ]);
    if (cred.raw.oauth?.site) {
      rows.push([t("auth.status.labelSite"), cred.raw.oauth.site]);
    }
  }

  printAligned(rows);

  // 已过期与未登录同样返回 1：文案说「已过期」而退出码说没事，会让脚本与 Agent
  // 拿到假绿灯、跳过重新登录，最终在别处撞上 AuthFailure.TokenFailure
  if (!ready) {
    process.exit(1);
  }
}


/** 装配 auth 命令组 */
export function registerAuthCommands(program: Command, getGlobals: () => GlobalArgs): void {
  const auth = program.command("auth").description(t("group.auth.desc"));

  auth
    .command("login")
    .description(t("auth.login.desc"))
    .option("--browser <mode>", t("auth.login.opt.browser"))
    .action(async (opts: { browser?: string }) => {
      await loginCommand(opts, getGlobals());
    });

  auth
    .command("logout")
    .description(t("auth.logout.desc"))
    .action(() => logoutCommand(getGlobals()));

  auth
    .command("set")
    .description(t("auth.set.desc"))
    .requiredOption("--secret-id <id>", "SecretId")
    .requiredOption("--secret-key <key>", "SecretKey")
    .option("--token <token>", t("auth.set.opt.token"))
    .action((opts: { secretId?: string; secretKey?: string; token?: string }) =>
      setCommand(opts, getGlobals()),
    );

  auth
    .command("status")
    .description(t("auth.status.desc"))
    .action(() => statusCommand(getGlobals()));
}
