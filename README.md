# dsh-simple-remote

[English](README.en.md) | 中文

只用一个插件就可以手机也访问到DSH。安装即用，不用配置。

只使用Tailscale，安装了这个软件的设备就组网了，可以互相访问。
把 DeepSeek Harness 的网页界面（`dsh --profile web` 的 GUI）**只**开放给本机的 Tailscale tailnet：
在 Tailscale 网卡地址上另开一个监听端口，反向代理到本机回环上的 GUI。
于是「连上 Tailscale 的手机」直接打开网页就能用，而局域网、WSL、虚拟网卡上的其他设备连端口都看不到。

## 它做什么

```
手机 (Tailscale)  ──► 100.x.y.z:3080   ┐
                                       │ dsh-simple-remote 反向代理（改写 Host/Origin 为回环）
本机浏览器        ──►  127.0.0.1:3080  ─┴─►  dsh 自带的 Web 服务（保持只监听回环）
```

- **不改变** dsh 自带 Web 服务的绑定：它仍然只监听 `127.0.0.1`，LAN 与虚拟网卡都不会被暴露。
- **不放宽**自带的 Host/Origin 防护栅栏：代理把转发请求的 Host 改写为回环地址，因此没有新增任何「受信域名」；
  `Origin` 仅在它与收到的请求同源时才改写，跨站请求保留原 Origin 并被栅栏拒绝（403）。
- **保留**自带认证：会话 cookie、`/api` 令牌校验全部照旧，只是由代理代为完成首次登录（`autoToken`）。
- WebSocket（终端、远程流）与 SSE 事件流按原样透传。

## 安装

npm（默认）

```
dsh plugin --profile web add dsh-simple-remote@latest
```

Github方式

```
dsh plugin --profile web add github:ivanant/dsh-simple-remote
```

或在 Web 界面「插件」页里安装这个包名 `dsh-simple-remote`。

安装后：

- 新增 Loader 行 `simple-remote`（包名 `dsh-simple-remote`）。
- 启动日志里会出现两行：
  `dsh web: tailnet http://100.111.128.100:3080 (Tailscale; auto-login)`
  `dsh web: tailnet name http://dev.tail3b32bf.ts.net:3080/ (MagicDNS)`
  第二行是完整 MagicDNS 名，只有在它确实解析回这台机器时才会出现。
- 设置 → 通用 里多出一行「手机访问（Tailscale）」，优先显示 MagicDNS 全名，下面附数字地址作为备用，都能一键复制。

装完后**手机端**：连上 Tailscale，直接打开 `http://<机器名>.<tailnet>.ts.net:3080/` 即可
（例如 `http://dev.tail3b32bf.ts.net:3080/`）。首次访问时插件自动完成登录（见下），浏览器随后记住 30 天。

### 桌面版（Desktop）

桌面版内部跑的就是同一套 Web 应用（`--no-open --host 127.0.0.1 --port 0`），
回环端口每次启动都随机；插件默认把**手机侧端口固定在 3080**，所以手机地址不会变。

安装到 desktop profile：

```
dsh plugin --profile desktop add dsh-simple-remote
```

或在桌面应用的「插件」页里安装。装好后不用改配置，手机打开 `http://<tailnet 地址>:3080/` 即可。

## 配置

安装后直接使用就行。特殊情况可以配置：

行配置写在 `cordis.patch.yml` 里（安装后是 `~/.dsh/profiles/web/node_modules/dsh-simple-remote/cordis.patch.yml`，
也可以用 profile 自己的 patch 层覆盖，注意 patch 是整体替换 `config`，要保留的键都得重写）：

```yaml
- id: simple-remote
  name: dsh-simple-remote
  config:
    enabled: true # false = 完全关闭，不监听任何 tailnet 端口
    autoToken: true # 见「安全」一节
    address: "" # 留空 = 自动探测 Tailscale 地址（100.64.0.0/10）；也可写死地址或 MagicDNS 名
    port: 3080 # 手机侧固定端口；写 0 = 改成跟随回环 GUI 的端口
    log: true # 是否把地址行同时打印到 dsh 进程输出
```

端口**只用 Tailscale 地址**，所以手机侧 3080 和回环的 3080 不冲突。
一个 tailnet 端口同一时间只能被一个实例占用：如果想同时暴露 web profile 和桌面版，
给其中一个改成别的号（例如 3081）。

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

令牌来源按新版优先：当前版本通过 `webserver/entry-url` 事件发布带令牌的入口地址，插件从这张表里取；
旧版本没有这个事件时，回退到 `connection.authenticatedUrl()`。两者都没有时自动登录保持关闭（日志会提示一次）。

**桌面版**下回环端口每次启动都会变，所以会话 cookie 会随之失效：
保持 `autoToken: true` 时手机会自动重新登录；若关掉 `autoToken`，每次重启桌面应用都要重新复制一次带令牌的链接。

无论哪种模式，端口都只绑在 Tailscale 地址上，`0.0.0.0` 从未被使用，
所以局域网 / 公共网络里的设备无法访问（这也是 dsh 官方拒绝 `--host 0.0.0.0` 的那条红线）。

## 验证

`node test/smoke.mjs` 会在 Harness 之外跑一遍插件本体（共 17 项）：浏览器半段的工厂与渲染（自动登录 / 令牌 / 关闭三种状态、
MagicDNS 名在前、数字地址作为备用、端口被占用时的提示、复制按钮）、代理的令牌跳转、cookie 透传、`/api` 的 Host/Origin 改写、
跨站 Origin 保持原样、WebSocket 升级、页面状态注入、`webserver/entry-url` 令牌来源、端口占用上报，以及卸载时关闭监听。

装到活的 Harness 之后也实测过（本机经 Tailscale 地址访问）：

| 检查                                                | 结果                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| 监听地址                                            | `100.111.128.100:3080`（插件）+ `127.0.0.1:3080`（dsh 自带，未改动） |
| 无 cookie 的导航（带 `Sec-Fetch-Mode: navigate`）   | 200，返回 35 KB 首页，并拿到 `dsh-auth-…` 会话 cookie                |
| `POST /api/<未知端点>`（带 cookie）                 | 404 —— 说明 Host/Origin 栅栏与认证都通过了                           |
| 同上但无 cookie                                     | 401                                                                  |
| 同上但 `Origin: https://evil.example`               | 403                                                                  |
| 插件资源 `plugins/??dsh-simple-remote/client.js`    | 200                                                                  |
| WebSocket `GET /api/remote.mux`（带 cookie / 不带） | 101 / 401                                                            |
| 回环地址 `http://127.0.0.1:3080/`（无 cookie）      | 401，与装插件前一致                                                  |

未能在此机器上验证的只有一项：**另一台设备（手机）经网络真实连入**——本机防火墙规则需要管理员权限才能查看。
若手机超时，见下面的排错表。

## 排错

| 现象                                     | 处理                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 手机连不上、本机也访问不了该地址         | 看 dsh 日志里有没有 `simple-remote: ... listener failed`；确认 Tailscale 已连接且本机有 `100.x.y.z` 地址                                                                                                                                                                                                                                                                       |
| 日志里出现「no Tailscale address found」 | Tailscale 未运行，或地址不在 `100.64.0.0/10`；用 `address` 配置写死地址                                                                                                                                                                                                                                                                                                        |
| 本机可访问、手机超时                     | Windows 防火墙拦了入站。管理员 PowerShell 里执行（把 `<node.exe 路径>` 换成 `where.exe node` 的结果）：`New-NetFirewallRule -DisplayName "DSH Tailscale Remote" -Direction Inbound -Program "<node.exe 路径>" -Action Allow -Profile Any`；或只放行端口：`New-NetFirewallRule -DisplayName "DSH Web Tailscale" -Direction Inbound -Protocol TCP -LocalPort 3080 -Action Allow` |
| 手机打开是 401                           | `autoToken` 被关掉了；用带 `?token=` 的链接打开一次。若设了 `autoToken: true` 仍是 401，看日志里有没有「auto-login is inactive」：这个 Host 没有发布令牌                                                                                                                                                                                                                      |
| 手机用短名（如 `workspace`、`dev`）打不开 | 短名要靠系统搜索域去补 `.<tailnet>.ts.net`，手机系统（尤其 Android）通常不带这个搜索域，所以短名解析不到目标地址。用插件打印的**完整** MagicDNS 名（`你的机器名.<tailnet>.ts.net:3080`）；短名如果解析到了别的机器，说明 tailnet 里另一台设备（或没清掉的旧节点）占着这个名字，去管理后台确认、改名或删除                                                                                     |
| 手机页面能开但接口 403                   | 你在用别的域名/地址访问（例如反向代理改名）；请加 `--trusted-host` 或改用插件打印的地址                                                                                                                                                                                                                                                                                        |
| 日志出现「port 3080 ... already in use」 | 手机侧 3080 已被别的进程占用（常见：另一个 DSH 实例也装了这个插件）。插件不会抢占或改端口，只报告冲突；关掉占用者，或把 `port` 改成别的号（例如 3081）。设置 → 通用 里也会显示这条提示                                                                                                                                                                                         |
| 想换端口                                 | 改 `port`。注意默认是固定 3080，不再跟随回环端口；写 `port: 0` 才恢复跟随                                                                                                                                                                                                                                                                                                      |

## 改代码后如何生效

- `client.js`（设置页那一行）：改完刷新页面即可，浏览器会重新拉取插件资源。
- `index.js`（代理那一半）：ESM 模块有缓存，**必须重启 dsh**（或在插件页里禁用再启用该 bundle）才会加载新代码；
  所以改动前先跑 `node test/smoke.mjs` 自检，别把坏代码喂给正在跑的服务。

## 已知边界

- 只支持 IPv4 的 tailnet 地址（Tailscale 一定会分配一个 `100.64.0.0/10` 地址）。
- 手机上是普通 HTTP，不是安全上下文（Tailscale 的 HTTPS 证书需要另一套机制，例如 `tailscale serve`）；
  测过的功能不受影响，但浏览器 API 里要求安全上下文的能力（如 Service Worker）不可用。
- 只在启动时探测一次地址；Tailscale 换地址后需要重启 dsh（或重载该插件行）。
- MagicDNS 名是启动后异步查一次（直接问 `100.100.100.100`，超时 1.2 s）并做反向校验的；查不到就只显示数字地址，
  不影响访问。名字必须在查到的那一刻解析回同一个地址，否则不显示。
- 手机侧端口固定后，同一时间只有一个实例能对外（见「配置」）；被占用时插件只报告，不会换端口。
