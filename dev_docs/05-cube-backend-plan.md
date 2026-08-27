# 05 - cube 后端当前设计（NestJS + SQLite）

> 实现目录：`cube/apps/api`。本文描述当前代码；REST 细节和三侧字段的唯一
> 契约见 `07-protocol-api-design.md`，共享类型见
> `cube/packages/shared/src/index.ts`。

## 1. 模块与状态机

```text
src/
├── auth/          三要素、super token 与数据库创建权限用户鉴权
├── tournaments/   比赛配置、玩家、阶段状态机
├── draft/         牌堆生成、传递、计时、暂停
├── decks/         构筑移动/整理/洗牌/校验/ydk
├── matches/       排表、srvpro 房间、结果 webhook/轮询
├── cards/         cards.cdb 导入、字面卡元数据和搜索
├── pools/         卡池、默认卡池与公开浏览
├── cards/card-pick-stats.service.ts  完成比赛的 exact code 抓位统计
├── events/        append-only 日志、快照、回溯
├── realtime/      SSE 广播
└── admin.controller.ts / api.controller.ts
```

状态严格按 `registration → drafting → deckbuilding → matches → finished` 迁移。
管理员可在后台暂停或冻结；暂停投票已取消，只有超级管理员或比赛创建者可以操作；构筑默认无限时，只有显式配置
`deckbuildingSeconds` 才会自动修复并进入对战。冻结期间会记录各玩家/当前光标
剩余时间，管理员恢复后按记录恢复，不从零开始倒计时；暂停不会自动恢复。

## 2. 配置默认值与牌堆生成

`config.ts` 的默认值为：

```text
packSize=24, packSizeMultiple=3（旧配置兼容）
draftMode=passing, pickSeconds=40, reserveSeconds=400
evenPackCount=true, reseatEachRound=true
deckbuildingSeconds=null
extraRatioPercent=null（可选；每堆额外卡百分比，0--100）
mainMin=40, mainMax=60, extraMax=30, sideMax=30, maxCopies=1
timeLimit=180
```

`cardPool` 写入时必须引用已存在的 `card_pools.name`；旧配置中的 `full` 只在
读取/回放时兼容，不可由新建或编辑接口写入。

### 2.1 牌堆数与剩余卡

每堆大小可为任意正整数，公平性只由牌堆数和玩家人数决定：整轮有 n 堆时，
每名玩家在该轮获得 `packSize` 张。`packCount` 的规则如下：

- 显式值不超过 `floor(poolSize/packSize)`：建立固定数量牌堆，剩余卡随机丢弃；
- 显式值更大：按 `ceil(poolSize/packSize)` 使用全部卡池，最后一堆可以不满；
- 未显式设置：`dropMode=use_all` 使用全部卡，`drop_leftover` 丢整堆余数，
  `drop_leftover_exact` 还会向下取到人数整数倍。

新建比赛未显式设置 `packCount` 时，目标为 `4×玩家数` 堆（四轮）；若卡池不足，
按可生成的完整堆数向下减少轮数。`evenPackCount=true` 时显式非倍数直接返回
`PACKCOUNT_NOT_MULTIPLE`，自动计算向下取到最大完整轮（池子不足一整轮时保留兜底堆）。`dropPublic` 决定被丢弃
编号是否写入公开状态；默认不公开。`packStrategy` 为：

- `stratify`（默认）：main/extra 按整体比例分层到各堆；
- `random`：全池随机切堆；
- `main_then_extra`：先放完主卡再放额外卡。

`extraRatioPercent` 非空时覆盖 `packStrategy`：主卡和额外卡池分别随机抽取，
每堆额外卡数为 `Math.round(actualPackSize × extraRatioPercent / 100)`，其余位置
由主卡填充，合并后再随机混洗。最后不足完整 `packSize` 的牌堆按实际大小计算。
比例允许 `0` 和 `100`；若主卡或额外卡数量不足以满足所有牌堆的目标数量，
`start_draft` 返回 `INSUFFICIENT_PACK_RATIO` 及需求/可用数量，且不会写入牌堆或
阶段事件。比例为空时维持上述三种旧策略和旧的按池比例弃牌逻辑。

passing 模式按轮发堆，每个玩家有 FIFO 队列；队首堆选一张后顺时针传递，整轮
全部清空才发下一轮。每个玩家自己的 deadline = 基础 40 秒 + 尚未使用的
reserve；超出基础时间只扣 reserve，reserve 耗尽后才自动随机选，事件记录
`auto=true`。玩家点击牌查看详情时会记录本人当前堆的最后一张候选牌；超时
自动选牌优先使用仍在堆中的候选牌，候选牌仅对本人可见。管理员可通过
`POST /admin/t/:tid/players/:pid/reserve` 增加指定玩家的 reserve，事件同时保存
余额、deadline 和冻结快照，保证回放/回溯一致。`reseatEachRound` 开启时会记录
`seat_assign` 事件再发下一轮。

`serial` 是旧的全局光标模式，仅用于兼容旧事件回放；新建页面默认不暴露该选项。

牌堆 `order` 只保存抽牌/传递事实，不保存前端显示排序。Web 端对当前可见牌堆
按 YGOPro `deck_sort_lv` comparator 整理，不能改变服务器选牌顺序或回放结果。

### 2.2 选牌可见性

`GET /t/:tid/cards/status` 在 drafting 阶段的 `seen` 集合由事件顺序重建：玩家每次
选牌前看到该时刻牌堆内全部剩余卡；passing 只额外加入当前队首牌堆，serial 只加入
当前光标牌堆。已被前位玩家选走的卡不算后来玩家见过；私有初始弃牌保持 `unknown`，
公开弃牌为 `dropped`。进入 deckbuilding（以及其后的对战查看）后，接口切换为全局
真实状态，返回 `not_in_pool`、`dropped`（初始排除）、`picked`（本人已选）或
`other_picked`（其他玩家已选），不再按玩家是否看过判定。初始排除由卡池与生成牌堆
的差集推导，因此即使 `dropPublic=false` 也能正确标注。返回的 `code` 始终是请求的
exact code，不做 alias 替换。

报名阶段玩家可调用 `POST /t/:tid/player/withdraw`（`/player/leave` 为兼容别名）退出。
接口使用当前玩家三要素鉴权，只允许 `registration` 阶段；服务端以
`player_remove` 事件原子地停用报名记录、清理空的牌组/选牌投影并释放名额，因此同一
玩家 ID 后续可以重新报名。选牌开始后退出返回 `WRONG_PHASE`，管理员仍可按既有
`withdraw` 流程处理进行中的退赛。

## 3. 构筑与合规修复

`DecksService` 保存三区有序数组，支持：

- `deck/move`：三区拖动、区内插入、移回 pool；main/extra 类型严格校验；
- `deck/sort`：一次性按 YGOPro `DataManager::deck_sort_lv` 等价逻辑整理
  main/extra/side，不自动触发，整理后仍可手动拖动；
- `deck/shuffle`：只随机 main 的持久化顺序，用来模拟洗牌/抽卡；
- `deck/lock`、`unlock` 和 `.ydk` 导出。

校验规则：

1. main 在 `mainMin..mainMax`，extra≤`extraMax`，side≤`sideMax`；
2. main 不能放额外卡，extra 只能放额外卡，side 可放两类；
3. 卡片必须被本人选到过；三区中的 exact code 会按 `datas.alias` 解析出的 rules
   identity 合并统计，不超过 `maxCopies`。因此 `maxCopies>1` 时可从“未使用”区
   复制到许可数量，但不能凭空新增编号；alias 相关的 exact code 仍可同时存在于卡池。

选牌结束进入构筑时，所有尚未使用的已选卡会按 cards.cdb 类型自动放入 main
或 extra；构筑阶段再移回 pool 的卡不会出现在服务器同步 deck 中，也不会写入
对战房间的 `cube_decks`。

显式构筑时限到期会对每名未退赛玩家执行 `repairForMatches`：随机剔除未获许可
或超限卡，优先把溢出的卡移到仍有容量的 side，side 也满则回到未使用池；
main 仍低于下限的玩家记录 `player_dsq` 并从后续排表排除。

管理员手动从 deckbuilding 进入 matches 时，接口先返回所有不合规报告；除非携带
`confirm_invalid_decks:true`，否则不改变阶段。确认后执行相同的随机修复和 DSQ。

## 4. 卡片与卡池

`CardsService` 从配置的 `server.cards_cdb` 导入 `datas/texts`：保留字面原名、
效果文本、类型、种族、属性、攻守、等级/刻度、Link 标记、字段 code/name 等字段。
卡池、搜索、选牌状态和详情均使用 exact code；`alias` 只在卡组规则副本上限与
合法性检查中作为 rules identity。卡池导入的名称校验使用 `getLiteral(code)` 的
原始 `texts.name`，不会把“规则上视作”的别名名称当成字面名称。

卡池创建/编辑支持：

- `codes: number[]`；
- `importText`：每行 `code` 或 `code<TAB>name`；
- 每行报告 `invalid`、`missing_code`、`name_mismatch`；所有警告都返回给前端；
- token 卡会在落库时过滤并去重 exact code；alias 相关卡不会合并，随机卡池从 exact
  code 全卡表采样。

卡池默认值存于 `app_settings.default_pool_id`，仅 super admin 可读写；创建页
公开只返回名称和数量，不泄露 code 列表。

卡池名称必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；新建和随机采样遇到空格、
斜杠、查询/控制字符或超长名称返回 `BAD_POOL_NAME`。合法卡池可通过公共
`GET /pools/:name` 与 `GET /pools/:name/cards?q=&codes=` 只读浏览，响应始终保留
exact code；历史非法名称不自动改名，也不生成公开链接。卡池列表 `/pools` 和
管理台列表提供合法池的 `/pool/:name` 链接，Web 公开页复用报名阶段的主卡/额外卡、
搜索、详情和滚动布局。

每张卡的 `pickStats` 按卡池 ID（不是名称）派生：只扫描名称不以 `test` 开头、
牌堆中每张卡都完成抽取的比赛；位置为 `pick.round + 1`，百分比为该位置除以
对应牌包的实际卡数（末堆也按实际大小）再乘 100，alias 不合并，初始弃牌和未进入
牌堆的卡没有样本。每条统计同时返回原始平均抓位、平均抓位百分比、参与统计的牌包数、
比赛数和抓牌样本数。卡池删除后不再统计，旧比赛没有 `cardPoolId` 也不计入。
`CardPickStatsService` 直接读取目标卡池相关比赛的 `packs_created/pick` 事件，
不再为历史比赛填充完整状态缓存；以该池事件最大序号、比赛更新时间和 exact code
内容作为缓存版本，完成比赛、回溯或卡池编辑后下一次读取自动重建。派生缓存最多
保留 32 个池；平均值由前端固定显示两位小数。

删除卡池时在同一事务内检查仍处于进行中且引用该池的比赛（包括仅在历史
`config_json` 保存池名的比赛）；若存在则返回 `POOL_IN_USE` 及比赛 id、名称和阶段摘要，
避免删除后未来选牌无法启动。比赛全部结束后删除会同时清理 `default_pool_id` 设置。

## 5. 排表、srvpro 与结果

`MatchesService` 保存 `CompetitionState`（格式、seed、单循环计划、双败损失），
并在首场生成时锁定格式。瑞士排表使用回溯求解整轮匹配，所有历史对手都是硬
排除；无完整解返回 `NO_VALID_PAIRING`，不使用重复对手兜底。积分为胜 3、平 1、
负 0，排序依次考虑净胜局、OMW、历史对手积分。

每桌调用 srvpro `/cube/create_room`，房间名为 19 字符的
`CUBE-<14位base36稳定摘要>`，适配标准 `CTOS_JoinGame.pass[20]`；webhook 通过
数据库内的精确 room name 反查 match，不解析外部字符串中的比赛编号。同一 match
的 room name 与 `request_id` 在重试时保持一致。deck payload 包含 main+extra、
side 和 `cube-deck-<tid>-<pid>-<timestamp>` 文件名。timestamp 在该桌对局生成时
写入 match 的 `startedAt`，重试建房、玩家重新加入同一房间都复用它，不按每次请求
重新生成，避免同一场比赛产生多个卡组文件；旧回放缺失时回退到卡组 `lockedAt`。
房间信息通过玩家状态接口
返回，玩家端再用 `/meta` 显示 srvpro host/game port；当前协议不另设密码字段。

结果有两条路径：srvpro webhook `POST /cube/result`（`X-Cube-Api-Key`，幂等）
优先，10 秒轮询 `/cube/room_status` 兜底。管理员可手动录入结果并确认下一轮；
当前轮结果齐全不会绕过管理员确认自动生成下一轮。

## 6. 事件、快照与回溯

比赛状态由 append-only `events` 驱动；内存状态和重启回放使用同一 `apply()`。
单个同步命令通过 SQLite transaction 原子更新事件和 SQL 投影，事务失败会恢复
此前缓存，SSE hook 和快照只在 commit 后执行，避免客户端看到已回滚状态。状态
缓存是最多 64 场比赛的 LRU；Nest 销毁时清理 draft/deckbuilding timer、
match poller 与 SSE 连接，避免热重载/重复 provider 造成后台任务累积。
每 100 条事件或管理员需要时写 `tournament_snapshots`，快照以 `event_seq` 标记
全局事件位置。回溯流程：预览 → 冻结 → 关闭未完成 srvpro 房间 → 删除目标事件
之后的事件和投影 → 保持 frozen，管理员显式 `unfreeze` 后才恢复计时/建房。

## 7. SQLite 结构（实际字段摘要）

```text
tournaments(id, name, config_json, created_by, card_pool_id, status, round,
            admin_token_hash(legacy-null), auth_required, frozen, created_at, updated_at)
tournament_players(id, tournament_id, player_id, display_name, token_hash,
                   seat, eliminated, withdrawn, active, joined_at)
packs(id, tournament_id, index, size, drop_card_code, order_json)
picks(id, tournament_id, player_id, pack_index, pick_round, card_code,
      auto_picked, picked_at)
decks(id, tournament_id, player_id, main_json, extra_json, side_json,
      locked_at, status)
matches(id, tournament_id, round, player_a, player_b, table_no, room_name,
        player_a_pass, player_b_pass, result_a, result_b, source, faulted_at,
        started_at, finished_at, stage, bracket_round, bracket_match_id)
events(seq, tournament_id, entity, action, payload_json, created_at, actor)
tournament_snapshots(id, tournament_id, seq, event_seq, state_json, created_at)
cards(code, name, type, desc, level, lscale, rscale, link_markers, race,
      attribute, atk, def, alias, setcodes_json, setnames_json, search_text,
      metadata_version)
card_pools(id, name, codes_json, created_at)
admin_actions(id, tournament_id, actor, action, detail_json, created_at)
app_settings(key, value, updated_at)
create_users(id, username, token_hash, created_at, active)
```

比赛管理 token 已取消；迁移清空旧 `admin_token_hash`，代码不再验证该字段，仅保留
nullable 列兼容旧 SQLite。创建用户 token 只存 SHA-256 哈希；比较时使用恒定时间摘要比较。
删除用户或重新生成 token 会立即撤销其全部比赛管理权限。卡图不入库。数据库路径
默认 `data/cube.sqlite`，启动时启用 WAL、busy timeout 和必要索引；新库强制
`matches(tournament_id,round,table_no)` 唯一，旧库若有重复会记录诊断并继续启动，
由管理员先修复数据再补唯一索引。

## 8. 配置安全

根 `config.yaml` 字段：`admin.super_token`、
`srvpro.url/api_key/host/game_port`、`server.port/db_path/cards_cdb/strings_conf`
和精确的 `server.allowed_origins`，以及可选的 `pics.ygopro_root/avif_dir`。
创建 token 不再来自配置文件；super admin 通过 `/admin/create-users` 创建/删除
数据库权限用户。用户名规范化为小写并限制为 1--32 位 ASCII 字母、数字、`.`、`_`、`-`，
token 只保存 SHA-256，明文只在创建/重新生成响应显示一次。创建比赛的普通请求必须
同时带 `X-Create-User` 和 `X-Create-Token`；super token 仍可直接创建。比赛保存
`created_by` 与不可变 `card_pool_id`，管理列表、状态和初始事件显示创建者。
默认拒绝占位 token 和空 srvpro API key；`allow_insecure_defaults` 只放宽本地占位
super token，不会跳过端口、API key 和精确 http(s) origin 校验。`assets/` 不属于 Git，
部署脚本必须先准备外部卡牌资源。

API 默认限制 JSON 请求体 512 KiB、表单请求体 32 KiB；卡牌搜索关键字最多 256 个
Unicode 字符、精确编号列表最多 2,000 个、单次搜索最多返回 5,000 条。按来源 IP 对
管理、比赛和公开接口分级限流，过量请求返回 `429 RATE_LIMITED`。响应统一附带
`nosniff`、`DENY`、严格 referrer、CSP；HTTPS 请求附带 HSTS。CORS 只接受精确的
`allowed_origins`，不反射任意 Origin，也不允许凭据通配符。

数据库首次执行创建者权限迁移前会在同目录保留
`<db>.pre-auth-migration.bak`；迁移异常时关闭连接、清理 WAL sidecar 并恢复该副本，
服务以失败状态退出，避免在半迁移 schema 上继续提供服务。

## 9. 验收命令

```bash
cd cube/apps/api
npm run build
npm test -- --runInBand
```

集成测试还需要运行 srvpro 和 cards.cdb；使用根目录 `scripts/e2e/` 下的探针，
不要把生成的数据库、卡图或本地 symlink 加入 Git。
