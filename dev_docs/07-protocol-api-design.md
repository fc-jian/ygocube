# 07 - 接口与协议设计（三侧契约）

> 本文档是 **cube ↔ 浏览器**、**cube ↔ srvpro**、**srvpro ↔ ygopro 宿主** 三组接口的唯一契约。任何变更必须同步更新本文档与 `cube/packages/shared`。

## 1. 总览

```
浏览器 ──REST/SSE(三要素鉴权)──▶ cube api ──HTTP(X-Cube-Api-Key)──▶ srvpro ──spawn 参数──▶ ygopro 宿主
```

## 2. 浏览器 ↔ cube api

### 2.1 鉴权（三要素 + admin token 体系）

- 玩家身份 = `tournamentId + playerId + token`，**三个字段缺一即 401**（除非该 tournament 已被 admin 关闭 token 鉴权，见 §5.3）。
- 传递方式（任选其一，优先 cookie）：
  - Cookie：`yc_tid / yc_pid / yc_token`（报名时种入；token 同时页面展示支持手动输入；logout 即清除这三个 cookie）；
  - Header：`X-Tournament-Id / X-Player-Id / X-Token`；
  - 查询参数/表单字段：`tid / pid / token`（SSE、ydk 下载等场景）。
- admin 端点用 `X-Admin-Token`：super token（config.yaml `admin.super_token`）或创建 tournament 时下发的 per-tournament `admin_token`（仅限该 tournament）。
- `POST /tournaments` 需要 `X-Create-Token`（config.yaml `admin.create_token`；super token 亦可），响应返回 `admin_token`。
- **super token 兼作万能玩家 token**：`X-Token: <super_token>` 可进入任意 `playerId` 的玩家端点（同机调试）。
- 公开信息 `GET /t/:tid` 返回 `authRequired`（false = 该 tournament 已关闭 token 鉴权，玩家端点仅需 tid+pid）。
- 统一错误：`401 { code: "AUTH_REQUIRED", fields: [...] }`。

### 2.2 REST 端点

| 方法/路径 | 说明 |
|---|---|
| `POST /tournaments` (X-Create-Token) | 创建比赛（人数/卡池/模式/选牌参数/排表规则；`cardPool` 必须为已存在的卡池名，`'full'`/缺省/不存在均拒绝）→ 返回 `tid` + 报名 URL + `admin_token` |
| `GET /t/:tid` | 比赛公开信息（阶段、人数、配置摘要） |
| `POST /t/:tid/join` | 报名：body `{ player_id, display_name }` → 返回 `token`（明文仅此一次） |
| `GET /t/:tid/state` | 当前玩家全量状态（阶段、牌堆信息、已选牌、构筑、对局信息） |
| `GET /t/:tid/cards?q=` | 卡牌全文本搜索（名称/效果文本/code；不含图片） |
| `GET /t/:tid/cards?codes=a,b,c` | 按 code 批量取卡牌元数据 |
| `GET /t/:tid/cards/status?codes=` | 玩家视角卡牌状态标注（not_in_pool/dropped/picked/seen/unknown） |
| `GET /pools` (public) | 卡池名称+数量（创建页下拉用；不含卡 code） |
| `GET /pics/:code.avif` (public) | 低清 avif 缩略图（config.yaml pics.avif_dir，默认 assets/pics_avif；找不到 404） |
| `GET /pics/:code` (public) | 原图只读代理（config.yaml pics.ygopro_root；找不到 404；不入库） |
| `POST /t/:tid/pause` | body `{ action: "propose" \| "vote_yes" \| "vote_no" \| "resume" }` |
| `POST /t/:tid/pick` | body `{ card_code, target_zone? }`（选牌；`target_zone` 为拖拽目标区 main/extra/side，类型不符 409 WRONG_ZONE；缺省按卡类型入区） |
| `POST /t/:tid/deck/move` | body `{ card_code, from, to, index }`（构筑期移动/换序；`to` 可为 `pool` = 移出构筑；`from=pool` 必须属于本人已选卡，否则 409 CARD_NOT_IN_POOL） |
| `POST /t/:tid/deck/lock` / `POST /t/:tid/deck/unlock` | 锁定/解锁 |
| `GET /t/:tid/deck.ydk` | 当前玩家卡组导出；Content-Disposition 文件名 `deck-<tid>-<pid>-<timestamp>.ydk` |
| `GET /t/:tid/matches` | 该玩家全部轮次的历史对局与房间信息：`{id, round, tableNo, playerA, opponent, roomName, resultA, resultB, startedAt, finishedAt}`（按轮次/桌号排序；房间名含随机词防进错；无独立密码，进房昵称 = playerId） |
| `GET /t/:tid/ranking` | 实时积分榜（胜 3/平 1/负 0，OMW% 破同分；不含卡牌信息） |
| `GET /meta` (public) | 对局服务器连接信息：`{ srvpro: { host, gamePort } }`（config.yaml `srvpro.game_port`） |
| `POST /admin/t/:tid/security` | body `{ require_token: false }` 关闭/开启该 tournament 的 token 鉴权 |
| `GET/POST /admin/pools`、`POST /admin/pools/random`、`DELETE /admin/pools/:id` | 卡池维护（super 专属；random 从全卡表采样 size 张，默认 1000） |
| `POST /admin/t/:tid/start_draft` 等 | 管理员阶段控制（super 或 per-tournament token） |
| `POST /admin/t/:tid/players` | 添加玩家 `{player_id, display_name}`（报名阶段，ASCII 校验；返回 `{token}`） |
| `DELETE /admin/t/:tid/players/:pid` | 删除玩家（报名/选牌/构筑阶段；同时清理其选牌与卡组；对战开始后 409） |
| `POST /admin/t/:tid/players/:pid/token` | 重置玩家 token 并返回新明文（token 仅存哈希，不可回显旧值） |
| `POST /admin/t/:tid/match/result` | 手动设置/修改对局结果 `{round, tableNo, resultA, resultB}`（0-2 整数）；触发轮次推进与积分即时更新，并关闭对应 srvpro 房间 |
| `POST /admin/t/:tid/revert` | body `{ seq }` 回溯到历史事件序号 |

### 2.3 SSE 事件（`GET /t/:tid/stream?tid=&pid=&token=`）

> **脱敏**：所有广播事件不携带卡牌/卡组内容与其他对局的房间名；客户端收到后 refetch 本人状态。

| 事件 | 载荷要点 |
|---|---|
| `phase` | 当前阶段/子阶段 |
| `pack` | pack_index、剩余数、剩余堆数、当前选牌者、deadline_at（秒级 timer 由前端算） |
| `pick` | `{playerId, auto}`（不含卡 code） |
| `pause` | paused 状态、剩余暂停秒、投票统计 |
| `deck` | `{playerId}`（内容由客户端 refetch） |
| `match` | `{id, round, tableNo, resultA, resultB, finished}`（不含 roomName；房间信息走 `/t/:tid/matches`） |
| `notice` | 系统消息（超时自动选、自动修正等） |

## 3. cube ↔ srvpro（HTTP + `X-Cube-Api-Key`）

### 3.1 `POST /cube/create_room`

请求（JSON）：
```json
{
  "room_name": "CUBE-1-1-3-ember",   // 规律编号 + 随机词（防玩家进错房间）
  "password": null,
  "hostinfo": {
    "mode": 1,
    "rule": 0, "lflist": -1, "duel_rule": 5,
    "start_lp": 8000, "start_hand": 5, "draw_count": 1,
    "time_limit": 180,
    "no_check_deck": true, "no_shuffle_deck": false
    // time_limit 来自 tournament 配置 timeLimit（默认 180；999 ≈ 不限时，对应规则 token TIME999）
    // lflist 恒为 -1：cube 与直接建房一律不应用禁限卡表（轮抽由卡池自行约束）
    // duel_rule 恒为 5：一律使用新大师规则2020（≥4 时客户端按 2020 布局渲染）
  },
  "deck_size": { "main_min": 40, "main_max": 60, "extra_max": 15, "side_max": 15 },
  "players": [
    { "player_id": "alice", "name_vpass": "alice" },   // name_vpass = playerId，加入校验按此匹配
    { "player_id": "bob",   "name_vpass": "bob" }
  ],
  "cube_decks": {
    "alice": { "main": [12345, 67890], "extra": [], "side": [] },
    "bob":   { "main": [...], "extra": [], "side": [] }
  }
}
```

响应：`{ "ok": true, "port": 20123, "room_name": "CUBE-1-1-3" }`（端口 = 宿主 stdout 上报，established 后返回；超时返回 `{ "ok": false, "code": "ROOM_TIMEOUT" }`）。

### 3.2 `GET /cube/room_status?room_name=`

响应：`{ room_name, established, duel_stage, players: [{player_id, connected, ready}], scores, finished }`。

### 3.3 `POST /cube/close_room`

请求：`{ "room_name": "CUBE-1-1-3" }`；走正常 delete 流程（触发结果上报）。

### 3.4 `POST /cube/result`（srvpro → cube webhook）

srvpro 在 `room.delete()` 时 POST 到 `settings.modules.cube.webhook_url`：
```json
{
  "tournament_id": "1", "room_name": "CUBE-1-1-3",
  "start": "...", "end": "...",
  "players": [
    { "player_id": "alice", "name_vpass": "alice#pass1", "score": 2, "deck": {...}, "deck_history": [...] }
  ],
  "first": [ ... ], "wins": [ ... ],
  "replays": ["<base64>"]
}
```
- cube 必须响应 `200 { "ack": true }`；srvpro 未收到 ack 则按 `utility.retry`（10 次）重试。
- 错误码：`400 BAD_PAYLOAD` / `409 ALREADY_ACKED`（幂等）。

### 3.5 鉴权与错误

- 所有 /cube/* 必须带 `X-Cube-Api-Key`；错误 `401 INVALID_API_KEY`。
- 幂等：create_room 对相同 room_name 重复调用返回既有房间；result 重复投递返回 409。

## 4. srvpro ↔ ygopro 宿主（spawn 参数）

### 4.1 参数布局（必须与 ygopro cube-server 分支解析一致）

| 位 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 含义 | 0 | lflist | rule | mode | duel_rule | nc_deck | nc_shuf | lp | hand | draw | time | replay | **main_min** | **main_max** | **extra_max** | **side_max** |

- 位 13~16 仅在 cube 房间追加（03-2.1 / 04-2.2）；老宿主忽略（`argc<17` 不解析）。
- match 模式 seed 从位 17 起。

### 4.2 游戏协议（CTOS/STOC）

- 本阶段**不改消息结构**（deck size 走 CLI，不占协议字段）；若未来客户端要显示限制，新增字段需同步 `network.h ↔ data/proto_structs.json` 并 bump `PRO_VERSION`。

## 5. 错误码总表（cube api）

| code | HTTP | 含义 |
|---|---|---|
| AUTH_REQUIRED | 401 | 三要素/admin token/create token 缺失或非法（fields 指明缺项） |
| NOT_FOUND | 404 | 比赛/玩家不存在 |
| WRONG_PHASE | 409 | 当前阶段不允许该操作（如非选牌期 pick） |
| NOT_YOUR_TURN | 409 | 非当前选牌者 |
| DECK_INVALID | 409 | 卡组不合法（含 detail 数组逐条错误） |
| PAUSE_LIMIT | 409 | 暂停次数/时长超限 |
| SRVPRO_ERROR | 502 | srvpro 调用失败（含 code） |
| POOL_EXISTS / POOL_NOT_FOUND | 409 | 卡池重名 / 卡池不存在 |
| FORBIDDEN | 409 | 权限不足（如非 super 操作卡池） |

### 5.1 配置与 token（config.yaml）

| 项 | 位置 | 说明 |
|---|---|---|
| super_token | `admin.super_token` | 全部 tournament + 卡池 |
| create_token | `admin.create_token` | 创建 tournament |
| per-tournament admin_token | 创建响应 | 管理单个 tournament |
| srvpro url/api_key | `srvpro.*` | cube↔srvpro |
| db_path / cards_cdb | `server.*` | 相对 config.yaml 解析 |
| pics.ygopro_root | config.yaml | 服务端本地原图根目录（可选） |
| pics.avif_dir | config.yaml | 低清 avif 缩略图目录（默认 assets/pics_avif） |
