# 07 - 接口与协议契约（当前版本）

> 本文、`cube/packages/shared/src/index.ts`、cube API controller 和 srvpro
> `cube.coffee` 共同组成契约。修改任一侧时先更新字段/错误码，再更新实现。

## 1. 三侧连接

```text
浏览器 ── REST/SSE ──▶ cube API ── HTTP + X-Cube-Api-Key ──▶ srvpro
                                                                  │
                                                                  └─ spawn 参数
                                                                     ▼
                                                               ygopro 宿主/客户端
```

根 API 前缀由 Web 的 `/api` 代理提供；文档中的路径均为去掉该代理前缀后的路径。

## 2. 浏览器 ↔ cube API

### 2.1 鉴权

- 玩家默认需要 `tid + pid + token`。比赛路由以 path 中的 `tid` 为准；浏览器使用
  按比赛隔离的 `yc_pid_<tid>/yc_token_<tid>` cookie，普通 fetch 也可使用
  `X-Tournament-Id/X-Player-Id/X-Token`。旧全局 cookie/query 仅作非敏感 ID 兼容入口；
  token 只接受比赛隔离 cookie 或 header。
- `/admin/*` 使用两种身份：超级管理员使用 `X-Admin-Token`；比赛创建者使用
  `X-Create-User` + `X-Create-Token`，且只能访问 `created_by` 与该用户名一致的
  `/admin/t/:tid/*` 路由。比赛专有 admin token 已取消，旧 token 立即失效。
- `POST /tournaments` 普通创建者必须同时使用 `X-Create-User` 与 `X-Create-Token`；
  super token 仍可直接创建。响应只返回 `tid/url/created_by`，不再生成比赛管理 token。
- 比赛关闭 token 鉴权后仍要求 pid 对应一名已报名且 active 的玩家；super token
  仍可作万能玩家 token。
- 失败统一为 `401 {ok:false, code:"AUTH_REQUIRED", fields:[...]}`；跨比赛创建者访问返回
  `403 FORBIDDEN`。创建用户 token 只存 SHA-256 哈希，无法读取旧值；删除用户或重新生成
  token 会立即撤销其全部比赛管理权限。旧比赛 `admin_token_hash` 迁移为 null，代码不再验证。

`create_users` 由 super admin 管理：`GET/POST /admin/create-users` 列表/创建，
`DELETE /admin/create-users/:username` 撤销。用户名规范化为小写，允许 1--32 位
ASCII 字母、数字、`.`、`_`、`-`；数据库只保存 token 哈希。比赛记录 `created_by`
（权限用户名或 `super-admin`）和不可变 `card_pool_id`。

### 2.2 创建参数

`POST /tournaments` 和管理员 `PUT /admin/t/:tid/config` 的业务字段包括：

```text
name, maxPlayers, mode(single|match), cardPool
packSize, packSizeMultiple(legacy), packCount, packStrategy, extraRatioPercent
dropMode(legacy), dropPublic, draftMode, evenPackCount
pickSeconds, reserveSeconds, reseatEachRound
deckbuildingSeconds(null=无限), mainMin, mainMax, extraMax, sideMax, maxCopies
timeLimit
matchFormat(round_robin|swiss|double_elimination)
swissRoundCount, playoffSize
```

默认 `packSize=24`、`pickSeconds=40`、`reserveSeconds=400`、`deckbuildingSeconds=null`、`extraRatioPercent=null`、`extraMax=30`、`sideMax=30`、
`maxCopies=1`。`cardPool` 必须是已存在的卡池名；新写入接口拒绝缺省或 `full`。
创建时默认生成 `4×玩家数` 个牌堆（卡池不足时按完整堆数减少轮数），并按人数写入推荐赛制：
3--8 人为瑞士 3 轮无淘汰（2 人因无法安排三轮不重复对手而推荐单循环），9--16 瑞士 4 轮 Top 4，17+ 瑞士
`ceil(log2(n))+1` 轮 Top 8。首场对局生成后赛制锁定。

所有写入字段都做运行时白名单、整数/布尔/枚举与交叉约束校验；当前硬上限为
32 名玩家、1000 张/堆、10000 堆、单区 250 张和 7 天计时。未知字段与 NaN/小数
等非预期数值返回 `BAD_PAYLOAD`，不会直接写入事件日志。

`extraRatioPercent` 为可选整数 `0--100`。非空时每堆额外卡数按实际堆大小四舍五入，
主卡/额外卡分别随机取出后合并混洗，并覆盖 `packStrategy`；最后短堆按实际大小计算。
资源不足时 `start_draft` 返回 HTTP 400 的 `INSUFFICIENT_PACK_RATIO`，详情包含
`requiredMain/availableMain/requiredExtra/availableExtra`，不会产生牌堆或阶段事件。
传入 `null`（或旧比赛缺少字段）表示沿用 `packStrategy`。

### 2.3 玩家端点

| 方法/路径 | 说明 |
| --- | --- |
| `GET /health` | 公共健康检查 |
| `GET /tournaments` | 公共比赛简表 |
| `GET /pools` | 公共卡池名称/数量/`isDefault` 和合法池的 `url`，不含 code |
| `GET /pools/:name` | 公共卡池元数据与 exact code 列表，并返回 `candidateCount/candidateUrl`；name 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |
| `GET /pools/:name/cards?q=&codes=` | 公共卡牌元数据、卡池内状态和该池 exact-code 抓位统计 |
| `GET /pools/:name/candidate` | 公开读取绑定候选池的 exact code 列表与数量 |
| `GET /pools/:name/candidate/cards?q=&codes=` | 候选池卡牌元数据；`poolStatus` 为 `not_in_pool/in_pool/in_candidate` |
| `POST /pools/:name/candidate/cards` | 需要任意有效玩家三要素；`{codes:number[]}` 只追加候选卡，不提供删除/替换 |
| `GET /meta` | 公共 srvpro `host/gamePort` |
| `GET /t/:tid` | 阶段、配置摘要、玩家、`authRequired` |
| `POST /t/:tid/join` | 报名 `{player_id,display_name}`，返回一次性 token |
| `POST /t/:tid/player/name` | 报名阶段由本人修改 `{display_name}`；需要玩家身份，记录 `player_rename` 事件 |
| `POST /t/:tid/player/ready` | 报名阶段由本人设置 `{ready:true|false}`；记录 `player_ready` 事件，准备状态对所有报名玩家公开 |
| `POST /t/:tid/player/draft-confirm`（`/confirm-draft`、`/start-draft-confirm` 兼容别名） | 管理员发起开始选牌后，由本人在 60 秒内确认；最后一名玩家确认时原子生成牌堆并进入 drafting，超时则取消且不产生牌堆 |
| `POST /t/:tid/player/withdraw`（`/player/leave` 兼容别名） | 仅报名阶段由本人退出；记录 `player_remove` 事件、释放名额并清除本人报名投影；选牌开始后返回 `WRONG_PHASE` |
| `GET /t/:tid/state` | 当前玩家视角完整状态（牌堆、队列、reserve、构筑、当前对局） |
| `GET /t/:tid/pool` | 当前比赛 drop 前卡池（需玩家鉴权） |
| `GET /t/:tid/cards?q=` / `?codes=` | 卡牌元数据/效果文本搜索或批量读取；`q` 按空白拆分为 AND 关键字，无隐含 30/50 条上限，结果按卡名命中数量及关键字顺序优先 |
| `GET /t/:tid/cards/status?codes=` | drafting 按玩家视角返回 `not_in_pool/dropped/picked/seen/unknown`；deckbuilding 及之后返回全局 `not_in_pool/dropped/picked/other_picked`；返回 exact 请求 code |
| `POST /t/:tid/pick` | `{card_code,target_zone?}`，passing 队首选牌 |
| `POST /t/:tid/pick/alternative` | `{card_code}`，记录本人最后点击的候选牌，超时自动选择优先使用 |
| `POST /t/:tid/pause` | 已废弃，返回 `410 PAUSE_VOTING_REMOVED`；玩家不能暂停/投票/恢复 |
| `POST /t/:tid/deck/move` | `{card_code,from,to,index?,from_index?}`，`to=pool` 可移出构筑 |
| `POST /t/:tid/deck/sort` | YGOPro `deck_sort_lv` 逻辑，显式整理 main/extra/side |
| `POST /t/:tid/deck/shuffle` | 只随机 main 顺序，模拟洗牌 |
| `POST /t/:tid/deck/lock` / `unlock` | 校验并锁定/解锁构筑 |
| `GET /t/:tid/deck.ydk` | 下载 `cube-deck-<tid>-<pid>-<timestamp>.ydk` |
| `GET /t/:tid/matches` | 当前玩家全部对局和本桌 room info |
| `GET /t/:tid/ranking` | 公开积分/净胜局/OMW 排名 |
| `GET /t/:tid/stream` | SSE，使用按比赛隔离的身份 cookie；token 不写入 URL |
| `POST /cube/result` | srvpro webhook；需 `X-Cube-Api-Key`，幂等处理 |

小世界独立工具不属于比赛玩家接口，不需要 tournament/player/token 鉴权：

| 方法/路径 | 说明 |
| --- | --- |
| `POST /tools/small-world/calculate` | body `{deckCodes:number[],handCodes?:number[],allowSameHandTarget?:boolean}`；省略或传空手牌时扫描主卡组全部 unique 怪兽，从 `cards.cdb` 元数据计算所有合法路径 |

响应结构：

```text
{
  cards: CardInfo[],
  paths: [{handCode, bridgeCode, targetCode, handBridgeShared, bridgeTargetShared}],
  unknownCodes: number[],
  summary: {deckCount, handCount, eligibleDeckCount, eligibleHandCount, pathCount, handMode}
}
```

`handBridgeShared` 与 `bridgeTargetShared` 取 `race|attribute|level|atk|def`。
`deckCodes` 按主卡组处理；非怪兽卡和额外卡静默跳过，未知 code 返回在
`unknownCodes`。`handCodes` 省略或为空时，`handMode=deck_unique`，每个 unique 主卡组
怪兽分别扣除一张实体副本后作为候选手牌；中间卡与目标卡相同 code 时必须有至少两张
剩余实体副本。默认情况下，手牌与检索目标不能是同一个精确编号；请求
`allowSameHandTarget=true` 可显式放开这一限制，但仍遵守实体副本数量规则。提供手牌时
`handMode=provided` 并保持显式手牌语义。请求数组只接受正整数 code，选项只接受布尔值；
格式错误返回 `BAD_SMALL_WORLD_INPUT`。

`state` 的 passing 视角按当前 seat 从左到右返回 players/queueLengths；本人队首
牌面才会出现在 `pack.cards`。`cardsRemainingToDraft` 在整轮公平时是精确值，
否则标记 `cardsRemainingExact=false`。`pickAlternative` 只返回当前玩家最后点击
的候选牌编号；它不会改变牌堆，超时自动选择时若仍可用则优先选中。

### 2.4 管理端点

| 方法/路径 | 说明 |
| --- | --- |
| `POST /admin/t/:tid/start_draft` | 发起 60 秒全员确认窗口；仅所有报名玩家确认后才生成牌堆并开始选牌，重复请求在窗口内幂等 |
| `POST /admin/t/:tid/phase` | 阶段切换；进入 matches 先合规预检，确认字段为 `confirm_invalid_decks:true` |
| `PUT /admin/t/:tid/config` | 报名阶段修改配置 |
| `PUT /admin/t/:tid/match-format` | 首场前设置/修改明确赛制 |
| `POST /admin/t/:tid/matches/start` | 建立指定轮次排表并异步建 srvpro 房间 |
| `POST /admin/t/:tid/matches/advance` | 当前轮结果齐全后管理员确认下一轮 |
| `POST /admin/t/:tid/match/result` | 管理员录入/修正 0--2 局比分 |
| `GET /admin/t/:tid/events?limit=&before=` | 事件时间线分页，默认最近 1000 条；`before` 为 seq 游标 |
| `POST /admin/t/:tid/pause` / `pause/resume` | 冻结计时或结束暂停 |
| `POST /admin/t/:tid/resume` | 恢复管理员暂停；`pause/resume` 为兼容别名 |
| `POST /admin/t/:tid/security` | `{require_token:false}` 关闭该比赛 token 鉴权 |
| `GET /admin/mine/tournaments` | 创建者列出自己创建的比赛；super 可复用全局列表 |
| `GET /admin/t/:tid/pools` | 比赛创建者或 super 读取全部卡池；返回 `{pools,canEdit}`，非 super 只读 |
| `POST /admin/t/:tid/players/:pid/token` | 重设玩家 token |
| `POST /admin/t/:tid/players/:pid/reserve` | `{seconds}`：选牌阶段给指定玩家增加 reserve；事件保存余额/deadline 快照 |
| `PUT /admin/settings/default-pool` | super 设置全局默认卡池 |
| `GET/POST/PUT/DELETE /admin/pools...` | 卡池建立、编辑、随机采样、删除；删除在进行中的比赛仍引用该池时返回 `POOL_IN_USE` 及占用比赛摘要，避免后续选牌失效 |
| `GET /admin/t/:tid/events` | 事件时间线 |
| `GET /admin/t/:tid/revert/preview?seq=` | 回溯影响预览 |
| `POST /admin/t/:tid/revert` | `{seq,confirm_name}` 硬回溯并保持冻结 |
| `POST /admin/t/:tid/unfreeze` | 回溯后恢复计时/房间编排 |
| `GET /admin/create-users` | super admin 列出创建权限用户（不返回 token） |
| `POST /admin/create-users` | super admin 创建用户名并生成一次性随机 create token |
| `POST /admin/create-users/:username/token` | super admin 轮换 token；旧 token 立即失效，新明文只返回一次 |
| `DELETE /admin/create-users/:username` | super admin 立即撤销创建权限 |

卡池 `POST` 既接受 `codes:number[]`，也接受 `importText`。文本每行支持
`code` 或 `code<TAB>name`；后端以该 code 的字面原名比较，返回每一行的
`invalid`、`missing_code`、`name_mismatch`，以及 `filtered`/`missingCodes` 汇总。

### 2.5 SSE 脱敏事件

事件名为 `phase`、`pack`、`pick`、`pause`、`deck`、`match`、`notice`：

- `pick` 只含 player/auto，不含 card code；
- `pack` 的 passing 队列只含数量；
- `deck` 只含 player id；
- `match` 不广播其他桌房间名。

客户端收到事件后 refetch `/state`；倒计时使用服务器绝对 deadline 和冻结剩余值。

## 3. cube API ↔ srvpro

### 3.1 `POST /cube/create_room`

请求的关键结构：

```json
{
  "room_name": "CUBE-01a2b3c4d5e6f7",
  "request_id": "t:1:m:10:01a2b3c4d5e6f7",
  "hostinfo": {"mode": 1, "rule": 5, "lflist": -1, "duel_rule": 5,
    "start_lp": 8000, "start_hand": 5, "draw_count": 1, "time_limit": 180},
  "deck_size": {"main_min": 40, "main_max": 60, "extra_max": 30, "side_max": 30},
  "players": [{"player_id":"alice","name_vpass":"alice"}, {"player_id":"bob","name_vpass":"bob"}],
  "cube_decks": {
    "alice": {"main": [123], "side": [], "filename":"cube-deck-1-alice-20260809120000"},
    "bob": {"main": [456], "side": [], "filename":"cube-deck-1-bob-20260809120000"}
  }
}
```

`filename` 的 timestamp 取该 match 的 `startedAt`（旧状态缺失时取已锁定卡组的
`lockedAt`），由服务端在对局生成时固定。房间建立重试或玩家重新加入同一房间不得
按当前时间重新命名，以保证一场对局每名玩家只对应一个同步卡组文件。

`room_name` 是 `CUBE-` 加 14 位 base36 稳定摘要，总长 19 个 ASCII 字符，以兼容
标准协议的 `pass[20]`；match 归属由 API 按数据库中的精确值反查，webhook 不解析
其中的 tid/round/table。成功返回 `{ok:true,room_name,port}`。`room_name`/`request_id` 与规范化请求指纹共同
保证重试幂等（并发重试也等待同一宿主）；同名不同请求或 request id 复用返回 409。srvpro 会强制 `no_check_deck=true`、保存
replay，并等待宿主端口，超时返回 `ROOM_TIMEOUT`。请求体最大 1 MiB；玩家数为
2--4，字符串/卡号/hostinfo/deck size 均在建房前严格校验。

### 3.2 `GET /cube/room_status`

query `room_name`；返回 `established`、`port`、数值 `duel_stage`、登记玩家的
connected/pos、按 Cube player id 映射的 scores 和 `finished`。

### 3.3 `POST /cube/close_room`

body `{room_name}`。srvpro 调用 `room.delete()`；结果 webhook 仍会按配置发送。

### 3.4 `POST /cube/result` webhook

srvpro 发送精简的 `room_name/start/end/players/first/wins`；每个 player 只含
结算所需的 `player_id/name_vpass/score`，不携带 deck、history 或 replay。cube API
要求相同 API key，按 room name 幂等记录，成功响应 `{ack:true}`。未知 room、
非法/超界比分会拒绝或标记房间故障，不能写入异常积分；重复结果不重复结算。

## 4. srvpro ↔ ygopro

### 4.1 宿主参数

```text
1..12 传统参数
13    --cube-deck-limits
14    main_min
15    main_max
16    extra_max
17    side_max
18..  replay seed（如有）
```

显式 marker 仅 Cube 房间追加；四项必须是 `0--250` 的十进制整数且
`main_min<=main_max`，缺失或非法时宿主拒绝启动。旧的第 13--16 项纯数字布局继续
兼容。seed 解码长度必须精确，非法 seed 被忽略并记录不含 secret 的诊断。

### 4.2 `STOC_CUBE_DECK (0xA)`

消息 body 为 `uint32 main_count`（含额外）、`uint32 side_count`、code 数组，
后接可选 `uint16 filename_len + ASCII filename`。玩家 `player_id/name_vpass` 必须为
1--19 位可打印 ASCII 且不含 `$`，对应 `CTOS_PlayerInfo.name[20]` 的协议上限。安全文件名必须匹配
`cube-deck-<tid>-<pid>-<timestamp>`；客户端写 `.ydk`、选择并锁定。旧客户端
忽略新增消息，但仍可由 srvpro 开局覆盖。

### 4.3 长 JOIN_GAME

标准 48 字节消息不变。扩展包为 8 字节头 + UTF-16LE NUL 结尾密码，最长 255
个 UTF-16 code unit；srvpro 验证长度/对齐/NUL/尾部零值，失败即取消加入，不能
使用被截断的 `pass[20]`。

## 5. 卡牌元数据与错误码

`CardInfo` 字段：`code/name/type/desc/level/lscale/rscale/linkMarkers/race/`
`attribute/atk/def/alias/setCodes/setNames`。name/code 是 exact 卡表行；alias 只
用于卡组规则副本上限与合法性检查，不用于卡池、搜索、状态或详情去重。
name 的显示值优先来自 `server.card_names_json` 中的 `sc_name` → `md_name` → `jp_name` → `cn_name` → `en_name`；
若这些字段均为空或映射缺失，则回退到 exact code 对应的 CDB `texts.name` 原名。
`cn_name`、`sc_name`、`md_name`、`nwbbs_n`、`cnocg_n`、`jp_ruby`、`jp_name`、`en_name`
以及 CDB 原名均加入搜索索引。`TYPE_TOKEN`
（衍生物）记录不出现在用户搜索结果，也不能进入主卡池或候选池。
可选 `pickStats: {poolId,poolName,averagePickPosition,averagePickPercentage,packCount,
tournamentCount,sampleCount}[]` 按 exact code 返回；抓位从 1 开始，百分比按每个牌包
的实际卡数归一化（末堆按实际大小），只统计完整抽取且比赛名不以 `test` 开头的现存
卡池比赛，前端显示抓位和百分比两位小数，并显示参与统计的牌包/比赛数。统计按
`cardPoolId`，删除卡池后不再产生统计。
`CardVisibilityStatus` 为 `not_in_pool | dropped | picked | other_picked | seen | unknown`。
`seen` 只表示玩家在某次选牌前实际看到过仍存在的卡；已被前位玩家拿走的卡不会
因为同属一个牌堆而自动标记为 seen。构筑阶段的 `dropped` 表示初始排除，
`other_picked` 表示其他玩家已选。
卡池搜索另使用 `PoolMembershipStatus`：`not_in_pool` 表示主卡池和候选池均无，
`in_pool` 表示已在主卡池，`in_candidate` 表示已在候选池。每个主卡池绑定一个
`candidate_codes_json`（默认空数组），候选 code 按 exact 编号去重并保留追加顺序，
不按 alias 合并。候选新增需要 `X-Tournament-Id`、`X-Player-Id`、`X-Token`，可使用
任意比赛的 active 玩家身份；这些凭据不得出现在 URL 或请求 body。主卡池更新会在同一
事务中移除被晋升的候选 code，并返回 `candidateRemovedCodes`，候选数据不会自动进入
比赛牌堆。

常用错误：

| code | 含义 |
| --- | --- |
| `AUTH_REQUIRED` | token/admin/create-user 凭据缺失或无效 |
| `WRONG_PHASE` / `FROZEN` | 当前阶段或冻结状态不允许 |
| `BAD_DISPLAY_NAME` | 显示名称为空、过长或包含控制字符 |
| `NOT_YOUR_TURN` / `CARD_NOT_AVAILABLE` | 选牌状态冲突 |
| `DECK_INVALID` / `WRONG_ZONE` / `CARD_NOT_IN_POOL` | 构筑不合规 |
| `PACKCOUNT_NOT_MULTIPLE` | 牌堆数违反 `evenPackCount` |
| `NO_VALID_PAIRING` | 瑞士无法生成无重复对手的完整配对 |
| `PAIRING_SEARCH_LIMIT` | 瑞士回溯达到时间/节点保护上限，HTTP 503，可重试或调整赛制 |
| `RESULT_ROUND_LOCKED` | 后续轮已存在，历史赛果只能通过回溯修改 |
| `FORMAT_LOCKED` / `BAD_MATCH_FORMAT` | 赛制已锁定或参数非法 |
| `POOL_EXISTS` / `POOL_NOT_FOUND` / `BAD_POOL_IMPORT` / `BAD_POOL_NAME` / `POOL_IN_USE` | 卡池操作错误；`POOL_IN_USE.details.tournaments` 列出仍在使用该池的比赛 |
| `BAD_CREATE_USERNAME` / `CREATE_USER_EXISTS` / `CREATE_USER_NOT_FOUND` | 创建权限用户错误 |
| `INVALID_API_KEY` / `SRVPRO_ERROR` | srvpro 连接或鉴权失败 |

## 6. 配置来源

根 `config.yaml`（`CONFIG_FILE` 可覆盖）字段包括：

```yaml
admin: {super_token: "..."}
srvpro: {url: "http://127.0.0.1:7922", api_key: "...", host: "127.0.0.1", game_port: 7911}
server: {port: 3001, db_path: "data/cube.sqlite", cards_cdb: "...", card_names_json: "assets/ygocdb_cards.json", strings_conf: "...",
         allowed_origins: ["http://localhost:3000"], allow_insecure_defaults: false}
pics: {ygopro_root: "", avif_dir: "assets/pics_avif"}
```

相对路径按配置文件目录解析。`assets/` 不被 Git 追踪，卡库、脚本和卡图必须由
部署环境单独提供。

## 7. 资源发布契约

卡片资源发布不通过 REST 修改比赛状态，而由
`scripts/update-card-resources.sh` 生成 `resource-manifest.json` 并原子安装到
运行时目录。清单至少包含上游仓库/ref/commit、cards.cdb SHA-256/字节数/代码
数、script Lua 文件哈希、AVIF 文件哈希和图片归档 ETag。服务启动时只读取同一
版本的 `cards.cdb`、`strings.conf` 与 `script/`；卡图 API 仅暴露低清 AVIF，原始
`pics/` 不属于发布包。

资源发布必须在维护模式完成，远程锁和 SQLite `integrity_check` 通过后才能切换。
验收至少包括 `/api/health`、首页引用的静态 JS/CSS 状态码与 MIME、srvpro 协议
探针和宿主 `ldd`。任何校验失败都保留失败目录和备份，并恢复上一版资源；脚本不
自动恢复数据库或强制覆盖 Git 冲突。
