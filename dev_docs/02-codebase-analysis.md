# 02 - 代码库现状与扩展点

> 本文记录当前 submodule 功能分支，而不是上游仓库的历史默认分支。2026-08-24
> 同步审计：`ygopro` 已合入 `origin/server@04f0bc5f`；`srvpro` 以 Cube fork 为
> 基线并对 `origin/mercury@a252923` 做逐提交移植。行号会随编译/合并变化，优先
> 使用文件和符号名定位。

## 1. ygopro（`ygopro/` submodule）

### 1.1 目录与构建模式

`cube-server` 同时保留客户端和无头宿主源码；是否生成宿主由
`YGOPRO_SERVER_MODE`/premake 配置决定，不是一个独立的 `server/` 目录。
核心目录如下：

```text
gframe/       网络、GUI、卡组管理和宿主入口
ocgcore/      规则引擎（另有自己的 submodule）
script/       运行时脚本（外部资源也可单独部署）
resource/     客户端资源
premake5.lua  Linux/Windows 工程生成
```

Linux 宿主由 `scripts/build-ygopro.sh` 构建；客户端构建使用
`--client` 以及可选的 `--max-extra/--max-side` 宏。Windows 侧使用
已有 `premake5.exe` 生成 VS2022 工程，最终必须从正确的 Release 配置取得
`YGOPro.exe`，不能把 Debug/中间文件当成可运行产物。

### 1.2 入口与运行时 deck limit

`gframe/gframe.cpp` 的 server 入口接受前 12 个传统参数；Cube 房间在其后
追加显式 marker 和四个纯数字参数：

```text
13 --cube-deck-limits   14 main_min   15 main_max   16 extra_max   17 side_max
```

`server_args.h` 严格校验范围和 min/max，随后 replay seed 从第 18 项开始；非法
显式扩展直接拒绝启动。旧版第 13--16 项四数字布局继续兼容，seed 从第 17 项
开始；无扩展时沿用编译期默认值。seed 还需通过精确解码长度检查。

`gframe/deck_manager.h/.cpp`：

- `DeckManager::SetDeckLimits()` 校验非负数和 min≤max；非法值保持默认。
- `CheckDeck()` 使用运行时 main/extra/side 上限。
- server 的 `SingleDuel`、`TagDuel` 和 `LoadSide()` 都传递相同运行时上限，
  确保 BO3 换 side 不会回退到 15 张静态上限。
- `LoadDeck()` 对未知编号返回错误码，对超过上限的输入截断；因此业务层仍
  必须在构筑锁定和比赛开始前检查上限，不能只依赖宿主错误码。

### 1.3 Cube 客户端改动

`gframe/network.h` 新增 `STOC_CUBE_DECK = 0xA`，不修改既有 struct 大小。
`duelclient.cpp` 收到该消息后：

1. 读取 main（含 extra）和 side 编码，限制消息长度并拒绝不安全文件名；
2. 保存为 `deck/cube-deck-<tid>-<pid>-<timestamp>.ydk`（旧 payload 没有
   文件名时仍兼容 `cube-current`）；
3. 刷新卡组列表、加载 `current_deck` 并锁定选组控件；
4. 进入 siding 时保存快照，`deck_con.cpp` 只允许在三区总多重集不变的前提下
   调整 main/extra/side。

加入房间的长密码也在客户端实现：短密码仍发送标准 48 字节
`CTOS_JoinGame`；超过 20 个 UTF-16 code unit 时发送 NUL 结尾的扩展包，最大
255 个 UTF-16 code unit，编码失败或超限会显式报错，不静默截断。

`PRO_VERSION`/Windows 数值版本跟随上游，本分支只在窗口标题和字符串文件版本
追加 `-cube`（当前为 `1.036.2-cube`），避免形成不兼容的私有网络主版本。

### 1.4 协议兼容边界

- deck limit 走宿主命令行，不占 CTOS/STOC 既有 struct。
- `STOC_CUBE_DECK` 是新增消息；旧客户端会忽略，无法获得自动同步/锁定能力，
  但仍可按 srvpro 的 UPDATE_DECK 覆盖逻辑对战。
- 修改 `network.h` 的消息布局时，必须同步 srvpro 的
  `data/proto_structs.json`；当前 Cube 扩展没有改既有布局。

## 2. srvpro（`srvpro/` submodule）

### 2.1 启动与房间

`ygopro-server.coffee` 是主实现，改动后必须同步编译为
`ygopro-server.js`。默认游戏端口是 7911，HTTP 端口 7922，HTTPS 可选 7923；
`data/default_config.json` 的 `modules.cube` 默认关闭以保护普通部署。

`Room` 构造器把房间名规则解析为 `hostinfo`。Cube 相关 token 为：

```text
MAIN40-60 / MN40-60
EXTRA30   / EX30
SIDE30    / SD30
CUBE      （等价于 M,TM999,EX30,SD30；`CUBE#password` 保留 `#` 后密码）
```

同时支持 `LP/TIME/START/DRAW/M/NOCHECK/...` 等旧 token。Cube/当前直接建房
最终强制 `lflist=-1` 与 `duel_rule=5`，由卡池而不是禁限卡表定义环境。

`Room.spawn()` 调用 `rawSpawn('./ygopro', args, {cwd: 'ygopro'})`，读取宿主
stdout 的端口并设置 `established`。Cube 房间还设置 `no_check_deck=true`、
保存 replay，并在末尾追加 marker 与四个 deck limit 参数。

### 2.2 Cube HTTP API

`cube.coffee` 挂载到现有 HTTP listener，所有端点都要求
`X-Cube-Api-Key`：

| 端点 | 行为 |
| --- | --- |
| `POST /cube/create_room` | 幂等创建房间、等待宿主建立，返回房间名和端口 |
| `GET /cube/room_status?room_name=` | 返回建立状态、端口、阶段、玩家连接和分数 |
| `POST /cube/close_room` | 调用 `room.delete()`，触发正常清理/结果 webhook |

请求体有 1 MiB 上限并在 spawn 前做字段白名单、范围、ASCII、卡组文件名与卡号
校验；`request_id` + 请求指纹保证网络重试不重复创建宿主。请求的
`players[].name_vpass` 必须与客户端加入时使用的昵称一致；不在登记表
中的玩家会被踢出 Cube 房间。API 没有单独的 `/cube/result` 入站端点，结果由
srvpro 直接 POST 到 cube API 的 `/cube/result` webhook。

### 2.3 卡组覆盖和换 side

`UPDATE_DECK` handler 在 Cube 房间执行以下分流：

- `duel_stage=BEGIN`：忽略客户端上传内容，使用 `cube_decks[player_id]`
  覆盖；并以覆盖后的 buffer 作为重连比对基准。
- siding：检查客户端提交的 main+extra+side 与服务器卡组的多重集合以及各区
  数量是否一致。合法时原样转发换 side；不合法时回退为服务器卡组，保证旧
  客户端不会卡死。

handler 同时拒绝过大的协议计数（main/side >256），避免恶意 buffer。宿主仍
  负责未知卡和运行时 deck limit 的最终检查。

### 2.4 长房间密码

标准 `CTOS_JoinGame.pass[20]` 仍兼容。扩展包的前 8 字节保持版本、对齐和
gameid，后接 UTF-16LE 密码与 NUL。srvpro 要求扩展包长度、NUL 终止、尾部全为
零且最多 255 个 UTF-16 code unit；格式错误会发送错误并取消本次加入。这样
超长 Cube 房间密码不会因 struct 截断而匹配到错误房间。

### 2.5 结果与重连

`Room.delete()` 在 `modules.cube.enabled && room.cube_mode` 时向
`webhook_url` POST 精简的房间、玩家和 score 结算字段，不发送 deck/history/
replay，带 `X-Cube-Api-Key`、请求超时与响应上限，使用既有 `utility.retry`
重试 10 次。
普通 arena/challonge 上报路径不受影响。

srvpro 原有 `modules.reconnect` 继续负责代理断线重连；Cube 的重连比较基准
是服务器推送的固定卡组，而不是客户端可篡改的上传 buffer。

## 3. 扩展点映射

| 需求 | 当前实现 | 主要文件 |
| --- | --- | --- |
| 动态 deck limit | 已实现，marker + 四限制（legacy 兼容） | `ygopro/gframe/gframe.cpp`, `server_args.h`, `deck_manager.*`, `srvpro/ygopro-server.coffee` |
| 服务器权威 Cube 卡组 | 已实现，开局覆盖、siding 校验 | `srvpro/ygopro-server.coffee` |
| 长密码 | 已实现，客户端扩展包 + srvpro 严格解析 | `ygopro/gframe/duelclient.cpp`, srvpro handler |
| 自动落盘并锁定卡组 | 已实现，命名文件 + STOC 0xA | `ygopro/gframe/duelclient.cpp` |
| 对局结果 | 已实现 webhook，cube API 另有轮询兜底 | `Room.delete()`, `cube/apps/api/src/matches` |
| 协议修改 | 当前只新增消息 ID，不改旧 struct | `network.h`, `data/proto_structs.json` |

## 4. 部署注意事项

1. `srvpro/ygopro/ygopro`（或 Windows 对应 exe）必须是与当前 `cube-server`
   参数协议匹配的宿主；普通上游 server 二进制不会识别 marker 扩展。

2. 卡牌运行资源不在根仓库：部署时单独挂载 `cards.cdb`、`script/`、`pics/`
   和 `expansions/`，不要提交指向个人 Windows 路径的符号链接。
3. CoffeeScript 与 JS 必须成对更新；发布前运行 `npx coffee -c` 并检查生成
   文件已包含扩展逻辑。
4. 客户端、srvpro、宿主升级应按“先兼容旧消息，再切换新功能”的顺序；长密码
   和 STOC 0xA 均设计为可滚动升级。

## 5. 上游同步策略

- YGOPro 的 server 上游与 Cube 改动重叠较小，本轮完整 merge 无冲突，并同步
  nested `ocgcore`。以后同步后必须再次确认 `PRO_VERSION` 与上游相同，再追加
  `-cube` 展示后缀，并运行宿主/客户端构建。
- srvpro fork 与 mercury 的房间/网络层已有大量双向历史。2026-08-24 的试合并在
  13 个核心文件产生冲突，因此不把整分支 merge 当作“更新”。应审计上游安全、
  Node 兼容、房间生命周期提交，逐项移植并同步 CoffeeScript/生成 JS；每次通过
  `npm test`、`npm run build` 和真实建房探针后再更新 submodule 指针。

## 7. 卡片资源同步脚本

`scripts/update-card-resources.sh` 是资源更新的唯一入口，配套
`scripts/card_resources.py` 和 `scripts/remote-resource-apply.sh`。`check` 不
修改工作区；`sync` 只在 `codex/card-resource-sync-*` 分支抓取固定的
`mycard/ygopro/server` ref，并以 `--no-ff --no-commit` 合并。C++、cards.cdb 或
gitlink 冲突不会采用任一侧，必须人工解决后以 `--continue --commit` 继续。

`prepare` 对 cards.cdb 执行 SQLite 完整性检查，对图片 ZIP 拒绝绝对路径、`..`
路径、符号链接、重复编号、超大条目和超出总大小的归档；Lua 只同步新增/修改
文件，删除清单仅作用于上一次脚本管理的文件。资源清单记录提交、哈希、条目
数和缺失名称报告，状态目录被 `.gitignore` 忽略。Aly 发布先备份数据库/WAL/
SHM、配置及资源，取得远程锁后进入维护模式，原子切换资源目录并验收服务、
静态资源 MIME、API 和宿主动态库；失败时使用同一备份自动恢复。
