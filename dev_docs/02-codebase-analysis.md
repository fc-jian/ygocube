# 02 - 现有代码库分析（ygopro + srvpro）

本文档记录对 `ygopro/` 与 `srvpro/` 两个开源仓库的勘察结果，作为改造方案的依据。所有行号以当前 checkout 为准。

## 1. ygopro（mycard/ygopro）

### 1.1 仓库结构

- 无头宿主二进制源码在 **`server` 分支**（本 checkout 是 `master`，即客户端）。
- `master` 与 `origin/server` 的 gframe/ 文件清单相同（无独立 server 目录），差异在代码内容。

```
ygopro/
├── gframe/          # 客户端 + 内置 LAN 宿主 (netserver)
├── ocgcore/         # 规则引擎核心（卡片处理）
├── premake5.lua     # 构建脚本（workspace "YGOPro"）
├── lflist.conf / strings.conf / system.conf
├── resource/ script/ sound/ textures/
```

### 1.2 关键文件

| 文件 | 作用 |
|---|---|
| `gframe/gframe.cpp` | `main()`。master：解析 `-e -n -h -p -w -k -d -c -j -r -s` 客户端参数；**server 分支：`argc>=13` 时进入无头宿主模式**（位置参数见 1.4） |
| `gframe/netserver.cpp/h` | 房间内对战宿主（客户端内置 LAN server；server 分支下即被 srvpro spawn 的宿主进程） |
| `gframe/duelclient.cpp/h` | 客户端网络层；`SendUpdateDeck()` (duelclient.cpp:4109) 发送 `CTOS_UPDATE_DECK` |
| `gframe/network.h` | 协议 struct 定义（CTOS_/STOC_），全部带 `static_assert` 尺寸校验 |
| `gframe/deck_manager.h/cpp` | 卡组校验/加载：`DeckManager::CheckDeck()` (deck_manager.cpp:87)、`LoadDeck()` (deck_manager.cpp:151) |
| `gframe/deck.h` | `Deck` 结构（main/extra/side 三个 vector） |
| `gframe/deck_con.cpp` | 客户端卡组编辑器 UI（使用同样的 deck 常量，deck_con.cpp:1316,1778-1806） |
| `gframe/data_manager.h/cpp` | 卡牌数据库读取（cards.cdb, SQLite） |
| `ocgcore/` | 规则引擎（无需改动，除非涉及规则本身） |

### 1.3 Deck 大小限制（改造核心点）

```cpp
// gframe/deck_manager.h:17-20
constexpr int DECK_MAX_SIZE = 60;
constexpr int DECK_MIN_SIZE = 40;
constexpr int EXTRA_MAX_SIZE = 15;
constexpr int SIDE_MAX_SIZE = 15;
```

使用位置：
- `DeckManager::CheckDeck()` (deck_manager.cpp:90-95)：主卡组 40~60、额外 ≤15、副 ≤15；
- `DeckManager::LoadDeck()` (deck_manager.cpp:172-192)：is_packlist 填充逻辑中的补齐判断；
- `deck_con.cpp`（客户端 UI 限制，siding 时上限 +5）。

### 1.4 server 分支无头宿主启动协议（srvpro spawn 参数）

`gframe.cpp`（server 分支）`main()`：`argc >= 13` 时按位置解析：

| 参数位 | 含义 | 来源（srvpro ygopro-server.coffee:1455-1457） |
|---|---|---|
| 1 | 0（保留） | 固定 0 |
| 2 | lflist index | `@hostinfo.lflist` |
| 3 | rule | `@hostinfo.rule` |
| 4 | mode (0/1/2) | `@hostinfo.mode` |
| 5 | duel_rule (大师规则) | `@hostinfo.duel_rule` |
| 6 | no_check_deck ('T'/'F') | `@hostinfo.no_check_deck` |
| 7 | no_shuffle_deck ('T'/'F') | `@hostinfo.no_shuffle_deck` |
| 8 | start_lp | `@hostinfo.start_lp` |
| 9 | start_hand | `@hostinfo.start_hand` |
| 10 | draw_count | `@hostinfo.draw_count` |
| 11 | time_limit | `@hostinfo.time_limit` |
| 12 | replay_mode | `@hostinfo.replay_mode` |
| 13+ | match 模式下的 seed（base64） | firstSeed（replay 恢复） |

宿主启动后把 **端口打印到 stdout**（srvpro 在 `ygopro-server.coffee:1480-1483` 读取 `@port = parseInt data`）。

### 1.5 协议结构（network.h，本次改造涉及）

- `CTOS_CreateGame` (100B) / `CTOS_JoinGame` (48B)：客户端建/加房间；
- `CTOS_UpdateDeck`：卡组上传（主+副卡组 buffer）；
- `STOC_HS_PlayerEnter` (41B) / `STOC_HS_PlayerChange`：房间内玩家状态；
- `STOC_TimeLimit`、`STOC_ErrorMsg` (8B)、`STOC_DuelEnd` 等。
- 消息类型与 struct 均带 `static_assert`，改协议必须同步 srvpro 侧 `data/proto_structs.json`（见 2.4）。

### 1.6 构建

- premake5 单 workspace "YGOPro"：projects = `ocgcore` + `gframe`(YGOPro) + 依赖（lua/event/freetype/sqlite/irrlicht/jpeg/png/lzma/zlib/miniaudio）。
- server 分支二进制与客户端同构，只是 `main()` 分支不同；Linux 下 `premake5 gmake2 && make`。

## 2. srvpro（mycard/srvpro）

### 2.1 仓库结构（CoffeeScript 工程）

```
srvpro/
├── ygopro-server.coffee   # 主服务器（4193 行），编译为 ygopro-server.js (5622 行)
├── ygopro.coffee          # 协议 handler 注册封装（stoc_follow/ctos_follow/stoc_send...）
├── roomlist.coffee        # websocket 房间列表（http 模块的一部分）
├── YGOProMessages.ts/js   # 协议消息助手（struct 编解码，基于 data/proto_structs.json）
├── ygopro-auth.ts/js      # MyCard 账号认证
├── ygopro-tournament.ts   # 锦标赛工具（challonge 集成）
├── ygopro-webhook.js      # webhook 上报工具
├── ygopro-deck-stats.js / ygopro-update.js / load-constants.js ...
├── data/                  # default_config.json / constants.json / proto_structs.json / i18n.json
├── data-manager/          # 数据管理
└── Dockerfile* / pm2 配置
```

### 2.2 启动与配置

- `init()` (ygopro-server.coffee:267)：从 `data/default_config.json` 加载设置 → `config/settings.json`（可覆盖）；
- 主端口 `settings.port`（默认 **7911**），HTTP `settings.modules.http.port`（默认 **7922**），SSL 7923；
- 从 `ygopro/gframe/config.h` 读 `PRO_VERSION` 与客户端版本校验（:440）；
- 读 `ygopro/expansions/lflist.conf` 与 `ygopro/lflist.conf` 加载禁卡表；
- 模块开关全部走 `settings.modules.*`：`reconnect` / `challonge` / `arena_mode` / `tournament_mode` / `random_duel` / `windbot` / `athletic_check` / `http` / `mycard` / `test_mode` 等。

### 2.3 房间模型（改造核心）

`class Room` (ygopro-server.coffee:1289)：

| 成员/方法 | 行号 | 说明 |
|---|---|---|
| `constructor(name, hostinfo)` | 1290 | **房间名即规则字符串**：解析 `LP8000,TIME180,START5,DRAW1,TCGONLY,LFLIST2,NOCHECK,NOSHUFFLE,DEATH40,MR4,NU,NW,...` 等 token；也支持紧凑格式正则 `^(\d)(\d)([12345TF])(T\|F)(T\|F)(\d+),(\d+),(\d+)` 与 `M#`/`T#`/`AI#` 前缀 |
| `spawn(firstSeed)` | 1454 | 组装参数数组 → `global.rawSpawn` (1287) `spawn './ygopro', param, {cwd:'ygopro'}`；读 stdout 端口；`@established=true`；为每个玩家建立代理连接 |
| `delete()` | 1510 | **结果上报**：构造 score_array（含 `@scores`/`@decks`/`@deck_history`），`axios.post(settings.modules.arena_mode.post_score, ...)` + `utility.retry` 10 次；含回放 base64 |
| `post_challonge_score()` | 1688 | 锦标赛比分上报 |
| `disconnect(client)` | 1746 | 玩家断开处理（含断线重连入口） |
| `join_player(client)` | 1895 | 玩家加入房间 |
| `@scores/@decks/@deck_history/@replays` | 1304-1312 | **已记录每个玩家的卡组与战绩**（战绩按 `name_vpass` = 名称+密码 组合键） |

### 2.4 协议处理（YGOProMessages）

- `ygopro.coffee` 提供 `stoc_follow/ctos_follow/stoc_send/ctos_send` 等注册/发送函数；
- struct 定义在 `data/proto_structs.json`，由 `YGOProMessages.ts` 驱动编解码（srvpro 1 为同步模式，2 为异步；本仓库是 1）。
- `ctos_filter = ["UPDATE_DECK"]` (2077)：UPDATE_DECK 由 srvpro 拦截处理而非直接转发。

### 2.5 卡组处理（改造核心）

`ctos_follow 'UPDATE_DECK'` (3487-3536+)：
- 断线重连分支：`settings.modules.reconnect.enabled && client.pre_reconnecting` → `CLIENT_is_able_to_reconnect(client, buffer)`（比对卡组）→ `CLIENT_reconnect` / `CLIENT_kick_reconnect`；
- 防护：`mainc > 256 or sidec > 256` 直接踢（安全补丁）；
- 记录 `client.main` / `client.side` / `client.start_deckbuf`（BEGIN 阶段的原始卡组 buffer，供重连比对与战绩记录）；
- 卡组合法性提示（deck_ok / deck_bad 聊天消息，:3530-3536）与 `tournament_mode.deck_check`（:3569）。

### 2.6 结果/上报与 HTTP（改造核心）

- **webhook 模式**：`room.delete()` → `axios.post(post_score, form_data)`（URL-encoded，含 usernameA/B、userscoreA/B、userdeckA/B、deckHistory、first、wins、replays、start/end、arena、nonce）；`utility.retry` 重试。
- **HTTP 服务器**：`http.createServer(httpRequestListener)` (634) + `settings.modules.http.ssl`；websocket roomlist (roomlist.coffee，JSON 事件：init/create/update/delete/start)。
- 已有 axios 上报（random_duel.post_match_scores、arena_mode、challonge）等外部集成先例。

### 2.7 断线重连（现状）

- `settings.modules.reconnect`（data/default_config.json:127）：`enabled` 等参数；
- 玩家断线后一定时间内重连：房间保留 `player_datas`、代理连接状态、卡组 buffer 比对；
- **结论：断线重连主链路 srvpro 已具备**，cube 只需确认开启配置并补充房间级策略。

## 3. 需求 → 现有机制 → 扩展点映射

| 需求（来自 original_guide.md） | 现有机制 | 扩展点 |
|---|---|---|
| deck size 动态可配置（建房间参数） | 编译期常量 DECK_MIN/MAX_SIZE (deck_manager.h:17-20)；房间名规则 token 解析 (ygopro-server.coffee:1333-1436)；spawn 参数数组 (1454) | ① srvpro 房间名新增 `MAIN/EXTRA/SIDE` token → ② spawn 参数追加 3 位 → ③ server 分支 gframe.cpp 解析 → ④ DeckManager 运行时限制 |
| 记录固定卡组、比赛时自动加载+验证 ID | `client.start_deckbuf` / `@decks` / UPDATE_DECK handler (3487) | cube 模式：UPDATE_DECK 时以记录的卡组覆盖客户端上传；验证 ID 存在性（cards.cdb）与数量 |
| 断线重连 | `modules.reconnect` + `CLIENT_reconnect` (3488-3505) | 确认配置开启；必要时为 cube 房间定制重连窗口 |
| 比赛结果自动获取 + 供 cube 调用 | `room.delete()` webhook (1510-1576)；scores/decks 追踪 | 新增 `modules.cube.webhook_url`（或 cube 轮询 GET）；沿用 utility.retry |
| cube 建房间/通知玩家服务器+密码 | 房间名规则字符串；Room 构造器；proxy 模型 | srvpro HTTP `/cube/*` API（api_key 鉴权）→ `createRoom(name, password, ...)` |
| 客户端（玩家 ygopro） | master 分支客户端无需功能改造；deck 限制由 srvpro 设 `no_check_deck=T` 时宿主强制 | 可选：客户端显示自定义限制（master 新分支，非必须） |

## 4. 部署布局结论

1. `srvpro/ygopro/` = server 分支编译产物（`./ygopro` 可执行）+ `assets/` 内容（cards.cdb、script/、pics/、expansions/）。
2. srvpro 运行目录：`ygopro-server.js`（coffee 编译产物）或 `node ygopro-server.coffee`（依赖 coffee-script 运行时）+ `config/` + `data/`。
3. cube 后端与 srvpro 同机或跨机均可（HTTP 通信）；玩家 ygopro 客户端连接 srvpro 主端口。

## 5. 风险提示

- **分支漂移**：server 分支相对 master 较旧，改动前需先确认 server 分支与 master 的 diff 规模；必要时把 master 的最新改动合入 cube-server 分支。
- **CoffeeScript 维护成本**：单文件 4193 行；改动需 `npm run build`（coffee 编译）后以 JS 运行验证。
- **协议一致性**：改动 network.h（ygopro 侧）必须同步 `data/proto_structs.json`（srvpro 侧），否则编解码错位。
- **Windows 玩家生态**：宿主二进制需提供 Linux 编译（部署机）与 Windows 编译（本地联调）两种产物。
