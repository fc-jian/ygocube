# 卡库与房间数据

## 共享卡库

- `server.cards_cdb` 指向 YGOPro 主 SQLite 卡库，`datas` 和 `texts` 提供结构与效果。API 先读主库，再按文件名读取同级 `expansions/*.cdb`，后加载的同编号覆盖前者。源库只读。API 启动时通过 `CardsService` 事务重建应用库的 `cards` 缓存，游戏统一从服务读取元数据与检索结果。[卡库服务](../../../../cube/apps/api/src/cards/cards.service.ts) · [API 启动](../../../../cube/apps/api/src/main.ts)
- 卡名按精确编号读 `server.card_names_json`，优先 `sc_name`、`md_name`、`jp_name`、`cn_name`、`en_name`。缺名时仅异画可先继承原版名称映射，再回退到本编号的 CDB 名称。别名词可检索。检索与索引均做 NFKC，英文双引号内的词组按连续字串匹配。首发年取已知 OCG／TCG 最早正式发行年，未知年份在详情中显示占位。[卡库服务](../../../../cube/apps/api/src/cards/cards.service.ts) · [检索契约](../../../../dev_docs/07-protocol-api-design.md)
- 游戏按精确卡片编号发牌、猜测、预览和统计。用户可见检索与入池一律排除 `TYPE_TOKEN`。Guess 完整卡库和手建池可以包含库中有效的先行卡及不同异画。维护 Guess 的精选池或统计开局提示的字段规模时，排除九位及以上编号，异画组取最小有效编号，规则同名卡分别计数。复用 `cardAliasKind`，勿用名称相等或非零 `alias` 直接去重。字段规模从全库归并基础字段后计数，候选数量按实际房间池计算。[卡库服务](../../../../cube/apps/api/src/cards/cards.service.ts) · [提示算法](../../../../cube/apps/api/src/guess/opening-hints.ts) · [精选池维护记录](../../../../dev_docs/21-guess-default-pool-20261107.md)
- 用 `parseCardSearchParams` 和 `CardsService.searchCatalog` 复用结构化检索。先取当前入口可访问的范围，再筛选、排序、计数和分页。数值范围含端点，原始攻守的 `?` 按 0 匹配，守备范围只匹配有守备栏的卡。属性及种族各自多选任一，连接箭头须全部命中。子类型按 `非 > 与 > 或` 求值并支持括号。保留旧 `linkCountMin/linkCountMax` 请求兼容，网页通过连接值筛数目。[参数解析](../../../../cube/apps/api/src/cards/search-params.ts) · [共享子类型表达式](../../../../cube/packages/shared/src/card-search.ts)
- 卡图回退依次为玩家授权的本地 `pics/` 或 `expansions/pics/`、同源低清 AVIF、可选的只读原图代理、空白占位。Aly 的发布资源仅含压缩 AVIF。复用现有路由和卡图组件。[卡图加载](../../../../dev_docs/13-card-artwork-loading.md)

## 应用库与状态

业务状态写入 `server.db_path`。API 启动时由 `db.ts` 初始化表和兼容迁移，`better-sqlite3` 使用 WAL 与外键。小游戏在 Cube 应用库内使用游戏名前缀，卡池与 Cube 轮抽的 `card_pools` 分开。独立 Duel 有自己的应用库。新增关系、索引和迁移时从旧数据验证，保留可读的历史房间。[数据库定义](../../../../cube/apps/api/src/db.ts)

| Guess 表 | 用途 |
| --- | --- |
| `guess_rooms` | 按 `room_id` 保存阶段、最后一次写入时间和房间状态 JSON。版本号在状态里。 |
| `guess_room_events` | 按 `room_id + version` 保存追加事件，用于猜测记录和旧房间兼容。 |
| `guess_pools` | 用 ID 引用可复用卡池，成员保存精确编号。ID 0 动态引用完整卡库。 |
| `guess_round_cards` | 每个房间、轮次、卡号记录一次发牌，按池和卡号汇总公开统计。 |

房间操作从服务端读取当前状态并检查版本、阶段、身份与行动权限。追加事件、保存状态和写入已完成轮次统计在同一事务。公开统计只纳入已完成轮次，投降计一次发牌，平均猜中回合只平均成功记录，以持牌者第几次轮到自己为单位，跳过也算一次轮到自己。[房间服务](../../../../cube/apps/api/src/guess/guess.service.ts) · [卡池与统计](../../../../cube/apps/api/src/guess/guess-pools.service.ts)

## 房间边界与 Guess 维护

- 房间分享 URL 只含房间 ID。创建或加入签发房间专用 Bearer token，服务端只存哈希，浏览器按房间保存，退出或被移除后失效。Guess 的请求封装用 `identity: null` 跳过轮抽身份，房间服务自行校验 Bearer。卡池可公开浏览，创建走现有超管校验 `@Access('super-admin')` 和 `X-Admin-Token`。新游戏按实际玩法明确公开读取、玩家操作和管理员操作的边界。[Guess 控制器](../../../../cube/apps/api/src/guess/guess.controller.ts) · [前端请求](../../../../cube/apps/web/components/guess/guess-client.ts)
- Guess 玩家在轮内看到其他座位的牌，自己的答案在解出或结算前隐藏。匿名观战可见房间公开状态、各人的提示、当前选牌、已提交猜测、排名及已猜中或投降的牌。系统结算后观战仍隐藏未解牌。服务端按身份构造响应，原始房间状态、候选集合和内部事件留在服务端。房间轮询根据版本刷新，后台标签页暂停常规轮询，完成后停止轮询。未结束房间从上次成功写入起满 24 小时自动结算，读取不会重置计时。[房间服务](../../../../cube/apps/api/src/guess/guess.service.ts) · [前端轮询](../../../../cube/apps/web/components/guess/guess-client.ts)
- 每轮随机座次、首位行动玩家和发牌，同轮卡号不重复。支持单人开局及大桌，建房时的可发卡数决定容量，开轮时再次检查。猜中按人数递减计分，最后一人可投降得 0 分，房主也可将其按投降结算后开下一轮。房主可任意继续或结算，轮间允许加入、退出和房主移除成员。猜测候选与当轮开局提示同存，排除其他座位牌。服务端复核候选范围及重复猜错。细则和旧数据兼容以契约 §2.6 为准。[接口契约](../../../../dev_docs/07-protocol-api-design.md)
