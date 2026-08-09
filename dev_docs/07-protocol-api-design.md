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
- `POST /tournaments` 需要 `X-Create-Token`（config.yaml `admin.create_token`；super token 亦可），响应返回 `admin_token`。 参数含 `dropMode`（`use_all` / `drop_leftover` 默认 / `drop_leftover_exact`，见 dev_docs/05 §牌堆生成；**legacy**：仅未显式设置 `packCount` 时生效，保留用于旧比赛回放兼容）。 另有 `packStrategy`（`stratify` 默认 / `random` / `main_then_extra`）、`packSize`（每堆卡数，任意正整数；不参与公平性判断）、`packCount`（显式牌堆总数：≤ floor(池卡数/packSize) = 固定堆数、剩余卡随机丢弃；实际入堆集合先按全卡池 main/extra 比例分层随机抽样，确保弃置比例在整数误差内均匀；**> 该上限 = 推断为用尽全部卡池**，堆数 = ceil(池卡数/packSize)、末堆可不满、不丢弃；缺省按 dropMode 自动）、`dropPublic`（弃置卡是否公开，默认 false）、`draftMode`（`passing` 默认 / `serial` 旧串行模式，见 dev_docs/05 §3）、`evenPackCount`（默认 true：牌堆数须为人数整数倍，显式 packCount 非倍数拒绝 PACKCOUNT_NOT_MULTIPLE，计算结果向下取整到倍数；这是 passing 模式的公平性条件）、`reserveSeconds`（passing 模式每玩家保留时间，默认 300；单选超时先扣保留时间，耗尽才自动选）、`reseatEachRound`（passing 模式每轮结束后随机重排玩家座位，默认 true）、`deckbuildingSeconds`（构筑限时秒数；`null`/缺省表示无限，必须由管理员手动进入对战阶段）。
- **super token 兼作万能玩家 token**：`X-Token: <super_token>` 可进入任意 `playerId` 的玩家端点（同机调试）。
- 公开信息 `GET /t/:tid` 返回 `authRequired`（false = 该 tournament 已关闭 token 鉴权，玩家端点仅需 tid+pid）。
- 统一错误：`401 { code: "AUTH_REQUIRED", fields: [...] }`。

### 2.2 REST 端点

| 方法/路径 | 说明 |
|---|---|
| `POST /tournaments` (X-Create-Token) | 创建比赛（人数/卡池/模式/选牌参数/排表规则；`cardPool` 必须为已存在的卡池名，`'full'`/缺省/不存在均拒绝）→ 返回 `tid` + 报名 URL + `admin_token` |
| `GET /t/:tid` | 比赛公开信息（阶段、人数、配置摘要） |
| `POST /t/:tid/join` | 报名：body `{ player_id, display_name }` → 返回 `token`（明文仅此一次） |
| `GET /t/:tid/state` | 当前玩家全量状态（阶段、牌堆信息、已选牌、构筑、对局信息）及本人 `disqualified`。passing 模式下 `players` 与 `queueLengths` 总按当前 `seat` 升序（即从左到右传递顺序）；`pack` = 本人队首堆（`index/cardsLeft/cards/deadlineAt(=base+reserve 的最终自动选时刻)/pausedRemainingMs(暂停时冻结的剩余毫秒)/isMyTurn(=队列非空)/queueLength/reserveMs`），顶层 `draftReserveMs` 始终给出本人剩余保留时间，即使当前队列为空。另含 `cardsRemainingToDraft`（当前玩家到选牌结束仍可获得的卡数）与 `cardsRemainingExact`（是否为严格值；完整公平轮为 true）；限时构筑被管理员冻结时 `phaseDeadline=null`、`phaseDeadlineRemainingMs` 为冻结值。 |
| `GET /t/:tid/cards?q=` | 卡牌全文本搜索（名称/效果文本/code；不含图片） |
| `GET /t/:tid/cards?codes=a,b,c` | 按 code 批量取卡牌元数据 |
| `GET /t/:tid/cards/status?codes=` | 玩家视角卡牌状态标注（not_in_pool/dropped/picked/seen/unknown） |
| `GET /pools` (public) | 卡池名称+数量（创建页下拉用；不含卡 code）；全局默认卡池带 `isDefault:true` 并由创建页优先选中 |
| `GET /pics/:code.avif` (public) | 低清 avif 缩略图（config.yaml pics.avif_dir，默认 assets/pics_avif；找不到 404） |
| `GET /pics/:code` (public) | 原图只读代理（config.yaml pics.ygopro_root；找不到 404；不入库） |
| `POST /t/:tid/pause` | body `{ action: "propose" \| "vote_yes" \| "vote_no" \| "resume" }` |
| `POST /t/:tid/pick` | body `{ card_code, target_zone? }`（选牌；`target_zone` 为拖拽目标区 main/extra/side，类型不符 409 WRONG_ZONE；缺省按卡类型入区） |
| `POST /t/:tid/deck/move` | body `{ card_code, from, to, index }`（构筑期移动/换序；`to` 可为 `pool` = 移出构筑；本人选到过该编号即可从 pool 使用，三个区域合计最多 `maxCopies` 份） |
| `POST /t/:tid/deck/sort` | 按 YGOPro 卡组编辑器 `deck_sort_lv` 的唯一逻辑一次整理 main/extra/side；不自动触发，新卡仍追加末尾且之后仍可拖动。 |
| `POST /t/:tid/deck/shuffle` | 随机打乱 main 的持久化顺序，用于构筑阶段模拟洗牌/抽卡；extra/side 保持原顺序。 |
| `POST /t/:tid/deck/lock` / `POST /t/:tid/deck/unlock` | 锁定/解锁 |
| `GET /t/:tid/deck.ydk` | 当前玩家卡组导出；Content-Disposition 文件名 `cube-deck-<tid>-<pid>-<timestamp>.ydk` |
| `GET /t/:tid/matches` | 该玩家全部轮次的历史对局与房间信息：`{id, round, tableNo, playerA, opponent, roomName, resultA, resultB, startedAt, finishedAt}`（按轮次/桌号排序；房间名含随机词防进错；无独立密码，进房昵称 = playerId） |
| `GET /t/:tid/ranking` | 实时积分榜（胜 3/平 1/负 0，OMW% 破同分；不含卡牌信息） |
| `GET /meta` (public) | 对局服务器连接信息：`{ srvpro: { host, gamePort } }`（config.yaml `srvpro.host` + `srvpro.game_port`） |
| `POST /admin/t/:tid/security` | body `{ require_token: false }` 关闭/开启该 tournament 的 token 鉴权 |
| `POST /admin/t/:tid/admin-token` | 重置本场比赛的管理 token；旧 token 立即失效，响应仅此一次返回新明文 `admin_token` |
| `GET /admin/settings/default-pool` / `PUT /admin/settings/default-pool` | super admin 读取/设置全局默认卡池；PUT body `{ pool_id }` |
| `GET/POST /admin/pools`、`PUT/DELETE /admin/pools/:id`、`POST /admin/pools/random` | 卡池维护（super 专属；random 从全卡表采样 size 张，默认 1000）。创建接口除兼容 `codes: number[]` 外还接受 `importText: string`：逐行支持 `code` 或 `code<TAB>name`，带名称时必须与该 code 在卡表中的**字面原名**完全一致；不得用 `datas.alias` 指向的“规则上视作”卡名替代。响应包含 `filtered`、`missingCodes` 与逐行 `entryWarnings`（`invalid`/`missing_code`/`name_mismatch`），前端必须显式警告全部异常行，不得静默忽略。 |
| `POST /admin/t/:tid/start_draft` 等 | 管理员阶段控制（super 或 per-tournament token）。`POST /admin/t/:tid/phase` 从构筑进入对战时先只做卡组合规预检；若存在不合规卡组且未传 `confirm_invalid_decks:true`，不改变状态并返回 `requires_confirmation + invalid_decks`；确认后随机修复超限卡组，主卡组仍少于下限的玩家记 DSQ，再进入对战。 |
| `POST /admin/t/:tid/players` | 添加玩家 `{player_id, display_name}`（报名阶段，ASCII 校验；返回 `{token}`） |
| `DELETE /admin/t/:tid/players/:pid` | 删除玩家（报名/选牌/构筑阶段；同时清理其选牌与卡组；对战开始后 409） |
| `POST /admin/t/:tid/players/:pid/token` | 重置玩家 token 并返回新明文（token 仅存哈希，不可回显旧值） |
| `POST /admin/t/:tid/match/result` | 手动设置/修改对局结果 `{round, tableNo, resultA, resultB}`（0-2 整数）；结果齐后发 `round_complete` 事件，积分即时更新，并关闭对应 srvpro 房间 |
| `POST /admin/t/:tid/matches/advance` | **管理员确认推进**：当前轮全部对局有结果后开始下一轮（swiss→swiss；swiss 完→季后赛种子配对；季后赛→胜者配对；全部打完→finished）。瑞士轮生成必须把所有历史对手作为硬排除约束，以整轮回溯匹配保证不存在重复交手；不存在合法完整配对时拒绝生成。轮次**不自动推进**；决赛（季后赛最后一桌）结果齐时自动结束。错误：`NO_ROUND` / `ROUND_PENDING` / `ROUND_EXISTS` / `NO_VALID_PAIRING` / `WRONG_PHASE` |
| `PUT /admin/t/:tid/match-format` | 首场对局生成前设置明确赛制：`{matchFormat:'round_robin'|'swiss'|'double_elimination', swissRoundCount?, playoffSize?}`。瑞士淘汰人数只能为 0 或不超过有效人数的 2 次幂；首场生成后返回 `FORMAT_LOCKED`。新建比赛若省略字段，服务端按人数写入推荐值，不保留运行时自动选择。 |
| `POST /admin/t/:tid/players/:pid/withdraw` / `restore` | 标记玩家退赛；已生成的当前对局不关闭、不自动判负，后续排表排除。仅首场生成前允许恢复。 |
| `GET /admin/t/:tid/events` | 完整事件时间线（全局 seq + 可读摘要 + 时间），供回溯选择 |
| `GET /admin/t/:tid/revert/preview?seq=` | 预览硬回溯影响；`seq` 必须是本 tournament 的真实事件，返回将永久删除的事件/选牌/对局/活动房间数量 |
| `POST /admin/t/:tid/revert` | body `{ seq, confirm_name }`；校验比赛名后永久截断目标事件之后的事件/快照/投影，关闭活动 srvpro 房间并保持 frozen；响应含删除统计与 legacy `replacement_tokens` |

### 2.3 SSE 事件（`GET /t/:tid/stream?tid=&pid=&token=`）

> **脱敏**：所有广播事件不携带卡牌/卡组内容与其他对局的房间名；客户端收到后 refetch 本人状态。

| 事件 | 载荷要点 |
|---|---|
| `phase` | 当前阶段/子阶段 |
| `pack` | serial：pack_index、剩余数、剩余堆数、当前选牌者、deadline_at；passing：各玩家队列长度（`{queues: {playerId: length}}`，仅数量；秒级 timer 由前端算）或 `{deadlines: true}`（计时重设/新一轮发堆 `deal`，客户端 refetch） |
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
    "alice": { "main": [12345, 67890], "side": [], "filename": "cube-deck-1-alice-20260808153000" },
    "bob":   { "main": [...], "side": [], "filename": "cube-deck-1-bob-20260808153000" }
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
- `score` 语义：0/1/2 为获胜局数；**`-9` = 断线标记**（srvpro 在非 BEGIN 阶段断线时设置）。cube 侧归一化：断线方一律记 `0:2` 负；双方均断线记 `0:0`（无人胜出，swiss 各 1 分）；缺失 score 时按 `-5` 兜底记录，由管理员人工补录。

### 3.5 鉴权与错误

- 所有 /cube/* 必须带 `X-Cube-Api-Key`；错误 `401 INVALID_API_KEY`。
- 幂等：create_room 对相同 room_name 重复调用返回既有房间；result 重复投递返回 409。

## 4. srvpro ↔ ygopro 宿主（spawn 参数）

### 4.0 STOC_CUBE_DECK（srvpro → 客户端，cube 房间卡组推送）

- 新增 STOC id `0xA`（`ygopro/gframe/network.h`，只增不改，**不 bump PRO_VERSION**；旧客户端 switch default 忽略未知 STOC，向下兼容）。
- 触发：cube 房间中 srvpro 向玩家转发 STOC_JOIN_GAME 后立即注入一条；数据来自 `room.cube_decks[player_id]`。
- payload 前缀同 CTOS_UPDATE_DECK 体：`int32 mainc(含 extra), int32 sidec, int32 codes[main…, side…]`（客户端按卡类型自行分拣 extra）；其后可选追加 `uint16 filename_utf8_len + uint8 filename_utf8[]`。旧客户端忽略尾部，新客户端缺少尾部时兼容回退 `cube-current`。
- `filename` 由 cube API 生成并由 srvpro 透传，只允许安全文件名字符，格式 `cube-deck-<tid>-<pid>-<YYYYMMDDhhmmss>`（payload 不含 `.ydk`）。打补丁的客户端写 `./deck/<filename>.ydk` → 填入 `current_deck` 并选中 → 锁定卡组选择下拉（进房即锁定，离房复位）；siding 时客户端自检"三区并集多重集 == 开局快照"。
- **siding 服务端语义**：`CTOS_UPDATE_DECK` 的 cube 覆盖分支按 `duel_stage` 分流——`BEGIN` 整包覆盖（现状）；siding 阶段校验客户端提交与 cube 卡组"并集多重集相同 + 各区数量一致"（宿主 `LoadSide` 同样强制）→ 通过则**原样转发**（换 side 生效），失败则回退整包覆盖（未打补丁客户端行为同旧版，不卡死）。

### 4.1 参数布局（必须与 ygopro cube-server 分支解析一致）

| 位 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 含义 | 0 | lflist | rule | mode | duel_rule | nc_deck | nc_shuf | lp | hand | draw | time | replay | **main_min** | **main_max** | **extra_max** | **side_max** |

- 位 13~16 仅在 cube 房间追加（03-2.1 / 04-2.2）；老宿主忽略（`argc<17` 不解析）。
- match 模式 seed 从位 17 起。

### 4.2 游戏协议（CTOS/STOC）

- 本阶段**不改消息结构**（deck size 走 CLI，不占协议字段）；若未来客户端要显示限制，新增字段需同步 `network.h ↔ data/proto_structs.json` 并 bump `PRO_VERSION`。

### 4.2 JOIN_GAME 长房间密码

- 标准 `CTOS_JoinGame.pass[20]` 保持不变；19 个 UTF-16 code unit 以内仍发送标准 48 字节 payload。
- 打补丁客户端对更长输入发送相同 8 字节头（version/padding/gameid）+ NUL 结尾的变长 UTF-16LE pass，最大 255 个 UTF-16 code unit；srvpro 用完整值路由房间。
- 老客户端与老短密码行为不变；超限输入必须显式报错，禁止静默截断。

### 5.4 卡牌元数据

`GET /t/:tid/cards` 的卡牌对象除 `code/name/type/desc/level/race/attribute/atk/def/alias` 外，新增：

- `lscale/rscale`：cards.cdb 打包 level 的左右灵摆刻度；`level` 为低 8 位等级/阶级/Link 值。
- `linkMarkers`：Link 卡原始 def 中的箭头 bitmask（Link 的守备显示为 `-`）。
- `setCodes/setNames`：cards.cdb setcode 与配套 `strings.conf !setname` 解析结果。
- `q` 搜索覆盖名称、编号、效果以及所有实际展示的类型/种族/属性/等级/攻守/刻度/Link/系列文本。

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
| db_path / cards_cdb / strings_conf | `server.*` | 相对 config.yaml 解析；strings.conf 提供系列名 |
| allowed_origins | `server.allowed_origins` | CORS 精确白名单 |
| allow_insecure_defaults | `server.allow_insecure_defaults` | 仅本机临时开发；默认 false，生产拒绝占位 token/空 API key |
| pics.ygopro_root | config.yaml | 服务端本地原图根目录（可选） |
| pics.avif_dir | config.yaml | 低清 avif 缩略图目录（默认 assets/pics_avif） |
