# dsh-simple-remote

[English](README.en.md) | 中文

只用一个工具就可以手机也访问到DSH。只使用Tailscale，安装了这个软件的设备就组网了，可以互相访问。
把 DeepSeek Harness 的网页界面（`dsh --profile web` 的 GUI）**只**开放给本机的 Tailscale tailnet：
在 Tailscale 网卡地址上另开一个监听端口，反向代理到本机回环上的 GUI。
于是「连上 Tailscale 的手机」直接打开网页就能用，而局域网、WSL、虚拟网卡上的其他设备连端口都看不到。

## 它做什么

```
手机 (Tailscale)  ──►  100.x.y.z:3080  ┐
                                        │ dsh-simple-remote 反向代理（改写 Host/Origin 为回环）
本机浏览器        ──►  127.0.0.1:3080  ─┴─►  dsh 自带的 Web 服务（保持只监听回环）
```

- **不改变** dsh 自带 Web 服务的绑定：它仍然只监听 `127.0.0.1`，LAN 与虚拟网卡都不会被暴露。
- **不放宽**自带的 Host/Origin 防护栅栏：代理把转发请求的 Host 改写为回环地址，因此没有新增任何「受信域名」；
  `Origin` 仅在它与收到的请求同源时才改写，跨站请求保留原 Origin 并被栅栏拒绝（403）。
- **保留**自带认证：会话 cookie、`/api` 令牌校验全部照旧，只是由代理代为完成首次登录（`autoToken`）。
- WebSocket（终端、远程流）与 SSE 事件流按原样透传。

## 安装

插件是一个本地 bundle（本目录即包目录）。在 Harness 里用插件管理器安装：

```
plugin_manager { "action": "install_bundle", "target": "C:\\Users\\ivan\\Documents\\projects\\dsh-simple-remote" }
```

或在 Web 界面「插件」页里安装这个目录。安装后：

- 新增 Loader 行 `simple-remote`（包名 `dsh-simple-remote`）。
- 启动日志里会出现一行：
  `dsh web: tailnet http://100.111.128.100:3080 (Tailscale; auto-login)`
- 设置 → 通用 里多出一行「手机访问（Tailscale）」，显示地址并可一键复制。

装完后**手机端**：连上 Tailscale，直接打开 `http://<你的 tailnet 地址>:3080/` 即可。
首次访问时插件自动完成登录（见下），浏览器随后记住 30 天。

## 配置

行配置写在 `cordis.patch.yml` 里（安装后是 `~/.dsh/profiles/web/node_modules/dsh-simple-remote/cordis.patch.yml`，
也可以用 profile 自己的 patch 层覆盖，注意 patch 是整体替换 `config`，要保留的键都得重写）：

```yaml
- id: simple-remote
  name: dsh-simple-remote
  config:
    enabled: true      # false = 完全关闭，不监听任何 tailnet 端口
    autoToken: true    # 见「安全」一节
    address: ''        # 留空 = 自动探测 Tailscale 地址（100.64.0.0/10）；也可写死地址或 MagicDNS 名
    port: 0            # 0 = 与回环 GUI 同端口（默认 3080）
    log: true          # 是否把地址行同时打印到 dsh 进程输出
```

## 安全

`autoToken: true`（默认）意味着：**能连上这个端口的人，就等于拿到了这台机器的完全控制权**（可执行任意命令）。
边界因此完全落在 Tailscale 上——只有你自己的 tailnet 设备能连上，Tailscale 的 ACL / 设备授权就是这道门。
如果你在共享 tailnet（团队、家人）里，建议改成 `autoToken: false`：

```yaml
- id: simple-remote
  name: dsh-simple-remote
  config:
    autoToken: false
```

此时手机必须打开带 `?token=…` 的完整链接（启动日志 / 设置页可复制），行为与回环地址完全一致；
不知道令牌的 tailnet 设备只会收到 401。

无论哪种模式，端口都只绑在 Tailscale 地址上，`0.0.0.0` 从未被使用，
所以局域网 / 公共网络里的设备无法访问（这也是 dsh 官方拒绝 `--host 0.0.0.0` 的那条红线）。

## 验证

`node test/smoke.mjs` 会在 Harness 之外跑一遍插件本体（共 13 项）：浏览器半段的工厂与渲染（自动登录 / 令牌 / 关闭三种状态 + 复制按钮）、
代理的令牌跳转、cookie 透传、`/api` 的 Host/Origin 改写、跨站 Origin 保持原样、WebSocket 升级、页面状态注入、以及卸载时关闭监听。

装到活的 Harness 之后也实测过（本机经 Tailscale 地址访问）：

| 检查 | 结果 |
| --- | --- |
| 监听地址 | `100.111.128.100:3080`（插件）+ `127.0.0.1:3080`（dsh 自带，未改动） |
| 无 cookie 的导航（带 `Sec-Fetch-Mode: navigate`） | 200，返回 35 KB 首页，并拿到 `dsh-auth-…` 会话 cookie |
| `POST /api/<未知端点>`（带 cookie） | 404 —— 说明 Host/Origin 栅栏与认证都通过了 |
| 同上但无 cookie | 401 |
| 同上但 `Origin: https://evil.example` | 403 |
| 插件资源 `plugins/??dsh-simple-remote/client.js` | 200 |
| WebSocket `GET /api/remote.mux`（带 cookie / 不带） | 101 / 401 |
| 回环地址 `http://127.0.0.1:3080/`（无 cookie） | 401，与装插件前一致 |

未能在此机器上验证的只有一项：**另一台设备（手机）经网络真实连入**——本机防火墙规则需要管理员权限才能查看。
若手机超时，见下面的排错表。

## 排错

| 现象 | 处理 |
| --- | --- |
| 手机连不上、本机也访问不了该地址 | 看 dsh 日志里有没有 `simple-remote: ... listener failed`；确认 Tailscale 已连接且本机有 `100.x.y.z` 地址 |
| 日志里出现「no Tailscale address found」 | Tailscale 未运行，或地址不在 `100.64.0.0/10`；用 `address` 配置写死地址 |
| 本机可访问、手机超时 | Windows 防火墙拦了入站。管理员 PowerShell 里执行（把 `<node.exe 路径>` 换成 `where.exe node` 的结果）：`New-NetFirewallRule -DisplayName "DSH Tailscale Remote" -Direction Inbound -Program "<node.exe 路径>" -Action Allow -Profile Any`；或只放行端口：`New-NetFirewallRule -DisplayName "DSH Web Tailscale" -Direction Inbound -Protocol TCP -LocalPort 3080 -Action Allow` |
| 手机打开是 401 | `autoToken` 被关掉了；用带 `?token=` 的链接打开一次 |
| 手机页面能开但接口 403 | 你在用别的域名/地址访问（例如反向代理改名）；请加 `--trusted-host` 或改用插件打印的地址 |
| 想换端口 | 改 `port`，或用 `dsh --profile web --port 8080`（回环换端口后插件默认跟随） |

## 改代码后如何生效

- `client.js`（设置页那一行）：改完刷新页面即可，浏览器会重新拉取插件资源。
- `index.js`（代理那一半）：ESM 模块有缓存，**必须重启 dsh**（或在插件页里禁用再启用该 bundle）才会加载新代码；
  所以改动前先跑 `node test/smoke.mjs` 自检，别把坏代码喂给正在跑的服务。

## 已知边界

- 只支持 IPv4 的 tailnet 地址（Tailscale 一定会分配一个 `100.64.0.0/10` 地址）。
- 手机上是普通 HTTP，不是安全上下文（Tailscale 的 HTTPS 证书需要另一套机制，例如 `tailscale serve`）；
  测过的功能不受影响，但浏览器 API 里要求安全上下文的能力（如 Service Worker）不可用。
- 只在启动时探测一次地址；Tailscale 换地址后需要重启 dsh（或重载该插件行）。
