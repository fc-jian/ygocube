# 05 - cube 后端设计（NestJS + SQLite）

> 目录：`cube/apps/api`（NestJS）+ `cube/packages/shared`（共享类型/常量）。所有状态存服务器，事件日志支撑恢复与时间回溯。

## 1. 模块划分

```
apps/api/src/
├── main.ts                    # 启动：监听 3001；静态资源/健康检查
├── config/                    # env 配置（端口、srvpro 地址、api_key、默认参数）
├── auth/                      # AuthModule：三要素鉴权 + token 签发（见 07-2）
├── tournaments/               # TournamentModule：生命周期状态机
├── draft/                     # DraftModule：选牌引擎（牌堆/轮转/计时/暂停投票）
├── decks/                     # DeckModule：构筑校验 + ydk 导出 + 锁定
├── matches/                   # MatchModule：排表 + srvpro 集成 + 结果采集
├── cards/                     # CardModule：cards.cdb 导入 SQLite + 查询
├── events/                    # EventLogModule：append-only 事件日志 + 快照 + 回溯
├── realtime/                  # RealtimeModule：SSE 推送
└── admin/                     # AdminModule：管理员操作（回溯/修复/强制推进）
```

## 2. 生命周期状态机（TournamentModule）

```
registration → drafting → deckbuilding → matches → finished
   │              │            │            └── (每轮内部: scheduling → playing → reporting)
   │              │            └── 所有玩家锁定 or 超时 → matches
   │              └── 所有牌堆选完 → deckbuilding
   └── 玩家数达标 + 管理员启动 → drafting
```

- 每个阶段有进入/离开钩子：进入 matches 时生成首轮排表并调 srvpro 建全部房间；阶段推进只允许由服务器事件触发（所有玩家锁定、计时器到期、管理员强制）。
- 暂停状态：drafting 内可进入 `paused`（暂停投票通过后，当前选牌者选完牌即停）→ `resume`（发起人/管理员）。

## 3. 选牌引擎（DraftModule）

- **牌堆生成**：卡池（管理员选定的 cards.cdb 全量或自定义池）随机洗牌 → 顺序切成 N 个牌堆，每堆 size = 玩家数 × 3（可配置倍数），要求 N 也是玩家数目的倍数，如果不能整除，多余卡牌/牌堆被随机 drop，**预先公开被 drop 的卡牌列表**（配置项）。
- **圆桌轮转**：玩家座位按随机分配，从 1 号玩家开始顺时针选第一堆牌。选完后，最后选的玩家立刻连续选下一堆第一张牌，仍然顺时针进行。由于牌堆数（轮数）是玩家数的整数倍，每个玩家得到每个选牌次序的数目是相同的。
- **计时**：默认 30s/选；计时器只在轮到自己时启动；超时服务器**随机选牌**（从堆内未选牌中随机），事件日志记录 `auto_pick`。
- **信息隐藏**：非自己的轮次不返回牌堆内容，只返回剩余数量（与 UI 约定见 06）。
- **暂停投票**：任意玩家可发起暂停（≤5 分钟，可配置）；全员投票过半通过 → 当前选牌者完成本次选择后进入 paused；发起人/管理员可立即结束暂停，**暂停到期自动恢复**；暂停期间计时器冻结。
- 选牌记录：`picks` 表（tournament_id, player_id, pack_index, pick_round, card_code, auto_picked, picked_at）。

## 4. 构筑校验（DeckModule）

- 校验规则（服务器权威）：main 40~60、extra ≤15、side ≤15（默认，均可配置）；main 只能主卡组类型、extra 只能额外类型（按卡类型判定）、side 两者皆可；单卡最多重复次数（`maxCopies`，默认 3，可配置）；**卡组必须是已选卡的子集**（`deck/move from=pool` 同样校验卡属于本人已选卡，防绕过选牌）。
- **锁定/解锁**：锁定后服务器校验；时限（整阶段倒计时）到达自动锁定，不合格则**随机填补/删除** 至满足限制（事件日志记录自动修正明细）。
- ydk 导出：`GET /t/:id/player/:pid/deck.ydk`（鉴权后返回，格式 `#main` / `!side`，供玩家导入 ygopro 客户端）。
- 数据来源：cards.cdb 导入 SQLite（cards 表：id/code、名称、类型位、效果文本、atk/def/level 等；文本含中/英）。

## 5. 排表与对局（MatchModule）

- **排表规则**（默认，来自 guide）：
  - 3~5 人：单循环；
  - 6~8 人：4 轮瑞士轮直决；
  - 9~16 人：4 轮瑞士轮 → 前 4 强单败淘汰（半决赛/决赛）；
  - 17+：标准瑞士轮（轮数 = ceil(log2 N) + 1 之类的标准规则，实现时取标准公式）+ 前 8 淘汰赛。
  - Match 模式（BO3，含换 side）或 Single（BO1），报名时确定。
- **每轮流程**：
  1. `scheduling`：按当前积分排对阵（瑞士轮：积分相同优先、避免重复交手；单循环：轮转法）；
  2. `playing`：为每个对阵调 srvpro `/cube/create_room`（密码随机、deck_size 参数、cube_decks=双方固定卡组、cube_mode）；把服务器地址+端口+密码通知双方（前端展示 + SSE）；
  3. `reporting`：结果采集双通道——srvpro webhook POST 到本服务（主）+ 轮询 `/cube/room_status`（兜底）；必要时支持玩家上报与管理员仲裁（配置项，默认以 srvpro 数据为准）；
  4. 全部对阵结束 → 更新积分 → 下一轮或进入淘汰赛/结束。
- 瑞士轮积分：胜 3 平 1 负 0；Tiebreaker 依次为：净胜局数（2:1=1、2:0=2、轮空=0）→ OMW%（对手胜率）→ 历史对手总积分。
- 轮数：3~5 人单循环（n-1 轮）；6~16 人 4 轮瑞士轮（9~16 人后接前 4 强单败淘汰）；17+ 标准瑞士轮（ceil(log2N)+1 轮）后接前 8 淘汰赛；**季后赛种子按积分+净胜局取**（非最后一轮胜者）。

## 6. srvpro 集成（SrvproClient）

- `apps/api/src/matches/srvpro.client.ts`：封装 04 文档的 `/cube/*` API（axios + api_key；重试/超时策略）。
- 端到端契约（请求/响应/错误码）见 07-protocol-api-design.md §3；**契约先定义，双方并行开发**（shared 包 + dev_docs 为准）。
- 对局轮询任务：每 10~15s 扫 playing 中且未收到 webhook 的对阵，调 room_status；超时（整场超时阈值）进入异常处理（管理员介入/判负，事件日志记录）。

## 7. 事件日志与恢复（EventLogModule）

- **events 表**（append-only）：`(seq, tournament_id, entity, action, payload_json, created_at, actor)`；所有变更先写日志再执行（或同事务）。
- **快照**：每 N 条事件或阶段切换时写 `tournament_snapshots`（全量状态 JSON）；恢复 = 最近快照 + 重放其后事件。
- **时间回溯（管理员）**：`POST /admin/t/:id/revert?seq=<n>` → 生成当前状态副本（存档）→ 用 seq 处状态重建（快照+重放）→ 存档保留可回退。回溯期间标记 tournament 为 `admin-frozen`，禁止玩家操作。
- 选牌/构筑阶段天然适合事件回溯（无外部副作用）；对局阶段回溯需先解散相关 srvpro 房间（管理员确认后执行）。

## 8. SQLite Schema（要点）

```sql
tournaments(id, name, config_json, status, round, created_at, updated_at, admin_token_hash, auth_required)  -- 后两列由 migrate 自动补充
tournament_players(id, tournament_id, player_id, display_name, token_hash, seat, joined_at, eliminated)
packs(id, tournament_id, index, size, drop_card_code, order_json)      -- drop 公开
picks(id, tournament_id, player_id, pack_index, pick_round, card_code, auto_picked, picked_at)
decks(id, tournament_id, player_id, main_json, extra_json, side_json, locked_at, status)
matches(id, tournament_id, round, player_a, player_b, table_no, room_name, room_status_json,
        result_a, result_b, source, started_at, finished_at)
events(seq, tournament_id, entity, action, payload_json, created_at, actor)
tournament_snapshots(id, tournament_id, seq, state_json, created_at)
cards(code PK, name, type, ...)   -- 从 cards.cdb 导入
card_pools(id, name UNIQUE, codes_json, created_at)
admin_actions(id, tournament_id, actor, action, detail_json, created_at)
```

- token 只存哈希（sha256），不存明文；token 需可"重新签发"（管理员）。
- 并发控制：单服务实例 + 事务；选牌并发热点为 `picks` 唯一约束（player_id, pack_index, pick_round）。

## 9. 统一配置 config.yaml 与鉴权模型

### 9.1 config.yaml（启动前统一配置）

- 位置：仓库根 `config.yaml`（可用 `CONFIG_FILE` 环境变量覆盖路径）；结构：

```yaml
admin:
  super_token: "..."    # 超级 admin：管理所有 tournament + 卡池
  create_token: "..."   # 创建 tournament 的鉴权 token
srvpro:
  url: "http://127.0.0.1:7922"
  api_key: ""
server:
  port: 3001
  db_path: "data/cube.sqlite"
  cards_cdb: "srvpro/ygopro/cards.cdb"   # 相对 config.yaml 所在目录解析
pics:
  ygopro_root: ""       # 前端本地卡图：指向 ygopro 根目录（含 pics/ 与 expansions/*/pics/）
```

- 后端启动时读取；相对路径（db_path/cards_cdb）以 config.yaml 所在目录为基准解析。

### 9.2 admin token 体系（三层）

| token | 来源 | 权限 |
|---|---|---|
| super token | config.yaml `admin.super_token` | 所有 tournament 管理 + 卡池维护（`/admin/pools*`） |
| create token | config.yaml `admin.create_token` | `POST /tournaments` 创建（super token 亦可） |
| per-tournament admin token | 创建时返回（`admin_token`，仅存哈希） | 仅管理该 tournament（`/admin/t/:tid/*`） |

- `POST /tournaments` 响应新增 `admin_token`；`tournaments` 表新增 `admin_token_hash`、`auth_required` 列（migrate 自动补充）。
- 玩家侧鉴权不变（三要素），但 `auth_required=false` 时可跳过 token 校验（见 9.4）。

### 9.3 卡池（card pools，超级 admin 维护）

- `card_pools` 表（name 唯一，codes_json）。
- 端点：`GET /admin/pools`、`POST /admin/pools`（body: name + codes 数组）、`POST /admin/pools/random`（name + size，默认 1000，从全卡表随机采样去重）、`DELETE /admin/pools/:id`。
- 文本格式：每个 code 一行（或逗号/空白分隔），前端 textarea 粘贴后由 `POST /admin/pools` 解析。
- tournament 创建时 `cardPool` 字段：**必须为已存在的卡池名**；不再支持 `'full'`（创建与 `PUT /admin/t/:tid/config` 更新都会拒绝 `'full'`/缺省/不存在的池名；存量含 `'full'` 的旧配置由 `PoolsService.resolve` 兼容解析为全卡表）。选牌引擎从该卡池取牌。

### 9.4 按 tournament 关闭 token 鉴权

- `POST /admin/t/:tid/security {require_token: false}`（super 或该 tournament 的 admin token）。
- 关闭后玩家端点只校验 `tournamentId + playerId`（token 可缺），便于同机多用户测试；`auth_required` 存 tournaments 表，由 AuthGuard 实时读取。

### 9.5 卡牌搜索

- `GET /t/:tid/cards?q=<名称或code>` 与 `?codes=1,2,3`（按需批量取元数据，含 `desc` 效果文本）；前端构筑页提供搜索面板（结果可一键加入 side）。

### 9.6 选牌即时入组与效果文本

- 选牌（含超时自动选）落定后，后端同时把该卡写入玩家卡组（按卡类型进 main/extra）——左侧区域立即显示已选卡（含自动选）。
- cards 表从 cards.cdb 的 `texts.desc` 导入**效果文本**（中文）；`GET /t/:tid/cards` 返回 `desc` 字段，前端 hover 显示放大卡图 + 效果文本。

### 9.7 卡图：低清 avif + 原图代理（可选）

- 服务器保存**低清 avif 缩略图**（config.yaml `pics.avif_dir`，默认 `assets/pics_avif/`，由 `vips thumbnail <jpg> '<code>.avif[Q=30,effort=9,subsample-mode=on,strip]' 200 --size=down` 批量生成）；提供 `GET /pics/:code.avif`（不存在 404）。
- config.yaml `pics.ygopro_root` 指向服务端本地 ygopro 根目录（部署布局 `srvpro/ygopro`，含 `pics/` 与 `expansions/*/pics/`）。
- 设置后 cube 提供 `GET /pics/:code` 只读代理（依次尝试 `<root>/pics/`、`<root>/expansions/pics/`、`<root>/expansions/<pack>/pics/`），**原图不落盘不入库**；未设置时 404。前端 fallback 顺序：本地 → avif → 原图代理 → 空白卡。

## 10. 验收标准

1. 报名 → 生成 URL → 多人报名 → 启动选牌全流程可在无 UI 的情况下用 API 驱动跑通（集成测试脚本）。
2. 模拟选牌超时 → 自动随机选牌；暂停投票通过/驳回；发起人提前结束暂停。
3. 构筑锁定校验拒绝 39 张/61 张/16 张额外/重复 4 张；超时自动补/删到合法并记日志。
4. 对局阶段：srvpro mock（契约测试）下排表/建房/结果采集/下一轮全链路正确；webhook 丢失时轮询兜底生效。
5. 随机 kill 服务进程 → 重启后从快照+事件恢复，状态与崩溃前一致；管理员回溯到历史 seq 后仍可继续（对局阶段需先清理房间）。
