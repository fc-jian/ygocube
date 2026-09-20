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
  token 只接受比赛隔离 cookie 或 header。显式玩家 header 身份优先于 cookie；一旦提供
  `X-Player-Id` 或 `X-Token`，两者必须完整且配对，不从其他标签页的 cookie 补齐。
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
无当前牌堆的有效预选时，使用比赛绑定 `cardPoolId` 的 exact code 历史统计，选择未舍入的 `averagePickPercentage` 最低者；最低值并列时均匀随机。无统计的卡不优先于有统计的卡；全部无统计或未绑定有效卡池时，在剩余卡中均匀随机。串行和传堆模式一致；最终选择仍写入既有选牌事件，回放不重新抽签。

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
`attribute/atk/def/alias/aliasName/aliasKind/setCodes/setNames`。name/code 是 exact 卡表行；alias 只
用于卡组规则副本上限与合法性检查，不用于卡池、搜索、状态或详情去重。
name 的显示值优先来自 `server.card_names_json` 中的 `sc_name` → `md_name` → `jp_name` → `cn_name` → `en_name`；
若这些字段均为空或映射缺失，异画卡先尝试原版 alias 的名称映射，最后回退到 exact code 对应的 CDB `texts.name` 原名。
`aliasKind` 为 `artwork`（异画）、`rule`（规则同名）或省略（无有效 alias）。按 YGOPro 原生约定：非零且非自身 alias、编号差绝对值小于 20 为异画，但编号 5405695 始终按规则同名处理。异画继承原版映射的搜索别名；规则同名卡不继承目标卡名。异画详情显示“异画版本”，规则同名显示“规则同名”；保留各自 exact code、卡图、效果和抓位统计。
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

## 8. 网页对战协议 v1

链路为浏览器 → `/duel/ws` WebSocket（外部 `/api/duel/ws`）→ Cube API → srvpro → 现有宿主。`web_duel.enabled` 默认 false。

- `POST /t/:tid/matches/:mid/duel-session`：玩家三要素，校验本人活动对局，返回 `{version:1,ticket,expiresAt,wsPath}`；票据 30 秒有效、仅消费一次。
- `POST /public/t/:tid/matches/:mid/watch-session`：匿名只读公开观战票据，是三要素鉴权的显式例外；不返回房间口令。
- WS 首帧 `{type:"auth",version:1,ticket}`，5 秒内完成；服务端 `{type:"session",generation,role}`。之后下行二进制为单个完整 YGOPro 帧（uint16 LE 长度含 opcode，不含长度本身）。
- 公开观战加入时先下发 `{type:"snapshot",state}`（共享协议包 `DuelState`），其后按顺序应用二进制帧；不含非公开身份。
- 服务端 `{type:"prompt",id}` 给出交互代次；客户端 `{type:"action",id,opcode,data:number[]}`，仅允许 RESPONSE/HAND_RESULT/TP_RESULT/UPDATE_DECK/HS_READY/HS_NOTREADY/HS_START/SURRENDER，角色、阶段及长度必须验证，RESPONSE 为 1–256 字节。初始握手和 TIME_CONFIRM 由网关执行。断连重新申请票据，同身份新连接接管旧连接。
- 只读观众不接受任何 action；SSE 不携带任何对战卡牌内容。内部 `GET /cube/web-stream?room_name=...&view=public` 与 `GET /cube/web-replay?room_name=...` 必须验证 X-Cube-Api-Key，输出 NDJSON `{t,frame:base64}`；录像仅在 Cube 侧确认 tournament finished 后对外提供。
- `GET /public/t/:tid/matches/:mid/replay`：tournament finished 后匿名全知录像，含版本、消息、完整性标记与卡片元数据；之前返回 403。禁止缓存。新对局保存，不导入历史 yrp。
- `POST /admin/t/:tid/matches/:mid/replay/delete`：有比赛管理权的管理员清理录像，活动房间禁止清理。
- `POST /public/duel/cards {codes}`、`/public/duel/descriptions {ids}`（各最多 256 项）及 `/public/duel/declare {q,opcodes}`（文本最多 100 字、指令最多 255 项）只提供卡片数据库信息。
- 内部 `GET /cube/web-player?room_name=...&player_id=...` 使用 X-Cube-Api-Key，返回当前卡组供网关重连换备恢复；不对浏览器开放。录像响应包含归档时卡片文本、效果描述、消息时间与状态快照；不使用当前资源替换历史文本。

录像使用 srvpro 私有追加日志，与公开流分文件保存；故障标记 incomplete。比赛回溯撤销现有会话并关闭后续录像访问；已下载的文件无法撤回。所有旧二进制协议结构保持不变。

### 8.1 独立网页房间

`/duel` 和 `/duel/decks` 不依赖比赛身份。以下是匿名入口的明确例外，仍受 Origin、输入大小和连接上限约束：

- `GET /public/duel/search?q=...`：全卡库搜索（最多 100 字查询），排除衍生物，返回最多 100 项元数据。
- `GET /public/duel/options`：返回 srvpro 当前禁限卡表索引与名称。
- `POST /public/duel/join`：`{name,password,options,deck:{main,extra,side}}`，选项字段为 `mode(0单局/1比赛),lflist,rule,duelRule,timeLimit,startLp,startHand,drawCount,mainMin,mainMax,extraMax,sideMax,noCheck,noShuffle`。密码映射同一个内部房间，首位创建者决定规则；后续加入返回已有规则。返回 `{credential,room,options}`；短期 credential 仅保存当前标签页，用于刷新重连，不能用于 Cube 身份。
- `POST /public/duel/session {credential}`：换取现有单次 WS 票据。后续操作沿用 §8，卡组由网关上传，房主/准备状态由原生宿主决定。
- 私有 `GET /cube/standalone-options`、`POST /cube/standalone-room {room_name,hostinfo}`：X-Cube-Api-Key 鉴权，通过同一个 srvpro Room 构造器创建普通房间，不绑定 Cube 卡组与结果。
- 所有上传与保存的卡组放在浏览器会话 cookie（Path=/duel、SameSite=Strict）；按卡组独立编码，最多 8 副，每副最多 3 KiB、合计最多约 7 KiB。写入失败必须显示错误，不伪报保存成功。页面提供随时查看、编辑、导出和删除。关闭浏览器后是否保留取决于浏览器会话恢复设置。

### 8.2 独立测试部署隔离

独立 Web 可构建 `NEXT_PUBLIC_API_BASE=/duel-api` 与 `NEXT_ASSET_PREFIX=/duel-assets`；默认分别仍为 `/api` 与无前缀，旧 Cube 不变。独立 API 的 `server.host`、srvpro 的 `bind_address` 可指定 `127.0.0.1`，未指定时保持原监听行为。公网仅开放 `/duel`、`/duel/*`、专用静态资源、公开独立对战 API、卡图及 WSS；不开放该实例的 Cube 管理/比赛 API。现有 Cube 继续使用原房间流程和原生客户端。

### 8.3 房间 URL、重连与公开观战

房间 URL 为 `/duel/room/:room`，`:room` 沿用房间密码的服务端 HMAC（`W` 加 18 位十六进制）。链接是房间访问凭据，与密码等价；页面提示仅向参与者分享。

- `POST /public/duel/resolve {password}` 与 `GET /public/duel/rooms/:room` 返回已有房间的 `{room,url,options,players:[{id,connected}],finished}`，不包含私有昵称后缀、卡组或会话凭据。
- `POST /public/duel/join` 增加可替代 password 的 `room`；`reconnect:true` 时凭房间链接和已登记 `name` 恢复原卡组与席位，不重新上传卡组。正在连接的 ID 仅可用相同 credential 接管，否则拒绝 `PLAYER_CONNECTED`，避免观战者误踢玩家。重复 ID 的普通加入返回 `PLAYER_ID_EXISTS`。
- `POST /public/duel/watch {room}` 返回只读会话凭据。WSS 下行仅转发 srvpro 的公开观战帧，过滤原生录像与卡组推送，任何上行 action 均断开。支持中途观战；依赖 srvpro `cloud_replay.enable_halfway_watch`。
- 独立玩家初始/换备卡组和内部重连凭据保存在独立数据库 `standalone_duel_players`，24 小时过期。该表不进入 Cube SSE 或任何公开元数据。

### 8.4 场地区域选择

MSG_SELECT_PLACE / MSG_SELECT_DISFIELD 的可选区域直接映射到场地按钮，不在侧栏列选项。掩码低 16 位为选择者、高 16 位为对手；响应仍为实际 controller/location/sequence 三元组。单区域点击立即提交，多区域可反选，选满自动提交；count=0 提供取消。共享额外怪兽区的双方镜像坐标共用一个点击目标，观战/回放不提供操作。

### 8.5 协议与界面修正

MSG_CONFIRM_CARDS(31) 布局为 player、skip_panel、count、count 个 code/controller/location/sequence，不能与 DECKTOP/EXTRATOP 共用头部。换备界面按卡片类型拆分主卡组、额外卡组、备选卡组，发送时 main 仍合并主卡与额外，保持原生协议。场地中央阶段按钮只发送宿主当次允许的 battle/main2/end 动作。网页仅提供中文界面。srvpro reconnect.wait_time 默认及部署配置统一为 1800000 毫秒，网页/原生客户端使用同一断线恢复策略。

### 8.6 卡片交互与展示

诱发确认按原生 SELECT_EFFECTYN 的描述 ID 进行格式化：200/221 使用区域与卡名，95/96/97/218/219/220 使用卡名；缺少参数时显示中文兜底，不显示 printf 占位符。详情动作绑定 controller/location/sequence/sub 对应的具体卡片，不聚合同名卡。动画仅消费已收到的连锁消息，不延迟或生成协议响应，不增加可见卡片信息。场地使用七列等宽网格；额外怪兽区占第三、第五列，对齐主怪兽区第二、第四格。

### 8.7 独立房间保活与交互规则

独立房间已连接玩家不受 srvpro 五分钟 TCP 空闲清理；WebSocket 心跳负责检测失联，比赛断连仍按 30 分钟保留。独立宿主追加 `--web-action-time` 参数启用有效响应加时：宿主确认主动指令或发动连锁响应非 RETRY 后每次增加 2 秒，选区域/对象等后续步骤不重复增加，洗手牌、取消连锁、阶段跳转及可反复选择/取消的操作不增加；旧 Cube 和传统启动参数不变。选择提示只供下一次选择消费，不能沿用到后续指令菜单。

连锁编号在对应卡片上显示，卡片悬停详情固定在右下角；换备默认仅卡图。怪兽格改为正方形，攻守卡图尺寸相同。阶段栏在场地顶部，双方半场之间只保留共享额外怪兽区。

### 8.8 场地操作入口、公开选卡与胜负展示

前端普通卡片统一尺寸并按可用视口高度布局，详情预览独立放大。command/chain 中带 ref 的操作在对应卡片/区域入口展示，不再汇总到侧栏；多选保留原始 index，允许直接点击场上目标。提示 code 为零时只能从当前视角已经可见的对应实体补全显示，禁止推测对手隐蔽区域。

MSG_CHAINING 保留当前实体 ref 与原始发动位置 originRef，并在短动画队列结束前维持视觉标记。MSG_WIN 的第二字节保存为 winReason，展示投降、基本分、无卡可抽、超时、断连及特殊胜利原因；不改变任何线协议。固定详情区属于局内布局，换备详情在模态框之上贴近卡片显示。

### 独立房间的原生客户端互通与连锁确认

- 独立 srvpro 配置 `modules.cube.web_public_url`（例如 `https://host/duel`）时，为非 Cube 房间提供网页别名：已有 `W` + 18 位十六进制名称保持不变，其余以共享 API key 对完整原生房间密码做 HMAC-SHA256，取前 18 位并加 `W`。禁用配置时不对普通原生房间启用别名；Cube 房间始终排除。
- 私有 `/cube/standalone-info`、房间状态/观战和原生 JOIN_GAME 均将别名解析到同一个实际房间。网页输入别名或原生密码均加入该房间，不复制宿主、不覆盖已建立的规则。房间页面 `nativeConnection` 返回 `{host,port,password}`；原生密码保留完整规则前缀。`modules.cube.web_native_host/port` 配置公开地址，私有 HTTP 仍绑定回环。
- 原生加入成功后的房间服务器消息给该参与者发送网页链接与密码，不向其他房间广播。独立原生入口默认使用 17911，不改变 Cube 的 7911 入口。
- 可选 SELECT_CHAIN 有候选动作时先显示居中确认；确认响应后才能选择动作，仍能取消并发送原生 `-1`。不响应直接发送 `-1` 转移优先权。强制连锁不提供跳过；默认无可用动作自动跳过。确认状态绑定服务端 prompt ID，新提示必须重新确认。

### 先行卡目录索引

卡片服务读取 `server.cards_cdb` 后，按文件名顺序加载同级 `expansions/*.cdb`，同编号后加载者覆盖，保持与 Linux 宿主一致。原始卡库不合并、不修改；搜索、卡池、候选池、卡组校验和对局元数据共用此索引。名称继续按 exact code 外部映射优先、扩展库原名兜底，衍生物仍禁止搜索及入池。每次 API 启动原子重建完整索引，移除已撤回扩展卡。低清卡图生成输入须包括已安装 expansion 的图片。对局描述 ID（code × 16 + slot）与录像效果选项文字同样按扩展库覆盖读取。搜索索引和查询均使用 NFKC，兼容全角字母及符号。

### 8.9 房间内选卡组与对局信息

- `POST /public/duel/join` 的 `deck` 改为可选，缺省为空卡组，允许先建房/加入；旧调用携带卡组仍兼容。主卡/额外按 CDB 类型重新分类，副卡保持原区。
- 独立玩家在 lobby 未准备时可通过既有 action opcode=2 更新卡组，按房间真实规则校验，返回 STOC_CUBE_DECK 和 `{type:"accepted",opcode:2,stage:"lobby"}`；准备后先取消准备。Cube 玩家不开放此路径。换备仍执行原卡总集合及 main/extra/side 数量守恒校验。
- 卡组错误保持 `INVALID_DECK` code；REST 通过 `details.reason`、WebSocket 通过 `message` 提供中文原因；数量错误含实际数目及允许范围，未知卡/衍生物包含卡号。空卡组不能准备。
- 展示/连锁历史仅记录协议已向当前视角公开的卡号；新局清空历史，换备保留上一局结果与原因。里侧除外不得向对手显示此前已知卡号。除外和额外区域显示总数(表侧数)。
- 计时以每个 TIME_LIMIT 包的接收时刻为锚点（相同数值也更新），响应确认冻结已消耗时间，后台恢复时按实际经过时间刷新，不按渲染/提示计数。
- 无头宿主在 UPDATE_DECK 后自动准备：lobby opcode=2 只在代理持久化选中卡组；点击准备 opcode=0x22 才将卡组发送到宿主。等待宿主准备状态确认期间也锁定改卡组，避免竞态；进入比赛后的重连继续发送原始卡组进行 srvpro 身份比对。

### 8.10 卡片详情与禁限提示

CardInfo 增加可选 aliasName：alias 对应 exact code 的显示卡名，查不到时为空字符串。Cube 与 Duel 构筑共用完整类型、属性、种族、等级/阶级、刻度、连接标记、字段及规则同名详情；Duel 不显示抓位统计。

GET /public/duel/options 与私有 /cube/standalone-options 的 lists 每项增加 limits（卡号到 0/1/2/3 的映射），索引与宿主加载顺序保持一致，无限制为空映射。Duel 构筑默认选日期最新的 OCG 表，允许切换，卡图左上角显示禁/限/准限；按 YGOPro 使用 alias（非零时）查表，未列出为 3。此选项只影响构筑显示，不改房间规则。

### 8.11 战斗数值与攻击日志

- 共享协议模型 `Card` 显式声明可选数字字段 `status`、`baseAtk`、`baseDef`，对应已支持的 QUERY_STATUS、QUERY_BASE_ATTACK、QUERY_BASE_DEF；缺失表示当前视角尚未收到该字段，不补零或推测。隐蔽查询清理时仍移除这些字段。
- `MSG_BATTLE(111)` 沿用原生布局：攻击者 controller/location/sequence/第四字节、int32 ATK、int32 DEF、uint8 战斗标志，随后为相同布局的目标。完整校验后只更新对应已存在卡片的 `atk` / `def`，保留有符号数值；不创建缺失卡片，不改变 `code`、`position`、基础数值或展示记录。目标 location=0 表示无卡片目标。第四字节和战斗标志仅消费，不用于推断身份、翻面或移除卡片；保留原有 `event:111:<原始负载字节>` 日志。
- `MSG_ATTACK(110)` 的日志在原三段之后追加一段：`attack:<attackerCode>:<targetCode>:<direct>`。原卡号位置不变，仍按当前视角屏蔽隐蔽卡号；`direct` 仅由消息中的目标 location 判定，0 为对卡片攻击，1 为直接攻击。因此未知里侧目标记为 `attack:<attackerCode>:0:0`，直接攻击记为 `attack:<attackerCode>:0:1`。读取旧三段日志时，缺少 direct 表示未知，不能仅凭 targetCode=0 判定直接攻击。
- 此处仅补全现有消息的模型更新与本地日志语义，不改变任何二进制线协议、WebSocket 消息封装或 API 路由。

### 8.12 墓地查看限制（CARD_QUESTION）

- `MSG_PLAYER_HINT(165)` 按原生布局读取 uint8 player、uint8 hintType、uint32 value。`CARD_QUESTION=38723936`（以 `ygopro/gframe/client_field.h` 为准）且 hintType 为 `PHINT_DESC_ADD(6)` 时，设置 `DuelState.graveLocked[player]=true`；`PHINT_DESC_REMOVE(7)` 时设为 false。重复 ADD/REMOVE 与原生一致，按布尔开关处理，不做引用计数；其他提示保留原有日志，不改变锁。
- `graveLocked?: boolean[]` 按协议玩家编号 0/1 索引，表示该玩家作为查看者受到限制，并非对应玩家的墓地被锁。受限查看者不能浏览双方墓地；前端按当前实际玩家身份读取该项，不按场地朝向判断，也不据此限制另一个未受影响的查看者。
- 初始状态、`MSG_START(4)` 和 `MSG_RELOAD_FIELD(162)` 均重置为 `[false,false]`；旧快照缺少该字段时按未锁处理，后续提示可正常恢复锁状态。此标记只约束查看入口，不删除、掩码或改写已有公开卡片、墓地内容及展示历史；仍保留 `event:165:<原始负载字节>` 日志，不改变线协议或 API 路由。


### 独立 WindBot 对战
- 机器人目录由固定版本的 `BotWrapper/bot.conf`、Executor Deck 声明与 Dialog 文件生成；`bots` 每项新增 `robot`（机器人名称）。旧 `id` 保持 Deck ID，POST `{name,bot}` 不变；页面按 robot 分组，先选机器人再选卡组。原生进程的 Name、Dialog、Deck 均取服务端目录，不能由请求传入任意参数。
- `GET /public/duel/bots` 返回 `{enabled,bots:[{id,name,description}]}`，仅配置启用的独立 Duel 实例提供机器人。
- `POST /public/duel/bot` 输入 `{name,bot}`，返回现有 standalone join 凭证、房间 URL 和规则。服务端生成随机密码，固定单局、不限禁限卡表，玩家入房后照常选卡组、准备、开始。
- 玩家成为房主后才启动机器人。机器人通过固定的本机 srvpro 地址及原生协议连接；客户端不能指定可执行文件、Host、Port 或 DeckFile。全局并发上限、创建冷却和进程超时限制由服务端负责；重连不得重复启动机器人。
- `windbot` 根配置：`enabled`（默认 false）、`executable`、`args`、`cwd`、`database`、`max_processes`（默认 4）。路径相对 config.yaml；独立 Duel 启用，Cube 保持关闭。数据库为当前正式卡及 expansion 合并的只读构建产物。
