# 04 - srvpro 改造方案（cube 集成层）

> 目标代码库：`mycard/srvpro`。**分支策略**：新建 `cube` 分支，禁止直接改 master。改动集中在 `ygopro-server.coffee` + `data/default_config.json` + 新增 `cube.coffee`（建议拆出独立模块文件，避免单文件继续膨胀）。

## 1. 需求映射

| 需求 | 实现位置 |
|---|---|
| deck size 动态可配置（建房间参数） | Room 构造器规则解析 + spawn 参数追加 |
| 固定卡组记录、自动加载、验证 ID | UPDATE_DECK handler（cube 模式覆盖）+ 房间存储 |
| 断线重连 | 复用 `modules.reconnect`（确认开启 + 文档化） |
| 比赛结果自动获取，供 cube 调用 | 新增 `modules.cube`：webhook 推送（主）+ HTTP 查询（兜底） |
| cube 建房间/通知服务器信息+密码 | HTTP `/cube/*` API（api_key 鉴权） |

## 2. 改动清单

### 2.1 房间规则 token：deck size（Room 构造器）

**文件：`ygopro-server.coffee`，`Room` 构造器（1289 起，规则解析段 1333-1436）**

- 新增 token（风格与现有 `LP8000,TIME180` 一致）：
  - `MAIN<min>-<max>`（如 `MAIN40-60`，短别名 `MN40-60`）
  - `EXTRA<max>`（如 `EXTRA15`，短别名 `EX15`）
  - `SIDE<max>`（如 `SIDE15`，短别名 `SD15`）
- 协议限制：JOIN_GAME 的 pass 字段只有 20 个 UTF-16 字符，长规则串（如 `EXTRA30,SIDE30,M,TIME999#test` 共 29 字符）在标准客户端会被截断；srvpro 做了两层兼容：① 短别名（`EX30,SD30,M,TM999#x` 可放进 20 字符）；② 扩展解析——若客户端发送了超过 48 字节的加长 JOIN_GAME 包，srvpro 从原始 buffer 还原完整 pass（老客户端行为不变）。
- 解析结果存入 `@hostinfo.deck_size = { main_min, main_max, extra_max, side_max }`；未指定时回退 `{40,60,15,15}`。
- 同时允许 cube API 直接传 `hostinfo` 对象（见 2.4），token 解析与 API 传参共用同一校验函数 `normalizeDeckSize()`。
- 紧凑格式（1333 正则）不改，cube 房间统一走扩展 token 或 API 传参。

### 2.2 spawn 参数追加（Room.spawn，1454-1457）

- 在现有 12 参数后追加 4 位：`@hostinfo.deck_size.main_min, main_max, extra_max, side_max`（顺序与 ygopro 侧 03-2.1 一致）。
- 仅当 `@hostinfo.deck_size` 存在（cube 创建）时追加；普通房间不带 → 老宿主二进制行为不变。
- spawn 前对 `@hostinfo.deck_size` 做 `normalizeDeckSize()` 归一化：规则字符串 token 可能只给部分字段（如仅 `MAIN40-50`），缺项回退默认，避免把 `undefined` 传给宿主导致 `SetDeckLimits` 静默失效（含 `deck_limits_set` 强制校验失效）。
- 同步 ygopro 侧 `cube-server` 分支的解析（03-2.1），交付时两边参数表必须一致（维护在 07-protocol-api-design.md）。

### 2.3 固定卡组自动加载与 ID 验证（UPDATE_DECK handler，3487 起）

cube 模式（`room.cube_mode`）下，UPDATE_DECK 处理改为：

1. 按玩家身份（cube 在建房间时写入的 `player_id` ↔ srvpro 连接，**按 `client.name_vpass` 匹配**，如 `alice$pw1`）查房间内记录的固定卡组 `room.cube_decks[player_id]`；
2. **忽略客户端上传的卡组内容**，把记录的卡组编码为 UPDATE_DECK buffer 并**返回该 buffer 替换转发包**（YGOProMessages 的 handler 返回 Buffer 才会替换转发内容，只改局部变量无效——`YGOProMessages.js:259-263`）；
3. **ID 验证**：交给宿主 `LoadDeck`（未知 card code 记 `deck_error` → PlayerReady 报 UNKNOWNCARD）；srvpro 侧只做友好提示；
4. 数量校验语义（实测确认）：宿主 `LoadDeck` 会把超出 `main_max/extra_max/side_max` 的卡**截断丢弃**（不会报错），`CheckDeck` 实际可触发的错误是 **main 低于 `main_min`（MAINCOUNT）与未知卡（UNKNOWNCARD）**；上层（cube 后端锁定校验）负责 max 侧拦截。

> 说明：srvpro 不解析 cdb 数据结构本身时，可只做"ID 存在性"检查（data-manager 提供查询接口，实现时确认其 API），类型/数量规则由宿主最终裁决；srvpro 侧重提前反馈与日志。

### 2.4 HTTP `/cube/*` API（新增模块 `cube.coffee`）

复用现有 http server（`httpRequestListener`，634）。新增端点（挂 `settings.modules.http` 同服）：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/cube/create_room` | POST | 建房间：参数 = 房间名规则/或显式 hostinfo、密码、玩家列表（name_vpass + cube player_id）、cube_decks、cube_mode |
| `/cube/room_status` | GET | 查询房间状态：players 连接情况、duel_stage、scores、decks、replays 摘要（供 cube 轮询兜底） |
| `/cube/close_room` | POST | 强制解散房间（走 room.delete 流程，正常上报结果） |
| `/cube/result` | POST | **cube 主动确认收到结果的 ack**（配合 webhook 重试） |

- 鉴权：`X-Cube-Api-Key: <settings.modules.cube.api_key>`（所有 /cube/* 必带；与玩家协议隔离）。
- 房间名生成：由 cube 生成唯一名（如 `CUBE-<tournamentId>-<round>-<table>`），srvpro 侧无需理解其业务含义；规则字符串与显式参数二选一，推荐显式 hostinfo 对象（避免长名字符串解析出错）。

### 2.5 结果上报 webhook（room.delete()，1510 起）

- 新增 `settings.modules.cube.enabled && room.cube_mode` 分支：`axios.post(settings.modules.cube.webhook_url, {...})`（JSON，结构见 07-protocol-api-design.md），沿用 `utility.retry` 重试；cube 返回 ack 后停止重试。
- 载荷包含：tournament_id、room 名、players（cube player_id + name_vpass）、scores、decks、deck_history、replays(base64)、first、wins、start/end。
- 现有 arena_mode/challonge 分支不受影响。

### 2.6 配置（data/default_config.json 新增 `modules.cube`）

```json
"cube": {
  "enabled": false,
  "api_key": "",
  "webhook_url": "",
  "deck_override": true,
  "reconnect": true
}
```

- 默认 `enabled: false`，存量部署零影响。
- 启动 init()（267 起）增加 cube 模块初始化：校验 api_key 非空、webhook_url 合法、注册 HTTP 路由（若启用）。
- 建 cube 房间时强制 `no_check_deck=T`（deck_override 依赖）与 `replay_mode |= 0x1`（保存回放供 cube 归档）。

### 2.7 断线重连

- 确认 `modules.reconnect` 配置在 cube 房间默认开启；cube 玩家断线 → 代理连接保持 + 超时窗口内重连比对固定卡组（2.3 已保证卡组一致，天然通过 `CLIENT_is_able_to_reconnect` 比对）。
- 文档化参数：重连窗口秒数、是否允许踢号重连（`CLIENT_kick_reconnect`）。

## 3. 构建与交付

- 修改 `.coffee` 后编译：`npx coffee -c ygopro-server.coffee cube.coffee ...`（产出 .js）；Docker 镜像（Dockerfile）内已有编译步骤则保持一致。
- 交付物：`cube` 分支 + 编译产物 + `config/settings.json` 示例（含 modules.cube 与 ygopro 部署路径）。

## 4. 验收标准

1. `curl -X POST /cube/create_room`（带 api_key）可建出 cube 房间；ygopro 宿主进程被 spawn，参数含 4 个 deck size 值；stdout 端口被读取，房间 established。
2. 玩家用客户端进房：**客户端上传任何卡组都会被固定卡组覆盖**；非法 ID 卡组被拒并收到友好提示。
3. 对局结束 → room.delete → `/cube/webhook_url` 收到完整 JSON 载荷（重试后 ack 生效）；中途 kill cube 后端，srvpro 重试 10 次不丢数据。
4. 玩家断线 30s 内重连成功且卡组比对通过；超时后房间正常清理。
5. `modules.cube.enabled=false` 时全部行为与 master 一致（回归）。

## 5. 相关文件清单

| 文件 | 改动 |
|---|---|
| `ygopro-server.coffee` | Room 构造器 token、spawn 参数、UPDATE_DECK 分支、room.delete webhook、init 初始化 |
| `cube.coffee`（新增） | /cube/* 路由、校验、结果载荷组装 |
| `data/default_config.json` | modules.cube 配置段 |
| `data/proto_structs.json` | 无改动（协议结构不变；如 03-2.3 未来扩展再同步） |
| `README.md` / `config/settings.json.example` | cube 部署说明 |
