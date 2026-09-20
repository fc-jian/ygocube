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

## Aly 独立测试部署（2026-09-06）

公网入口：`https://39.96.220.91/duel`、`https://39.96.220.91/duel/decks`。

- release：`/opt/ygoduel/releases/20260906-independent-duel-r1`；Web build ID：`VP4OJFEM7_gP9_i78Ko9m`。
- 发布包 SHA-256：`6f965324e6459cc9c25adba80e2f8ad37e009993bdea0832dec1484651125d15`。基于根提交 `7ae3200e1ff52c3a4c5a02ceef82fea7790ceda1` 加当前未提交网页对战改动；包内逐文件 `checksums.json` 留存实际构建摘要。
- 独立系统用户 `ygoduel`，服务 `ygoduel-api`、`ygoduel-srvpro`、`ygoduel-web`；目录 `/opt/ygoduel/shared` 保存新数据库、配置、Cookie 会话对应的临时服务状态及资源副本。未复制或修改 Cube 比赛数据库。连接凭据保存在 API 内存中，重启失效。
- Web/API/srvpro TCP/HTTP 分别监听回环端口 `3100/3101/17911/17922`。srvpro 及子宿主通过 systemd `IPAddressDeny=any`、`IPAddressAllow=localhost` 限制网络，动态宿主端口也只能经本机代理访问。
- 服务器现有 ygopro、CDB、Lua、禁限表和 AVIF 复制到独立目录使用；只读复制旧应用依赖，新增 ws 与共享协议包。旧资源目录不写入。
- 新 Web 编译 `NEXT_PUBLIC_API_BASE=/duel-api`、`NEXT_ASSET_PREFIX=/duel-assets`，Nginx 只新增独立路径；未替换旧 Cube 前端，Cube 继续建房并要求原生客户端启动。独立实例的管理/比赛 API 不对公网开放。
- `ygoduel.slice` 限制 CPU 为 1 核时间、内存硬上限 600 MiB、软阈值 500 MiB；最多 8 个房间、32 个网关连接。实测峰值约 312 MiB。
- 新服务启动后平滑 reload Nginx，未 restart 任何 Cube 服务。验收前后原 Cube API/srvpro/Web PID 分别为 `73097/73114/73117`，Nginx 主 PID 为 `73138`，启动时间均保持不变。

验收通过：公网 HTTPS/WSS 双玩家 BO3（每局召唤/选择场地后投降，经过换备并收到两次胜负及整场结束消息）、390/1440 浏览器实际对战、Cookie 导入/移动/重载、搜索详情。首页、大厅、构筑页分别引用的 10/11/11 项 JS/CSS 均 200 且 MIME 正确；原 `/api/health` 为 200，禁限表 103 项，AVIF 返回 `image/avif`，独立管理 API 返回 404，七项服务均 active。

验收记录与旧 Nginx 配置保存在 `/opt/ygoduel/backups/20260906-independent-duel-r1/`，原生资源摘要在 release 的 `resources.json`。安装脚本为 `scripts/deploy-standalone-duel.py`；首次启动修正了 srvpro logs/decks/replays/deck_log 可写目录，脚本已补齐此布局。重复发布应使用新 release ID，不覆盖已存在目录。

只下线独立测试时，从 `/etc/nginx/conf.d/ygocube.conf` 移除独立 include 行，运行 `nginx -t` 后 reload，再停止 `ygoduel-*` 三项服务；保留 release、数据库和验收记录。不要停止、回滚或替换 `ygocube-*` 服务，也不要恢复整个旧 Nginx 文件覆盖其他后续配置改动。

公网完整比赛探针：

```bash
node scripts/e2e/standalone-remote.cjs https://39.96.220.91 /path/to/test.ydk
```

### 房间链接与交互更新（2026-09-07）

建房后跳转 `/duel/room/W...`，可复制地址分享；首页也可用密码打开已有房间。房间链接与密码具有同等访问能力，页面明确提示不要公开转发。访客可选择加入、输入已登记玩家 ID 重连或只读观战。在线 ID 的接管需要原会话凭据；离线重连从独立 SQLite 恢复原始和已换备卡组，不要求重新上传。房间详情只返回公开规则、ID 和连接状态。

公开观战使用 srvpro 原有公开 watcher 缓冲与 TCP 转发，可中途加入；网关拒绝观众 action，丢弃原生录像与卡组包。用真实宿主测试确认中途观众手牌 code 全为零。Cube 比赛的观战仍使用原有独立公开流，接口不变。

大厅、构筑和对战页都可绑定 Cube 同款本地目录（IndexedDB 保存句柄）；绑定或解绑后卡图即时刷新。无本地授权或缺图时回退到服务器低清 AVIF。目录授权由浏览器支持情况决定，非支持浏览器仍可使用服务器卡图。

猜拳显示手势、选中高亮、提交后的等待状态及双方出拳结果；先后手使用卡片图形按钮。修正猜拳后等待对方决定先后手时仍能继续点出拳的问题。卡片出现、结果展示和等待指示加入简短动画，遵循 `prefers-reduced-motion`。对战时房间信息可折叠，以保留竖屏场地空间。

此更新已发布到 Aly `/opt/ygoduel/releases/20260907-room-links-r2`，build ID `4NU0A-_ytGJyHiO3l3rFg`，增量包 SHA-256 `263b79824a64c070d754fe24f59c38ef57da0d06054fa2832f4ccaada420c08c`。发布前后确认没有活动独立宿主，只切换三个 `ygoduel-*` 服务，原 Cube PID 不变。保留旧 release、独立数据库备份及验收记录于 `/opt/ygoduel/backups/20260907-room-links-r2`。

通过 203 项 API、25 项协议测试；本地真实宿主验证密码/链接等价、ID 重连、观战隐藏手牌与拒绝操作。上线后通过 390/1440 实际浏览器的房间 URL、无卡组 ID 重连、观战和 Cookie 构筑检查，并再次完成公网 BO3。静态 JS/CSS MIME、AVIF 和新旧服务健康检查通过。物理设备上的目录授权能力仍由浏览器提供，移动 Safari 使用服务器低清图。

### 场地直接选择更新（2026-09-07）

区域选择与原生 event_handler 的行为一致：点击高亮格选中，未选满可再次点击撤销，选满自动发送响应。侧栏不再生成区域按钮；场地顶部粘性提示显示选择数、等待状态和可用的取消操作。共享额外怪兽区映射为一个物理点击目标，独立显示场地及旧灵摆区，对手普通区域左右镜像。触摸目标至少 44px，动画支持减少动态效果设置；提交锁避免重复发送，宿主拒绝后可重试。

修正 SELECT_PLACE / SELECT_DISFIELD 掩码相对选择者的 controller 映射，避免后手玩家操作错误一侧。协议测试 26 项通过；`duel-zone-browser.cjs` 在 390px 触摸及 1440px 桌面、双方座位验证普通/额外/场地/灵摆区、占用区域、多选撤销及取消。真实 Aly 浏览器验证通常召唤后直接点击场地落卡，并回归房间链接、重连、观战及构筑；公网 BO3 通过两局召唤与场地选择、投降、换备和宿主整场结束。

发布 `/opt/ygoduel/releases/20260907-field-selection-r3`，build ID `qDeukUtd-TFP9bkETMl5w`，包 SHA-256 `544220283843c2d541e06a4fe22cb3fa71ab9ba8937c04c2dd9724a267967552`。旧 release、数据库与验收资料保留于对应 backups 目录。只更新独立 ygoduel 实例，原 Cube 进程及启动时间不变；HTTPS、JS/CSS MIME、低清卡图和七项服务健康检查均通过。

### 检索错误、换备与场地更新（2026-09-07）

使用“增援”实际复现了检索后双方断线：API 返回 `PROTOCOL_ERROR / MESSAGE_LAYOUT_31`。原因是 `MSG_CONFIRM_CARDS` 的 `skip_panel` 字段被误当作 count，造成剩余字节校验失败。依据 `ocgcore/libduel.cpp` 与原生 `duelclient.cpp` 补齐字段读取；新增双玩家、不同 skip_panel、多张展示与随后洗牌的回归。`scripts/e2e/standalone-search.cjs` 验证真实 WSS→srvpro→宿主的检索、展示、洗牌及结束，修复后通过。

换备按卡片类型显示主卡组、额外卡组、备选卡组；移回卡组时自动归类，发送仍采用原生 main 合并主卡/额外的格式。界面仅保留中文，删除双语介绍与语言按钮。对战前只显示准备/猜拳操作；场地中央显示当前阶段和宿主许可的阶段切换按钮。两个半场旋转对称，对方场上图像旋转 180°；牌库、额外、墓地与除外放入场地侧列，显示卡背或可见顶卡及数量，并提供短动画与减少动态效果支持。

srvpro `modules.reconnect.wait_time` 默认和两套部署配置设为 1800000 毫秒，关闭断线自动投降。2026-09-07 确认无活动宿主、无原生玩家 TCP 连接后，仅重启 `ygocube-srvpro` 应用原生客户端配置；Cube API、Web、Nginx 未重启。原配置保留于 `/opt/ygoduel/backups/20260907-retention`。独立实例随新 release 应用相同配置。此设置改变断线清理等待时间，不改变原生对局计时规则。

最终发布为 `/opt/ygoduel/releases/20260907-interaction-r4b`，build ID `rleu47wftg3tgOKiPyZ5h`，包 SHA-256 `b5d5ba2d3c77af25d4ddd7fe7892dd6b79b71e98a685de02e5598070b13aa95b`；API 203 项、协议/网页 37 项以及 390/1440 双方座位区域、阶段、换备测试通过。健康验收脚本 `scripts/verify-standalone-duel.py` 单独核验两套保留配置与 Cube Web/API/Nginx 的原始进程基线，明确排除本次获授权重启的原生 srvpro。

最终 HTTPS/WSS 验收通过：真实浏览器通常召唤落场、中文构筑/导出/重载、观战；关闭玩家浏览器 95 秒（超过旧 90 秒清理阈值）后用原 ID 成功恢复同一对局，随后正常结束。另完成两局 BO3 与换备。验收及包保存于对应 r4/r4b backups；本地 srvpro 配置也同步为 1800000 毫秒。

### 提示、卡片操作与连锁动画（2026-09-07）

依据原生 `duelclient.cpp` 的效果询问规则，系统提示 200/221 填入区域与卡名，95/96/97/218/219/220 填入卡名；格式化器兼容 `%ls`、位置参数和数字参数，缺失参数时使用中文兜底。卡片详情操作按 controller/location/sequence（叠放卡包含 sub）定位实体，不再按同名 code 汇总，避免通常召唤和盖放重复，同时保留同一张卡的不同效果。

己方已知里侧卡采用卡背叠加半透明正面，悬停或键盘聚焦渐变至完整正面；对方里侧卡继续隐藏。场地采用七列等宽网格，所有格子按 69:100 卡片比例显示，共享额外怪兽区与主怪兽区第 2/4 格对齐。发动、连锁形成、逆序处理、处理完成及无效事件加入中央卡图、连锁编号和来源卡高亮；动画仅展示，不延迟协议响应，支持减少动态效果设置。

发布 `/opt/ygoduel/releases/20260907-presentation-r5`，build ID `NrFcd59QVSVy_BV7XBXXQ`，前端包 SHA-256 `41946307e8e1b5bc635d82f45fe9db8fb93174424b5e1875191669315b4b70c2`。新增发布脚本 `--web-only` 模式，仅重启 `ygoduel-web`，核验 Cube 与独立 API/srvpro 进程和启动时间保持不变。

网页单元测试 13 项及生产构建通过；390/1440 宽度、双方座位浏览器验证提示格式、重复操作、里侧透明度、额外区对齐（误差小于 1px）、动画以及换备。线上真实浏览器经 WSS→srvpro→ygopro 完成“增援”发动、检索响应、连锁处理及投降结束，并回归 Cookie 构筑、观战与 ID 重连。首页/对战/构筑的 JS/CSS 均 200 且 MIME 正确，卡图正常，七项服务 active，两套断连保留仍为 30 分钟。发布包与验收记录保存在对应 backups 目录。

### 房间保活、操作加时与连续场地（2026-09-07）

等待时房间丢失的原因是 srvpro 对 TCP 玩家连接设置了五分钟空闲超时，网关的 WebSocket ping/pong 不会传入 TCP；没有玩家操作的大厅以及较长回合都可能触发销毁。独立房间现在由网关心跳检测连接，不再执行这项 TCP 空闲清理，断连比赛仍保留 30 分钟；单人实际离开后仍删除房间。在线独立会话在凭据到期前续期，避免等待超过一天后因旧凭据被强制关闭。

独立宿主追加 `--web-action-time`，核心接受主动指令或发动连锁后增加两秒；检索对象、放置区域、洗手牌、跳阶段、取消连锁不增加。拒绝的响应不计入。保留原有回合开始时间规则；普通 Cube/原生房间不启用新参数。静态前端计时不能代替宿主判定。

连锁对应卡片悬浮显示圈号；所有可见卡片悬停在右下角显示卡图与效果详情，换备默认隐藏卡名。怪兽区和共享额外怪兽区改为正方形，攻守卡图保持相同尺寸并旋转，额外区仍对齐第 2/4 格。阶段栏移到顶部，双方场地区域连续。核心 HINT_SELECTMSG 只消费一次，不沿用到后续主动操作和连锁选择。另修正过早点击准备：只有收到原生座位信息后启用准备，确保加入及卡组写入先于准备命令。

验收：41 项网页/协议单元测试、10 项对战 API 测试、原生宿主/API/Web 构建通过。390/1440、双方座位验证圈号、固定悬停详情、攻守图像尺寸、顶部阶段、额外区对齐和准备握手。真实 WSS 验证一次“增援”主动发动恰好 +2 秒，洗手牌和后续选择均不加时；单人大厅等待 310 秒后第二人加入并完成对局；已开局等待 310 秒后检索并结束；单人断连后房间返回 404。浏览器完成发动检索、Cookie 构筑、观战和 ID 重连回归。

后端/宿主发布 `20260907-lifecycle-r6`（包 SHA-256 `c57619b9cfe3d74a3d8b8046a32e2fd8bb754a2c13992efb3d25b080cac75d48`），准备握手前端补充发布 `20260907-lifecycle-r6b`（build ID `O-F75lXBZ69C_DzQYwZSh`，包 SHA-256 `6b58891b79a22659d3d7af3f7feadf537b30b4297f3f5e6c1d906fb6f3e07be5`）。r6 在无活动独立宿主时更新，r6b 只重启独立网页；两次均核对 Cube 服务进程与启动时间不变。发布包、旧版本、数据库备份与健康验收保留于各自 backups 目录。

### 统一尺寸与原生操作布局（2026-09-07）

依据用户提供的两张 YGOPro UI 参考图调整：顶部集中显示双方 LP 与时钟，场地采用连续平面网格，阶段保持在顶部。普通卡图（手牌、场上、各牌堆、换备与操作选项）共用一个尺寸变量；放大的详情预览单独排版。根据窗口高度与对战区域实际起点计算尺度，页面不滚动；复杂列表与长效果文本仅在各自区域内部滚动，确认按钮固定可见。桌面右侧为操作区和独立大图/效果详情区，竖屏在场地下方并排布局。

command/chain 的带位置操作迁移到卡片或区域漩涡入口；墓地、除外、额外等区域弹窗显示该区域的可用卡片和位置编号，选卡后点击确定，普通卡片的动作菜单直接执行所选动作。可选择的场上卡片高亮并支持直接点击，多选继续按原始 index 响应。提示没有 code 时仅从当前视角已经公开的实体补齐图像与名称，禁止推断对方隐蔽卡片。

手牌及场上连锁使用发光圆章、数字与循环动画；短动画队列结束前维持标记。保留 MSG_CHAINING 当前实体和原始发动位置，显式公开发动卡片。卡片进入墓地后跟随真实实体，不标记到原手牌位置的另一张同名卡。MSG_WIN 保留胜负原因，显示投降、基本分归零、无卡可抽、超时、断连与原生特殊胜利文本，并停止局末倒计时。换备悬停详情在卡片附近、模态层之上显示，局内使用独立详情区。

45 项协议/呈现测试通过；浏览器验证双方座位与 390×667、390×900、1440×600、1440×1000：普通卡图尺寸一致、场地/面板/确认按钮在视口内、公开目标直接选择、墓地区域确认、手牌连锁标记、换备前台详情与胜负原因。线上真实浏览器完成“增援”发动检索、Cookie 构筑、观战、ID 重连与投降，并确认展示宿主的投降原因。

发布时独立 srvpro 有正在运行的宿主，因此仅发布前端及其内置协议解析器，未重启 API/srvpro。现有后端继续原样转发线协议；新增展示字段由前端解析。发布 r7/r7b 均核验独立后端和 Cube 进程/启动时间不变。最终 release `20260907-field-ui-r7b`，build ID `c3qAwAsakuu2M_FIqTU_H`，包 SHA-256 `ce1dc6e692abeaefaca16123864b45d6b3aac1aba0e088246355c3d006f7f370`；发布包及验收记录保留于对应 backups 目录。

## 独立服务的原生互通（2026-09-07）

网页与原生客户端接入独立 srvpro 的同一个 Room/ygopro 宿主。原生客户端使用服务器 39.96.220.91、端口 17911，房间页面显示可复制的原生密码。原生建房按既有规则前缀解析，加入成功后以仅发送给该参与者的服务器消息提供网页链接及密码。Cube 的 7911 入口和服务不变。

`configure-standalone-native.py` 在无活动独立宿主时备份配置，以独立 socket/proxy 服务将本机非回环地址的 17911 转发到 127.0.0.1:17911；srvpro 原有 IPAddressDeny/Allow 限制保持不变，17922 私有 HTTP 和宿主动态端口不公开。统一配置来源为独立 shared/config.yaml 的 web_duel.public_url/native_host/native_port/native_bind_address，脚本据此生成 srvpro 对应配置。

验证：协议/展示/别名边界 48 项、API 11 项；浏览器在 390/1440 宽度、双方座位验证连锁确认/不响应/二次取消/强制连锁及场地布局；standalone-interop.cjs 通过真实 TCP 与 WebSocket 两种创建方向的 BO3、换备和结束流程。

发布记录：20260907-native-chain-r8（后端与房间互通），20260907-native-chain-r8b（前端区域提示改为固定状态栏，避免覆盖场地）。后端包 SHA256 d89d0a0c1b34899d45b24655695808d11151852ca13b4fe0962f0f0d04d091d0，前端补丁 SHA256 d50d4afb032f78cec01fd00f280fa13a1888e10561fa0fd964cda7a6d2e4aff3，最终 Web build ID fXVqiL87r3gskxQetFB-r。Aly 本机通过专用 TCP 代理和 HTTPS/WSS 完成双向 BO3；17911 本机已监听且 firewalld 已永久放行，外部 17911 探测超时（7911/443 正常），公网原生互通尚待云安全组放行后复验。

最终线上浏览器复验通过：390/1440 宽度下实际发动增援、直接点击区域、选择检索卡片、连锁结算动画、投降原因、卡组 cookie、房间原生密码、观战、ID 重连。本次测试记录位于 Aly `/opt/ygoduel/backups/20260907-native-chain-r8b/e2e.json`，健康与静态资源检查位于同目录 `verification.json`。

## 被动选择与卡组编辑器界面（2026-09-08）

除主动指令（MSG 10/11）和直接点场地的区域选择（MSG 18/24）外，被动提示默认居中显示，包括表示形式、效果选项、卡片/素材、排序、指示物、属性/种族/卡名/数字宣言和强制连锁。可选连锁继续沿用先确认响应的两步流程；涉及场上卡片时可切到场地选择，再打开窗口确认。仅调整 UI 容器，响应值、prompt ID 及合法性校验不变。禁用对局根元素的通用入场 transform，避免 fixed 弹窗以局部容器为中心；详情和换备悬停保持在提示上层。

`/duel/decks` 按用户提供的原生截图改为左侧固定卡图/效果、中间主卡组/额外/副卡组、右侧搜索结果、顶部卡组管理。提供鼠标悬停与触屏点击详情、拖动移区、双击移卡、右键移除、另存，以及搜索结果分类/排序。搜索仍使用原接口的最多 100 项结果，筛选作用于当前结果；Cookie 的容量、会话存储和卡图加载顺序不变。手机保留顶部详情及区域快捷按钮，卡组和搜索列表各自滚动。

本地验收：3123 启动生产构建；390/1440 宽度及双方座位通过居中必选提示（表示、效果、确认、属性/种族、数字）、场地区域选择与换备层级测试；构筑页通过导入、移动、拖放分类、搜索、保存/重载、另存/删除和布局测试；Cookie/展示相关单元测试 8 项通过。Web build ID `N5yPWJSPSBu42ygmtBHiw`，发布包 SHA256 `1a57839fd6c4484b8a8e48c01f2777d188bd9da5654c0bd5e8820a00e1bed0c0`。

发布到 Aly 独立 release `20260908-deck-prompts-r9`，只切换 Web，独立 API/srvpro 与 Cube 进程未因发布重启。HTTPS、所有页面引用的 JS/CSS MIME、卡图、API 和 Cube 健康检查通过，验收记录存于对应 backups/verification.json。

线上真实对局复验未通过：浏览器收到 WebSocket `4011 HOST_UNAVAILABLE`；独立 srvpro 从当日 09:44 的 `Bad CTOS message length`/`Oversized CTOS` 后持续记录本机代理 `BAD IP ::ffff:127.0.0.1`，时间早于本次发布。该进程仍保留宿主，未为清除封禁而重启，也未修改原有 Cube。当前不能据页面健康检查宣称线上对局通过；需另行处理共享代理地址的封禁隔离并复验。

### 2026-09-09：先行卡全链路索引修复（待维护窗口发布）

线上只读排查确认：Cube 宿主已安装 `test-release.cdb`（68 张）与
`test-update.cdb`（241 张），但 `CardsService` 只读主库；独立 Duel 当前
宿主无 expansion，且 API `cards_cdb` 固定在最初 r1 release 路径。
此外，资源准备的 AVIF 输入未包含 expansion，效果选项/录像描述也只读主库。
逐张验收发现全角名称查询 NFKC 与未规范化的索引不一致，导致部分完整名称搜不到。

修复内容：
- API 在主库后按文件名顺序读同级顶层 expansion CDB，构造完整快照后事务替换缓存；
  不修改或合并原始 CDB。沿用 exact-code 名称映射、衍生物过滤、主/额外类型判定。
- 效果描述 ID 与录像描述遵循相同覆盖顺序，空的覆盖选项不保留旧库文字。
- 搜索索引与查询统一 NFKC；全角卡名、编号都可搜索。
- `prepare` 的 AVIF 阶段增加 `--expansion-pics`，包含已安装扩展图片；普通更新
  同样保留它们，源图改变后重新编码，不再只凭旧输出哈希误跳过。
- `scripts/stage-expansion-catalog.py` 只在 Aly staging 复制 API 编译模块、使用
  独立 SQLite 验证搜索和入池，不修改生产配置、生产数据库或服务。

验证与发布准备：
- API 全套 19 suites / 205 tests 通过；补充全角名称、效果文字及入池断言后的
  cards/duel 定向测试通过。资源 helper 21 tests 通过，TypeScript 构建通过。
- 使用 `EXPANSION_CODE=100200292` 的本地隔离宿主测试：独立单局与 BO3（含换备、
  重连、结束）通过；Cube + `NATIVE_BOB=1` 网页/原生协议 BO3 通过。
- Aly 隔离验收两套 API 均索引 15049 张卡；全部 309 张 expansion 卡均通过编号和
  名称搜索、入池。Duel 487 条非空效果选项文字与卡库一致。
- 309 张扩展卡所需脚本及低清图片覆盖检查无缺项；补充生成 68 张低清 AVIF。
- 修复包 `/tmp/expansion-catalog-fix-v2.tar.gz`，SHA-256
  `a94a1585837462b2ee299d3b403c75d39613d28f936c7ba66f5c0fd902a51e8c`。
- Aly 已验证 staging：`/opt/ygocube/.staging/expansion-catalog-20260909-115331`，
  验证记录为 `verification.json`。前一次失败 staging 保留用于审计。
- expansion SHA：test-release `8cef913ce8598333e15f9fafccc1dedd532b661afe51440f5417179b4a4835a2`；
  test-update `0e6be45ce6c2de98a338801e3560539457331f2f1acc117ddb220476063760ec`，
  与本地一致。包不包含原始图片、凭据或运行数据库。

后续正式发布须先确认维护窗口：备份数据库、配置与 current；创建两套应用新 release，
仅替换已有的 cards / duel / replay catalogue 编译模块；给 Cube 安装新 AVIF；
给独立 Duel 安装匹配的主库、脚本、strings 和 expansion，并将 API 资源路径改为
当前宿主路径（解除旧 r1 固定路径），保留独立端口、数据库与房间策略。
独立服务必须复制所需资源并独立发布，不能因 Cube 更新直接改动其正在运行的目录。
重启 API 使元数据缓存重建，独立 srvpro 重新加载匹配资源；保留 Cube 当前
客户端建房方式。发布后仍需公网搜索/卡图、实际独立房间比赛、原生协议互通与
Cube 健康检查。当前尚未切换任何生产服务，不能将隔离验证视为线上已修复。

补充实际效果验收：`EXPANSION_CODE=100200292 EXPANSION_EFFECT=1 STANDALONE_ONLY=1`
隔离测试通过。以固定初始手牌的测试规则，实际召唤「优秀精灵」、发动其起动效果、
从卡组选择装备卡送墓，再执行观战、重连与结束；确认 expansion Lua 被 ocgcore
执行。日志 `/tmp/expansion-effect-e2e.log`，产物 `/tmp/ygocube-web-r3DqMQ`。
此为真实效果样例回归，不代表逐一验证全部 309 张卡的所有效果实现。

### 2026-09-09 正式发布与验收完成

用户已确认维护更新，两套 current 均切换至 `20260909-expansion-catalog-r10`。
备份分别位于 `/opt/ygocube/backups/20260909-expansion-catalog-r10` 与
`/opt/ygoduel/backups/20260909-expansion-catalog-r10`，含 SQLite 完整性校验后的
在线备份、旧 release 指针记录以及独立 Duel 原配置。
仅重启两套 API 与独立 srvpro；Cube srvpro、两套 Web 和 Nginx 进程保持不变。
独立 Duel 保留自己的带 Web 时间补偿宿主，复制受审计主库/脚本/扩展库，未复制原图。
两套主库 SHA 均为 `5f13245de4e665450858f66ef2f736a3d2f48cc7f0036961373a96a650cb6797`。

正式验收结果：
- 公网 Cube 真实卡池搜索接口与 Duel 搜索都返回「优秀精灵」；两套先行卡图片
  返回 200、image/avif 且文件头正确。
- 首页、`/duel`、`/duel/decks` 及各自引用的 10/11/11 个 JS/CSS 全部 200、MIME 正确。
  七个服务 active，两套重连保留均为 1800000ms，独立私有 API 不可公开访问。
- Aly 实际 HTTPS/WSS ↔ TCP 17911：网页建房/原生加入和原生建房/网页加入各完成
  2 局 BO3、换备与邀请链接验证，卡组含先行卡。
- 公网 Chromium 390/1440 尺寸：真实对局、点击场地区域召唤、胜负原因、cookie
  导入/重载、main/side 移动、卡片搜索详情、房间 URL、观战、ID 重连、本地卡图设置通过。
- 最终标准 helper/API/Web/srvpro 测试构建通过；新增原图不进入服务器 payload 的
  行为测试后 helper 总计 22 项通过。WebSocket/协议与 cookie/展示测试通过。
- 已加强 `.codex/skills/update/SKILL.md`：扩展卡全链路检查、NFKC、AVIF 输入和
  原图排除、双实例发布、固定旧路径排查、维护授权复用、实际效果与双向互通验收。

线上测试仅在新建的独立测试房间进行，未加入用户既有 Cube 比赛；未声称公网原生
17911 的云安全组已放通，原生侧连接由 Aly 本机发起，网页侧使用公网 HTTPS/WSS。

### 本地 expansion 卡图绑定修复

共享 CardImage 的目录句柄与 HTTP 本地路径统一按 `expansions/pics` 优先于 `pics`
查找，与 YGOPro 客户端一致；支持 jpg/png/jpeg/webp/avif，避免普通同编号旧图覆盖
扩展图。目录句柄同时兼容扩展包子目录和直接选中的图片目录，重新绑定清理目录缓存。
绑定 YGOPro 根目录即可访问主图与扩展图；只授权 `pics` 子目录时浏览器不能越权访问
其兄弟目录，需重新选择根目录。未找到本地图仍按现有逻辑回退服务器低清图。

新增路径单元测试与 Chromium 实际目录句柄测试：根目录绑定、扩展 PNG 覆盖普通 JPG
（以像素颜色断言）、空文件回退及保存卡组/刷新后恢复均通过。

已发布至两套 Web 的 `20260909-local-expansion-pics-r11`；首页与 Duel 两页面引用的
全部 JS/CSS 返回 200、MIME 正确。两套 API、srvpro 和 Nginx 的进程均未重启，
发布记录保存在各实例 `backups/20260909-local-expansion-pics-r11/verification.json`。

### r12：构建目录导致的样式回归与本地图片复查

r11 从仓库根目录调用 Next build，PostCSS/Tailwind 未稳定定位 Web 配置与 content，
导致 CSS 虽返回 200，实际缺少 grid、间距及主题工具类。此前仅验证状态码和 MIME，
未能发现此回归。现显式指定 Tailwind 配置路径，并使 content 相对配置文件解析；
从仓库根构建两套生产包，通过 CSS 语义检查和浏览器 computed style 验证。

用户提供的 100267021 位于 YGOPro 根目录的 `expansions/pics/100267021.jpg`，
文件为正常的 407×593 JPEG，不能将其故障归因于损坏图片。使用该实际文件在浏览器
目录句柄夹具中验证：绑定后渲染像素与原图一致，重新读取、保存卡组及刷新恢复通过。
夹具使用 OPFS，不能证明用户原有外部目录授权仍有效；新增“重新读取卡图”和
“更换目录”入口，显式重查权限、清理缓存并刷新卡图。另修复非空但无法解码的本地
图片阻止后续格式回退的问题，增加坏 JPG→正常 PNG 的浏览器验收。

已发布两套 Web 至 `20260909-web-layout-pics-r12`。公网首页、后台、Duel 和构筑页
在 390/1440 宽度的布局检查通过，首页和构筑页截图复核通过；公网目录绑定夹具的
实际 JPEG 与损坏 JPG 回退测试均通过。两套 100267021 AVIF 接口均为 200 image/avif。
两套 API、srvpro 和 Nginx 的 PID/启动时间保持不变，未重启比赛后端。静态资源、
样式语义与进程校验记录保存在各实例 `backups/20260909-web-layout-pics-r12/verification.json`。

## 2026-09-10：与原生客户端的交互对照

本轮依据 `ygopro/gframe/deck_con.cpp` 的鼠标处理和 `event_handler.cpp` 的 `ClientField::CancelOrFinish` 调整网页端。Computer Use 的 `@oai/sky` 初始化及重置重试均失败，报 `windows sandbox failed: helper_unknown_error: setup refresh had errors`；浏览器 Computer Use 入口也出现同一错误。本轮未操作 Windows YGOPro GUI，原生客户端实操对照仍待工具恢复后补验，不能把源码对照和 Playwright 测试记作 Computer Use 验收。

- 组卡：搜索卡图右键添加，卡组内右键移除，双击打开大图（Escape、关闭按钮、右键关闭）；同区拖动排序，跨区拖动移动，额外怪兽自动归入额外卡组。按具体索引移动，避免重复卡误删；无效区域和满区不移除来源卡。触屏保留添加及移区按钮。
- 建房：玩家与卡组、对战规则分栏，较矮桌面调整规则列数，手机排列为单列；显示所选卡组主／额外／副数量，重连和观战仍使用原有密码解析接口。
- 对战：右键先关闭查看／操作菜单；可选连锁返回响应确认，再次右键可不响应；是非选择发送否；选卡满足条件时提交，未选且允许取消时取消。必选表示形式、场地区域、未满足条件的选卡不会被跳过。区域操作卡片 hover／focus 更新详情。
- 本轮未改变接口、房间协议、srvpro、宿主或生产环境配置。

验收：Windows／WSL 前端 26 项测试通过；Windows Next 标准构建、WSL Linux standalone 构建和静态资源收集通过。`scripts/e2e/native-ui.cjs` 覆盖 1440×900、1366×768、1024×600、390×844 的右键加删、双击不移卡、拖动排序及页面溢出检查。`scripts/e2e/standalone-browser.cjs` 通过真实浏览器→WebSocket→API→srvpro→原生宿主完成召唤、右键关闭菜单、必选场地区域保护、增援检索右键提交、连锁结算、观战、重连及投降原因测试。测试采用全新的浏览器上下文和临时测试卡组。

运行浏览器回归时设置 `PLAYWRIGHT_MODULE_PATH` 与 `CHROMIUM_PATH`，启动独立本地 Duel 后执行：

```powershell
node scripts/e2e/native-ui.cjs http://127.0.0.1:3100
node scripts/e2e/standalone-browser.cjs http://127.0.0.1:3100 测试卡组.ydk
```

检索用例设置 `EFFECT_TEST=1`，使用无洗牌时初始手牌包含「增援」、卡组中有可检索战士族的 40 主／1 副卡组。修改已有 browser 测试时，先等待宿主发出选区提示，再统计可选区域；否则会把消息尚未到达误判为右键改变了候选数量。

## 2026-09-10：超量素材与响应期间的场面确认

本轮 Computer Use 已成功连接 Windows YGOPro-Cube 1.036.2-cube，实际操作自带 `single/sample3.lua` 超量教学残局：点击对方辉光子 → 查看列表 → 查看两张圣骑士素材与左侧详情；发动增援并开启显示时点 → 选择确认场面 → 询问收起、场地和取消操作仍可访问。测试结束返回主菜单，未保存测试录像。此轮观察覆盖素材列表与响应期间检查场面，并未完成整场 GUI 比赛。

网页修复：

- 素材增加错位叠放、入栈动画及独立数量按钮；对方素材按钮保持正向可读。列表按素材序号保留同名卡，每张支持 hover、键盘焦点和触屏查看详情。详情区域预留固定高度，避免移动端 hover 改变弹窗高度导致点击落空。
- 素材选择按宿主位置和 `sub` 索引定位，不再点击超量怪兽就默认选第一张素材；取除素材沿用现有选择协议，公开素材名称可从宿主素材数组补全，未知条目继续保持未知。
- 响应询问取消背景模糊和全屏遮挡，移除场地的 `inert`。摘要按实际卡片位置合并同一张卡的多个效果，只展示可响应卡图/卡名；点击摘要仅查看详情。确认响应后仍可取消，未确认时的查看操作不发送响应。
- 新增“查看场面 / 返回响应”，可暂时收起中央窗口；当前响应归属提示持续保留。关闭卡片详情或素材列表后保留原响应状态；右侧重复动作在询问期间收起。

验证：Windows 网页 27 项测试、类型检查和生产构建；独立 Linux 临时副本的同样测试及 standalone 构建。`scripts/e2e/material-response-ui.cjs` 使用实际 DuelClient 和受控服务端消息，在 1440/390 宽度验证查看不发动作、重复素材索引、取除后的数量、响应后取消、直接不响应以及透明背景命中。另运行真实 srvpro/无头宿主的检索、连锁处理、观战、重连与投降结果浏览器回归。

Linux 验证使用 `/tmp/ygocube-material-ui.*` 的独立源码副本和 Linux 依赖。直接覆盖 WSL 未提交文件被自动审批拒绝后未执行；既有 WSL 工作目录保持原状。Aly 生产服务未修改。

### r13：独立 Duel 网页交互发布

已发布 Aly `/opt/ygoduel/releases/20260910-duel-material-response-r13`，仅重启 `ygoduel-web`；Cube 三个服务、独立 API/srvpro 及 Nginx 的 PID/启动时间与发布前完全相同。旧 r12 保留，可将 current 原子切回旧 release 并只重启 Web 回滚。

- Linux 独立发布构建使用 `NEXT_PUBLIC_API_BASE=/duel-api`、`NEXT_ASSET_PREFIX=/duel-assets`、`CUBE_API_URL=http://127.0.0.1:3101`。回归用目录曾通过绝对链接借用 WSL 依赖，不能发布；发布构建在新目录复制 Linux 依赖，确认所有归档链接均在包内且可解析。
- Build ID：`8H1dPaFyuKH2tT8umgN1b`；包 SHA-256：`56fbce4e0505154df6fc06e3f422ebf40c8dc1fc5a4c0cb6cdf900317b092efe`，2919 个文件校验通过。
- 源码基线 `bd567cd2071e30e0fe30323dd8d9ac140a37fc76`，包含已授权但尚未提交的网页修改；逐文件摘要记录在 release `web/source.json`，源码摘要 `1e53d065f51ad7656ad8cdd3d1be8a75b8dfac12e746b6f6e805d03c2c720da7`，不冒称该基线提交本身包含本轮功能。
- Aly 临时进程预检通过后才切换 current。公网 `/`、`/duel`、`/duel/decks`、`/duel/play` 引用的所有静态资源均 200/MIME 正确；两套健康检查、低清卡图、私有 API 隔离通过。真实浏览器的建房/组卡在 1440×900、1366×768、1024×600、390×844 通过。截图前等待字体就绪，避免页面字体加载阶段出现瞬时高度误报。
- **线上对战验收未通过**：专用测试连接返回 `4011 HOST_UNAVAILABLE`，独立 srvpro 日志显示本机代理地址 `BAD IP`，第一次发生于 r13 切换前。当前还有两个保留宿主，因此未为清空进程内封禁而重启 srvpro，也未放松协议检查。本轮 Web 发布成功不能表述为线上完整对战测试通过。

发布和阻断证据位于 `/opt/ygoduel/backups/20260910-duel-material-response-r13/` 下的 `verification.json`、`smoke-verification.json`、`protected-services.txt`、`previous-release.txt`。保留旧 release 及预检目录供后续诊断；本轮未提交或推送 Git。

### r13 重启复验：解除既有代理封禁

随后按用户明确授权关闭独立 Duel 的两个既有宿主，并停止、启动 `ygoduel-srvpro`、`ygoduel-api`、`ygoduel-web`。`KillMode=control-group` 确保旧宿主全部退出；清除 srvpro 进程内封禁并重建 API 会话状态。Cube API/srvpro/Web 和 Nginx 的 PID/启动时间完全不变。

重启后的公网 HTTPS/WSS 测试通过：双方建房/入房、准备、召唤及放置、BO3 换备、两局投降结束；真实浏览器在 390/1440 宽度完成检索效果、连锁处理、观战、身份重连和投降结果验收。所有服务 active，当前 srvpro invocation 内 `BAD IP`、`INVALID_PACKET`、`Oversized CTOS`、`Bad CTOS message length` 均为 0。本次恢复当前服务，不代表已从代码层解决共享代理地址封禁的根本问题。

最新结果存于 Aly `/opt/ygoduel/backups/20260910-duel-material-response-r13/restart-verification.json`，此前失败的 `smoke-verification.json` 保留为历史证据；当前线上对战验收以重启后的记录为准。

### 2026-09-10：房间内选卡组与对局信息回归

- 建房和加入不再要求卡组；房间内上传/选择 cookie 卡组，准备前可以反复修改。无头宿主 UPDATE_DECK 自动准备，代理仅在点击准备时转发卡组，避免提前准备；准备确认期间和已准备状态拒绝换卡组，取消准备后开放。Cube 卡组锁定不变。
- YDK 导入和服务端均按 CDB 类型区分 main/extra，side 保持原区；校验错误返回中文具体原因，含实际数量、房间上限、未知卡号等。宿主禁限卡表/同名卡/卡片范围错误也显示可读说明。
- 视口高度跟随 visualViewport 和实际页面顶部位置；TIME_LIMIT 每包重建计时锚点，消除相同秒数的重复包以及提示切换产生的累计偏差。
- 展示卡片使用可关闭卡图面板；手牌发动卡图展示延长，连锁记录可点击查看；本局最近 2000 条记录保留公开的召唤、移动、攻击、抽卡、展示和连锁卡号，可查看效果。详情复用 Cube CardMeta（字段/类型/属性/种族/刻度/连接等）。
- 换备显示上一局胜负和宿主原因；除外/额外区区分表里并显示总数(表侧数)，里侧除外不会在对手视角显示卡图。有可操作卡片的区域也可选择查看全部卡片，浏览后点卡优先打开详情。
- 回归：`scripts/e2e/duel-information-ui.cjs` 覆盖桌面/竖屏高度、重复时钟、隐私、区域查看、展示、字段、手牌发动和换备结果；`native-ui.cjs` 覆盖四种尺寸大厅/组卡器；`standalone-browser.cjs` 覆盖真实检索、连锁、观战/重连；`DUEL_API_BASE=/api DECK_LOBBY_TEST=1 node scripts/e2e/standalone-remote.cjs http://127.0.0.1:3100 data/native-ui-fixture.ydk` 覆盖真实准备锁定、错误说明、归类和 BO3。
- Linux 在独立临时目录使用 Linux 依赖编译，不覆盖既有 WSL 工作树；生产构建保持 `/duel-api`、`/duel-assets` 前缀。本轮未部署 Aly。

### 2026-09-10：Aly r14 发布与重启验收

- 独立 release：`20260910-duel-room-information-r14`，Web build ID `jHQ-igys3WT3bArB_J4Yq`。同时发布 Linux API、共享/对局协议和 standalone Web（含 static）。宿主与卡牌资源保持原哈希。
- 构建来源：`bd567cd2071e30e0fe30323dd8d9ac140a37fc76` 加工作区修复；完整文件哈希记录在 release 的 `web/source.json`，应用源码哈希 `6e75227b795b130d9b1795fed0a74b7395e59567cda76f5820d8c8f24a58c143`。归档 SHA-256 `d6780ec39c06059c2fa170a2a1ceff7fd41c0e859d32bb366a2a572656ebaaa1`。
- 重启独立 API/srvpro/Web；Cube 三服务及 Nginx PID/启动时间不变。备份与回滚来源在 `/opt/ygoduel/backups/20260910-duel-room-information-r14/`，旧 release 为 r13；SQLite backup integrity_check=ok。
- 公网真实 WSS BO3 两局、换备、空卡组入房、具体校验错误、额外归类、准备锁定/解锁通过；真实浏览器检索/连锁、观战/ID 重连、胜负原因通过。1440/390 对局展示受控帧测试及四尺寸大厅/组卡器通过。七服务 active，静态资源/MIME、卡图、30 分钟重连均通过；新 invocation 中 BAD IP/协议解析错误为零。验收文件为 `verification.json` 和 `restart-verification.json`。

### 2026-09-20：原生交互与视觉审查

对照 YGOPro 场地绘制、ClientAnalyze 和 CancelOrFinish，补齐移动/抽卡、召唤、目标、攻击、生命值与阶段视觉反馈；修正选择上限和自动完成、重复提交、动作菜单、实时攻守、连锁来源、旧规则额外区和墓地禁看。详细源码依据、测试范围及未覆盖的原生效果见 [14-native-duel-review.md](14-native-duel-review.md)。本轮只完成本地实现与跨平台验收，未发布 Aly。
