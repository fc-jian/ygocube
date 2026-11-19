# 09 - 网页对战与录像

## 使用与启动

对战页提供「进入网页对战」、公开观战和录像入口。玩家从个人 URL 进入，继续使用现有 token；卡组由服务器同步，不需要下载 ydk 或启动客户端。原生客户端入口保留，支持网页与原生 TCP 客户端混合对战。

先构建共享协议包和应用，并编译 srvpro CoffeeScript：

```bash
cd cube
pnpm install
pnpm build
cd ..
node srvpro/node_modules/coffeescript/bin/coffee -c srvpro/cube.coffee srvpro/cube-validation.coffee srvpro/ygopro-server.coffee
```

Node 运行版本须与 better-sqlite3 原生模块一致；本次联调使用 Node 22。修改根 `config.yaml`：

```yaml
web_duel:
  enabled: true
  archive_dir: data/web-replays
  upstream_host: 127.0.0.1
  protocol_version: 4962
  max_connections: 200
```

`archive_dir` 由配置文件目录解析为绝对路径，传给 srvpro 私有接口；srvpro 用户必须可以写入该路径。远程 srvpro 时使用其可写的绝对路径，并设置 `upstream_host`。两端必须使用本次更新后的版本，宿主协议版本须与 `PRO_VERSION` 一致。

启用只影响之后新建的房间，已有进行中的房间不补录。默认关闭；关闭后隐藏入口并撤销网页会话，但不会删除录像或重启宿主。应在无活动对局时改变开关。

## 链路与权限

`浏览器 → WSS → Cube API → srvpro TCP → ygopro 宿主/ocgcore`。

玩家申请 30 秒一次性票据，WebSocket 建立后在首条 JSON 消息认证，token 不放入 WebSocket URL。握手、初始卡组和计时确认由服务端处理；客户端只能提交允许的操作。交互编号阻止重复和过期响应，同一玩家的新连接接管旧连接。无效卡组由网关与宿主共同检查。

公开观战是匿名只读例外。每房间复用一条内部公开观战流，网关维护公开状态快照，使中途加入无需重放整个历史。禁止客户端发送观战指令，也禁止原生 yrp 数据透传到浏览器。SSE 保持现有脱敏契约。

断线恢复依赖 srvpro 的 reconnect 模块，必须启用 `modules.reconnect.enabled`；浏览器刷新会重新取得票据，通过原始卡组校验恢复场面。当前换备从受保护的 `/cube/web-player` 读取，避免恢复后丢失已换备的布局。宿主崩溃不能无损续局，沿用现有房间故障处理。

## 界面与协议

共享协议包为 `@ygocube/duel-protocol`，无浏览器或 Node 专用运行时依赖。实现 TCP 帧重组、STOC 状态解析、选择提示和 RESPONSE 编码。规则计算仍在 ocgcore；宣言、求和、祭品等交互提供前端约束，宿主保留最终裁决。

桌面中央场地、侧栏详情/日志；手机竖屏双方场地、共享额外怪兽区、可横向滚动手牌和底部选择面板。点击卡片可查看文本或操作，不依赖悬停和右键。支持猜拳、先后手、连锁、卡片/素材选择、场地、表示形式、计数器、排序、宣言、投降和 BO3 换备。

未知关键协议消息会显示兼容错误并中止连接，不能猜测回复。当前宿主查询中的保留位 `0x100000` 不携带额外字节；全零隐藏查询可能保留原始段长度，必须整体清除卡片身份与属性，不能将其解释为正常查询。

## 录像与运维

srvpro 在房间创建后连接独立公开 recorder 和全信息 recorder，写入 `public.ndjson`、`full.ndjson` 与原子更新的 `meta.json`。每条消息包含相对时间及原生完整帧；记录宿主、CDB 和 Lua 资源摘要。每路最多 128 MiB，写盘失败或非正常断开标记不完整。正常封存要求收到宿主的结束包。

API 在建房时保存去重、压缩的卡片目录与效果选项文本，旧录像使用当时文本。SQLite 新增 `web_replays`、`web_replay_audit`、`web_replay_catalogs`、`web_replay_catalog_matches`；启动自动创建，不修改历史比赛日志格式。

整个 tournament 进入 `finished` 后才开放匿名全知录像。单个 BO3 结束不开放；API 每次读取校验阶段并禁止缓存，回溯重新开放比赛后禁止后续读取。已下载内容无法收回。首版支持新对局录像的播放、单步、倍速、按局选择和快照跳转，不导入旧 yrp。

录像不放入 Next public 或 Nginx 静态目录。长期保留；管理员用 `POST /admin/t/:tid/matches/:mid/replay/delete` 显式清理。清理先记录审计，再删除归档和目录引用。备份须同时覆盖 SQLite 与 srvpro 的录像目录。

Nginx 在原 API location 之外增加精确 WSS 路由（`proxy_pass` 按实际 API 监听地址调整）：

```nginx
location = /api/duel/ws {
    proxy_pass http://127.0.0.1:3001/duel/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
    proxy_buffering off;
}
```

需将实际 HTTPS 来源加入 `server.allowed_origins`。发布仍遵循 standalone 静态目录同步、JS/CSS MIME、HTTPS 和服务健康检查约定。本次实现未部署生产。

## 验证

```bash
cd cube
pnpm --filter @ygocube/duel-protocol build
pnpm --filter @ygocube/duel-protocol test
pnpm --filter @ygocube/api test
pnpm --filter @ygocube/web test
pnpm build
cd ..
node scripts/e2e/web-duel-smoke.cjs
NATIVE_BOB=1 node scripts/e2e/web-duel-smoke.cjs
```

真实宿主测试自动创建独立 `/tmp/ygocube-web-*`、端口、数据库和 srvpro 配置，结束时停止测试子进程，保留日志便于诊断。覆盖鉴权、网页双方/网页与原生 TCP 混合 BO3、召唤、场地选择、换备、重连、公开观战手牌隐藏、观战只读、录像封存和比赛结束前后的发布门槛。复杂选择的字节布局另由协议单测覆盖；这些检查不等于穷举每张卡片效果。

浏览器回归脚本使用真实宿主测试保存的 `web-replay.json`，另以模拟 WebSocket 检查按钮的协议响应：

```bash
# 先启动已构建的 Web；按环境设置 Playwright 模块路径与 Chromium 可执行文件
PLAYWRIGHT_MODULE_PATH=/path/to/playwright CHROMIUM_PATH=/path/to/chrome \
  node scripts/e2e/web-duel-browser.cjs /tmp/ygocube-web-XXXXXX/web-replay.json http://127.0.0.1:3000
```

已验证 Chromium 的 360、390、430 与 1440 像素宽度：录像跳转、卡片详情、对战按钮响应、无页面异常及横向溢出。移动端使用触摸模拟，尚未进行真机 Safari 验证。

## 独立客户端

入口 `/duel` 不要求 Cube 比赛或玩家 token。输入昵称、房间密码，上传 YDK 或选择已保存卡组，即可创建/加入普通 srvpro 房间。相同密码对应同一房间，已有房间采用首位创建者的规则；房主由原生宿主按入场顺序决定。支持单局、BO3、当前禁限卡表、卡片范围、大师规则、秒数计时、LP/手牌/抽牌数、Main 最小/最大及 Extra/Side 最大、不检查和不洗牌。时间直接传入秒数，不经过旧 TIME token 的分钟转换。

独立房间不启用 Cube 卡组锁定、比赛结果回调或 Cube 录像录制。卡组仍由宿主按禁限规则校验；准备失败会显示宿主原因及关联卡号/数量。刷新重连凭据存放当前标签页 sessionStorage，服务端有效期 24 小时，服务重启后需重新入房；正在进行的房间沿用 srvpro 原有重连限制。

`/duel/decks` 提供全卡库名称/效果/编号搜索、卡图和详情，以及 Main、Extra、Side 三个区域。加入 Main 时将融合/同调/超量/连接卡自动分到 Extra；可以在主/额外和 Side 之间移动，保存、删除和导入/导出 YDK。衍生物不会进入搜索结果。

卡组暂存在会话 Cookie，Path 为 `/duel`，不附带到 `/api` 请求。最多 8 副，每副编码最多 3 KiB，合计约 7 KiB；达到限制或禁用 Cookie 时明确提示保存失败。上传会立即保存；构筑修改通过「保存」保存，离开时提示未保存修改。永久保留请导出 YDK，浏览器会话恢复可能延续会话 Cookie。

独立真实宿主测试（隔离数据库/端口，不创建 Cube 比赛）：

```bash
STANDALONE_ONLY=1 node scripts/e2e/web-duel-smoke.cjs
# 保留测试 API/srvpro 服务供手动检查
STANDALONE_ONLY=1 KEEP_SERVICES=1 node scripts/e2e/web-duel-smoke.cjs
```

输出目录包含 `fixture.ydk` 和 `local-services.json`（端口、配置路径和测试 PID）。Web 构建和启动时令 `CUBE_API_URL` 指向该 API。`standalone-browser.cjs <Web URL> <fixture.ydk>` 使用 Playwright 实际验证 WebSocket 代理、上传、准备/开局、Cookie 重载、Main/Side 移动和搜索详情；Playwright 路径参数与上述浏览器测试相同。测试服务由启动者手动停止，不改变根生产配置。
