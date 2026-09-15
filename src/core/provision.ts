/**
 * 登录后自动为用户备一把数据面 Key（thcli-key），省掉「去控制台建 Key 再复制粘贴」。
 *
 * best-effort：此时管控凭证已落盘、登录已经成功，这一步任何失败都只返回提示文案，
 * 不影响登录结果。用固定名字做幂等，避免每次登录都新建一把。
 */
import { buildClient } from "./client.js";
import { t } from "./i18n.js";
import { DEFAULT_REGION } from "./config.js";
import type { GlobalArgs } from "./credentials.js";
import { loadDataConfig, saveDataConfig, setRegionKey } from "./keystore.js";

/** 幂等用的固定 Key 名 */
const KEY_NAME = "thcli-key";
const PLATFORM = "maas";
const BIND_TYPE = "all";
const FIELD = "th";
const ALIAS = "default";

interface ApiKeyBrief {
  ApiKeyId?: string;
  Name?: string;
  Status?: string;
}

function store(profile: string, site: string, plaintext: string): void {
  const cfg = loadDataConfig(profile);
  setRegionKey(cfg, site, DEFAULT_REGION, FIELD, plaintext, ALIAS);
  saveDataConfig(profile, cfg);
}

/**
 * 确保有一把可用的数据面 Key。返回给用户看的提示；无话可说时返回空串。
 */
export async function ensureDataPlaneKey(args: GlobalArgs): Promise<string> {
  try {
    const client = buildClient(args);
    const { profile, site } = client;

    // 云 API 只支持 FUZZY 匹配，拿回来后还要本地按全等再筛一次
    // 带 Limit 只为不依赖后端默认页大小；FUZZY 过滤本身已让后端只返回同名的少数
    // 几条（实测账号下 129 把密钥时也只返回 1 条），故这里不是性能优化点。
    // 留 20 的余量是因为 FUZZY 可能匹配到名字含 thcli-key 的其它 key，再本地精筛。
    const listResp = await client.call("DescribeApiKeyList", {
      Platform: PLATFORM,
      Filters: [{ Name: "apiKeyName", Op: "FUZZY", Values: [KEY_NAME] }],
      Limit: 20,
    });
    const keys = (listResp["ApiKeySet"] as ApiKeyBrief[] | undefined) ?? [];
    const matches = keys.filter((k) => k.Name === KEY_NAME);

    let keyId: string | undefined;
    if (matches.length > 0) {
      const hit = matches[0]!;
      if ((hit.Status ?? "").toLowerCase() === "disable") {
        return t("provision.keyDisabled", { name: KEY_NAME, id: hit.ApiKeyId });
      }
      keyId = hit.ApiKeyId;
    } else {
      const created = await client.call("CreateApiKey", {
        Platform: PLATFORM,
        ApiKeyName: KEY_NAME,
        BindType: BIND_TYPE,
        Remark: "created by thcli",
      });
      keyId = created["ApiKeyId"] as string | undefined;
    }

    if (!keyId) {
      return t("provision.noKeyId");
    }

    // 列表接口不返回明文，要再查一次详情
    const detail = await client.call("DescribeApiKey", { Platform: PLATFORM, ApiKeyId: keyId });
    const plaintext = detail["ApiKey"] as string | undefined;
    if (!plaintext) {
      return t("provision.noSecret");
    }

    store(profile, site, plaintext);
    return t("provision.done", { name: KEY_NAME, scope: `${site}/${DEFAULT_REGION}/th/default` });
  } catch (err) {
    return (
      `${t("provision.failed", { message: (err as Error).message })}\n` +
      t("provision.failedHint")
    );
  }
}
