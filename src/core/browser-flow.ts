/**
 * OAuth 回调的本地 loopback 服务：接住授权页重定向回来的 token。
 *
 * 安全说明：只绑 127.0.0.1，不绑全部网卡（''）。绑全部网卡意味着授权窗口期内
 * 同网段的机器也能访问这个端口，是不必要的暴露面。
 */
import http from "node:http";

import { getTempCred, type OAuthToken, type TempCredential } from "./oauth.js";

/** 端口搜索范围：9000 起，往上找 100 个 */
export const START_PORT = 9000;
const PORT_SEARCH_COUNT = 100;

/** 授权结果 */
export interface AuthResult {
  token: OAuthToken;
  cred: TempCredential;
}

/**
 * 启动 loopback 服务，返回实际端口和一个等待授权结果的 Promise。
 *
 * expectedState 是本次登录生成的随机串，必须在换临时密钥【之前】比对：
 * 回调是任何本机进程都能构造的请求，先换密钥再验 state 意味着伪造的回调
 * 也能让我们白替它兑换一次真实密钥。
 */
export async function startCallbackServer(expectedState: string): Promise<{
  port: number;
  result: Promise<AuthResult>;
  close: () => void;
}> {
  let resolveResult!: (value: AuthResult) => void;
  let rejectResult!: (err: Error) => void;
  const result = new Promise<AuthResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  // 浏览器的回调连接是 keep-alive 的，它不会主动断开。而 server.close() 只是
  // 停止接受新连接、等已有连接自然结束——于是那个 socket 会把 close() 和整个
  // 进程一起挂住（登录流程全部打印完却不退出）。故自行记录并在关闭时销毁。
  const sockets = new Set<import("node:net").Socket>();

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const q = url.searchParams;
        const token: OAuthToken = {
          openId: q.get("open_id") ?? "",
          accessToken: q.get("access_token") ?? "",
          refreshToken: q.get("refresh_token") ?? "",
          expiresAt: Number(q.get("expires_at") ?? 0),
          state: q.get("state") ?? "",
          site: q.get("site") ?? "cn",
        };
        // 先验 state 再换密钥：不匹配就当场拒绝，不拿这个 token 去请求后端
        if (token.state !== expectedState) {
          res.writeHead(400);
          res.end("login failed: state mismatch");
          rejectResult(new Error(`invalid state ${token.state}`));
          return;
        }
        const cred = await getTempCred(token.accessToken, token.site);
        // 把浏览器送回授权门户的落地页，用户不会停在空白页
        res.writeHead(307, { Location: q.get("redirect_url") ?? "https://cloud.tencent.com" });
        res.end();
        resolveResult({ token, cred });
      } catch (err) {
        const message = (err as Error).stack ?? String(err);
        res.writeHead(400);
        res.end(`login failed due to the following error:\n\n${message}`);
        rejectResult(err as Error);
      }
    })();
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await new Promise<number>((resolve, reject) => {
    let candidate = START_PORT;
    const tryListen = (): void => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && candidate < START_PORT + PORT_SEARCH_COUNT) {
          candidate += 1;
          tryListen();
          return;
        }
        reject(
          err.code === "EADDRINUSE"
            ? new Error(`no port available from range [${START_PORT}, ${START_PORT + PORT_SEARCH_COUNT}]`)
            : err,
        );
      });
      // 只监听回环地址，不暴露给同网段
      server.listen(candidate, "127.0.0.1", () => resolve(candidate));
    };
    tryListen();
  });

  const close = (): void => {
    server.close();
    // 浏览器不会主动断开 keep-alive 连接，必须自行销毁，否则进程不退出
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  };

  return { port, result, close };
}
