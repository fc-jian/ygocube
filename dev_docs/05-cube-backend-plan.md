# 05 - cube 后端当前设计（NestJS + SQLite）

> 实现目录：`cube/apps/api`。本文描述当前代码；REST 细节和三侧字段的唯一
> 契约见 `07-protocol-api-design.md`，共享类型见
> `cube/packages/shared/src/index.ts`。

## 1. 模块与状态机

```text
src/
├── auth/          三要素、admin/create token 鉴权
├── tournaments/   比赛配置、玩家、阶段状态机
├── draft/         牌堆生成、传递、计时、暂停
├── decks/         构筑移动/整理/洗牌/校验/ydk
├── matches/       排表、srvpro 房间、结果 webhook/轮询
├── cards/         cards.cdb 导入、字面卡元数据和搜索
├── pools/         卡池与默认卡池
├── events/        append-only 日志、快照、回溯
├── realtime/      SSE 广播
└── admin.controller.ts / api.controller.ts
```

状态严格按 `registration → drafting → deckbuilding → matches → finished` 迁移。
管理员可在选牌/构筑阶段暂停或冻结；构筑默认无限时，只有显式配置
`deckbuildingSeconds` 才会自动修复并进入对战。冻结期间会记录各玩家/当前光标
剩余时间，解冻后按记录恢复，不从零开始倒计时。

## 2. 配置默认值与牌堆生成

`config.ts` 的默认值为：

```text
packSize=24, packSizeMultiple=3（旧配置兼容）
draftMode=passing, pickSeconds=40, reserveSeconds=400
evenPackCount=true, reseatEachRound=true
deckbuildingSeconds=null
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

passing 模式按轮发堆，每个玩家有 FIFO 队列；队首堆选一张后顺时针传递，整轮
全部清空才发下一轮。每个玩家自己的 deadline = 基础 40 秒 + 尚未使用的
reserve；超出基础时间只扣 reserve，reserve 耗尽后才自动随机选，事件记录
`auto=true`。玩家点击牌查看详情时会记录本人当前堆的最后一张候选牌；超时
自动选牌优先使用仍在堆中的候选牌，候选牌仅对本人可见。管理员可通过
`POST /admin/t/:tid/players/:pid/reserve` 增加指定玩家的 reserve，事件同时保存
余额、deadline 和暂停快照，保证回放/回溯一致。`reseatEachRound` 开启时会记录
`seat_assign` 事件再发下一轮。

`serial` 是旧的全局光标模式，仅用于兼容旧事件回放；新建页面默认不暴露该选项。

牌堆 `order` 只保存抽牌/传递事实，不保存前端显示排序。Web 端对当前可见牌堆
按 YGOPro `deck_sort_lv` comparator 整理，不能改变服务器选牌顺序或回放结果。

### 2.2 选牌可见性

`GET /t/:tid/cards/status` 的 `seen` 集合由事件顺序重建：玩家每次选牌前看到
该时刻牌堆内全部剩余卡；passing 只额外加入当前队首牌堆，serial 只加入当前光标
牌堆。已被前位玩家选走的卡不算后来玩家见过；私有初始弃牌保持 `unknown`，公开
弃牌为 `dropped`。返回的 `code` 始终是请求的 exact code，不做 alias 替换。

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

## 5. 排表、srvpro 与结果

`MatchesService` 保存 `CompetitionState`（格式、seed、单循环计划、双败损失），
并在首场生成时锁定格式。瑞士排表使用回溯求解整轮匹配，所有历史对手都是硬
排除；无完整解返回 `NO_VALID_PAIRING`，不使用重复对手兜底。积分为胜 3、平 1、
负 0，排序依次考虑净胜局、OMW、历史对手积分。

每桌调用 srvpro `/cube/create_room`，房间名为
`CUBE-<tid>-<round>-<table>-<random-word>`；deck payload 包含 main+extra、
side 和 `cube-deck-<tid>-<pid>-<timestamp>` 文件名。房间信息通过玩家状态接口
返回，玩家端再用 `/meta` 显示 srvpro host/game port；当前协议不另设密码字段。

结果有两条路径：srvpro webhook `POST /cube/result`（`X-Cube-Api-Key`，幂等）
优先，10 秒轮询 `/cube/room_status` 兜底。管理员可手动录入结果并确认下一轮；
当前轮结果齐全不会绕过管理员确认自动生成下一轮。

## 6. 事件、快照与回溯

比赛状态由 append-only `events` 驱动；内存状态和重启回放使用同一 `apply()`。
每 100 条事件或管理员需要时写 `tournament_snapshots`，快照以 `event_seq` 标记
全局事件位置。回溯流程：预览 → 冻结 → 关闭未完成 srvpro 房间 → 删除目标事件
之后的事件和投影 → 保持 frozen，管理员显式 `unfreeze` 后才恢复计时/建房。

## 7. SQLite 结构（实际字段摘要）

```text
tournaments(id, name, config_json, status, round, admin_token_hash,
            auth_required, frozen, created_at, updated_at)
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
```

token 只存 SHA-256 哈希；卡图不入库。数据库路径默认 `data/cube.sqlite`，启动
时启用 WAL，已有数据库通过 `db.ts:migrate()` 补充新字段。

## 8. 配置安全

根 `config.yaml` 字段：`admin.super_token`、`admin.create_token`、
`srvpro.url/api_key/host/game_port`、`server.port/db_path/cards_cdb/strings_conf`
和精确的 `server.allowed_origins`，以及可选的 `pics.ygopro_root/avif_dir`。
默认拒绝占位 token、相同 admin token 和空 srvpro API key；只有明确开启
`server.allow_insecure_defaults=true` 才允许本地临时启动。`assets/` 不属于 Git，
部署脚本必须先准备外部卡牌资源。

## 9. 验收命令

```bash
cd cube/apps/api
npm run build
npm test -- --runInBand
```

集成测试还需要运行 srvpro 和 cards.cdb；使用根目录 `scripts/e2e/` 下的探针，
不要把生成的数据库、卡图或本地 symlink 加入 Git。
