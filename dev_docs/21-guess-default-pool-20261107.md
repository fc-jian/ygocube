# Guess the Card 默认卡池（2026-11-07）

## 入选结果

默认池「常见卡牌」共有 9,398 张。筛选以主 CDB 和两个官方 Super Pre CDB 合并后的 15,170 条有效记录为基准。

| 筛选步骤 | 结果 |
| --- | --- |
| 排除 9 位先行编号和 `TYPE_TOKEN` | 排除 151 条先行卡和 265 条衍生物 |
| 合并异画 | 14,754 个编号归为 14,258 张候选卡，每组取最小合格编号 |
| 系列字段 | 检查 601 个 `setcode` 字段，505 个符合条件，其完整合格成员共 7,295 张 |
| 剩余单卡 | 另有 2,103 张符合单卡条件 |

异画采用项目已有的 YGOPro alias 规则：非零 alias 且编号差小于 20，`5405695` 例外。同一规则卡名下的独立牌保留各自编号。例如青眼白龙保留 `89631139`，其异画 `89631140` 去重；鹰身女郎 `76812113` 和鹰身女郎 1 `91932350` 均入池。

## 筛选口径

1. **系列。** 读取 `strings.conf` 中的系列与 CDB 实际使用的字段，按 YGOPro 的系列位掩码匹配成员。入选依据为同一竞技牌表包含至少两张不同的系列牌、且至少一张在主牌组或额外牌组，近期 OCG 环境报告中的主题与 CDB 成员匹配，动画角色或相关作品的代表性主题，或至少两张且至少五分之一的成员具有人气信号。满足任一条件即纳入该系列的全部合格成员。
2. **单卡。** 对其余候选逐张记录上位牌表、网站浏览和投票、通用牌标签、禁限表、动画或特色效果证据。包括特殊胜负、翻转卡组、猜拳等规则效果，以及人工核对的代表牌。浏览量门槛为样本历史浏览量的第 90 百分位（391,641）或周浏览量的第 95 百分位（2,100）且净赞至少 4。单卡可命中多种依据。

近期竞技样本是 2025–2026 年六份 Konami 官方赛事公布的 223 副牌表。历史样本是 YTD 归档里有赛事与名次、牌组张数合理、且主牌组至少十个卡名能唯一匹配 CDB 的 7,531 副牌表。OCG 主题来自 2026 年 10 月环境报告。动画标签和特色效果含人工判断；站点浏览量作为人气指标。未能唯一对应卡片编号的牌表名称单独列入审计结果。

- Konami 2026 年赛表：[Columbus](https://yugiohblog.konami.com/2026/ycs/advanced-format-main-event-top-32-deck-lists/)、[Houston](https://yugiohblog.konami.com/2026/ycs/ycs-houston-advanced-main-event-top-32-deck-lists/)、[北美 WCQ](https://yugiohblog.konami.com/2026/championships/north-america-wcq-top-32-deck-lists/)。
- Konami 2025 年赛表：[Remote Duel YCS](https://yugiohblog.konami.com/2025/ycs/2025-north-america-remote-duel-ycs-top-32-deck-lists/)、[Vancouver](https://yugiohblog.konami.com/2025/ycs/ycs-vancouver-top-32-deck-lists/)、[北美 WCQ](https://yugiohblog.konami.com/2025/championships/nawcq-top-64-deck-lists/)。
- [YTD 历史牌表归档](https://github.com/CalciumKid/YTDDecks/tree/9572fcd84f0bc6e569ad849cb9d48667b049e1b3)、[10 月 OCG 环境报告第一周](https://roadoftheking.com/ocg-2026-10-metagame-report-1/)、[第二至四周](https://roadoftheking.com/ocg-2026-10-metagame-report-2-3-4/)。
- [Konami 角色牌组目录](https://www.konami.com/yugioh/duel_links/legendarydecks/en/)、[YGOPRODeck 卡片 API](https://ygoprodeck.com/api-guide/)。

## 复核

`scripts/generate-guess-default-pool.py` 从冻结的数据快照生成排序后的精确编号及三份审计文件。原始快照、每个系列的入选情况 `fields.json`、每张候选卡的证据 `cards.jsonl`、来源摘要 `summary.json` 位于本地 `.card-resource-sync/guess-curation-20261107/`。API 在完整卡库可用时初始化一次持久化默认池，发布后可从游戏的卡池目录浏览。

## Aly 发布与验收

| 项目 | 发布值 |
| --- | --- |
| 源码 | `codex/card-resource-sync-20261107` · `64e2c376908c8bbc1494a0c06125c478646f1c61` |
| 资源发布 ID（UTC） | `20261107-144008-64e2c37` |
| Cube API/Web 发布 ID | `20261107-guess-64e2c37` |
| 独立 Duel current | `card-sync-20261107-144008-64e2c37` |
| Cube Web Build ID | `CfHMigPZXpH2UhHyzm68v` |
| 资源包 SHA256 | `1358198d2c07eee69cbb2b950fad52fee0c8732e682042ec9267bd4c91a460be` |
| 应用包 SHA256 | `febc97518fd47f376b119e029505307d8eb5f19f3b295d5b1f3be4f666aad482` |
| 远端资源清单 SHA256 | `dd2f1c3674af4411c4dc90c52cda5a3b75d63a3736ff3af0305907087658d735` |
| 远端默认池 ID / 编号数组 SHA256 | `2` / `2d639b3fa1a4696fa68f4689d77e410cc9f5a29d07ccda0e174f2174afa4caad` |

上游 YGOPro `176fc60c9bb2d3ee1d984a743647629b1503d4ca` 已包含在 Cube 的 `db1b431ff20d7aac82bda27d027c821571d7723c` 中。script 为 `b83db1cc3f512d3bec2faafb9ecf199143332be1`，ocgcore 为 `3209cd866a55e8501a0ed358d3064d9ae0ae6b30`。主库已是当前上游版本，SHA256 为 `04b1197239517ab50fb49db8450f83e920a81f5d82a83bdc8f9c7f7ed1aa8400`。本次复用已经通过实战与依赖检查的 Cube Linux 宿主，SHA256 为 `0d35af4959ef19311480eac776b1e4e1ef0894dc53e4e4efbc396a1dc40cb5fb`。

官方 Super Pre 包的 SHA256 为 `c8fea4a07bc027093937ef8631936cc695d578ab817d1566d5ae055582c733cb`。与 Aly 上一代清单相比，先行列表从 142 张增至 151 张，服务端扩展文件新增 9 个、更新 73 个。AVIF 新增 9 张，按有效卡库清单移除 37 张旧图，两实例共用的有效 AVIF 集合为 15,168 张。卡名映射新增 123 条、更新 77 条。 [官方先行列表](https://cdn02.moecube.com:444/ygopro-super-pre/data/test-release.json)。

- 发布前两次检查均为 0 个对战宿主、0 条游戏 TCP 连接和 0 轮进行中的猜牌。资源事务和 Cube 应用发布共保存三份数据库备份，完整性与外键检查全部通过。
- Windows 和 Linux 的应用测试各通过 299 项 API、68 项 Web、41 项协议测试。Linux 完成八人 Cube 模拟赛、先行卡 BO3、重连、换备和 `100268005` 发动检索。资源发布回滚夹具补齐了 Cube 单独发布分支的覆盖。
- 公网检查通过 30 个静态文件的状态和 MIME、两套 API 的 604 次先行卡编号及完整卡名搜索、302 次 AVIF 类型及摘要检查。Aly 的 Cube 建房与卡组协议探针通过 20 项，验收结束后七个服务均为 active，宿主和游戏 TCP 连接计数均为 0。
- 默认池已在 [猜牌大厅](https://39.96.220.91/games/guess) 预选。公网验收房间 `F59F6387` 完成三人一轮，验证隐藏自身卡、猜错后换人、3/2/0 分、投降揭牌、结算和统计落库。该验收轮计入默认池统计。无凭据和错误凭据均返回 401，实际 Cube super token 在 Aly 回环请求通过鉴权并进入参数校验，Windows 使用测试 token 完成了真实建池。

实际服务器清单已通过摘要校验并刷新本地基线。旧基线、公网验收日志和应用包位于 `.card-resource-sync/guess-release-20261107/`。两实例的 `backups/card-sync-20261107-144008-64e2c37/` 保存资源回滚点，Cube 的 `backups/20261107-guess-64e2c37/` 保存应用回滚点。验收后已清理远端上传归档和临时探针。工作区另有独立的未跟踪草稿 `dev_docs/16-srvpro-modern-ts-rewrite.md`。

## 常见卡牌精简版

精简版收录审阅通过的 2,145 个编号，其中 1,952 张凭竞技表现、135 张凭动画代表性、58 张凭人气入选。竞技统计基于 7,584 副上位牌表，包含 31 副日本 OCG 官方牌表。按单卡的跨赛事使用频率和年度峰值筛选，另标记八汰乌等 8 张早期赛制代表。精简版编号数组 SHA256 为 `de348cc6adc79290754a4c3630bf658dc9193e58f7efcaea5513ea8d874fe227`。

精简版使用独立的内置键 `builtin:familiar-v2`，安装后在建房表单预选。原池 `builtin:familiar-v1` 仍可选择，Aly 上原池的 ID 为 2，包含 9,398 张。两池沿用相同的九位先行编号、衍生物、异画和规则同名筛选规则。

### 精简版 Aly 发布

| 项目 | 发布值 |
| --- | --- |
| 分支与应用源码 | `codex/guess-default-shortlist` · `2f48efa0c1ee73b0b7059c402f0769e27d9e2af0` |
| Cube 应用发布 ID | `20261107-guess-shortlist-2f48efa` |
| Cube Web Build ID | `jgJ65ulO6XnASnN2-pW0h` |
| 应用包 SHA256 | `5ce263ed0a2d8c20b7737102b414d8e99ea9e02233cce1049655e347bd2b0ae5` |
| 精简版卡池 ID | `3` |
| 应用与删除备份目录 | `/opt/ygocube/backups/20261107-guess-shortlist-2f48efa/` |
| 删除前备份 SHA256 | `06aa3cb64f43b43514f436ea4f6a3f9657fd70720b73517bc5283cecb8ed19ec` |

发布前有两间已结算猜牌房，运行中的对战宿主和游戏 TCP 连接均为 0。Windows 和 Linux 应用测试通过。本地浏览器完成原池建房与精简池三人一轮结算。

备份验证通过后，从 Aly 删除早期 1 号「Aly 验收卡池 60009233」及其 3 条发牌统计。旧验收房 `C69F5F03` 的结算快照和 10 条事件保留。原池的编号快照、ID 及发布前的统计经数据库对照验证。

公网逐页核验了精简池 90 页的全部编号和摘要，卡池目录与建房选择均通过浏览器验收。旧测试池详情和卡片接口均返回 404。7 个公网页面和 31 个静态文件的状态与 MIME 校验通过，Aly 的 7 个服务均正常。验收及发布日志位于本地 `data/local-dev/guess-refinement-20261107/aly-release/`。

## 常见卡牌近年权重版

近年权重版使用独立键 `builtin:familiar-v3`，收录 2,125 张卡。以 2,566 张复核候选为基线，
在 14,258 个本地合格卡片编号中逐卡重算，新增 178 张并移出 619 张。2026 年上位牌表权重为 1，
每早一年乘 0.70，纯备牌采用折半。发行每早一年，达到同一竞技档的证据门槛增加基准值的 2.5%。
共有 7,727 副去重牌表，其中 2023 年起有 885 副。动画代表与历史禁卡按逐卡标注保护。

本版收录事务回滚 `06351147`，排除强欲之海鳝 `22123627`。排序后的编号数组 SHA256 为
`cf87870b690a446a9056cf343f162422839d1be5531f42ffbd517ab9c1cea30a`。复核数据与导入验收位于
`data/local-dev/guess-recency-20261108/`。完整卡库、原池和精简版继续作为独立卡池供建房选择。

### Aly 发布与验收

`20261108-guess-recency-35af702` 从 `codex/guess-turn-controls` 的
`35af7028fcd894f301e83d9715d583a677dc3f0f` 构建，Web Build ID 为 `YCSq4WdFOSlFzLo8imbBi`。
应用包 SHA256 为 `9216f0590e2aa518ff9789ea0729bc7c4b66e6b9bcc4c0c7438251f92459430e`。
新版为默认 4 号卡池，2 号原池和 3 号精简版保留编号、成员与统计。

Cube API 与 Web 切换前确认原生对局空闲，备份至 `/opt/ygocube/backups/20261108-guess-recency-35af702/`。
`cube.sqlite` 的 SHA256 为 `b2996e65a86fbdcb8134bef7f9ebf569bd52168f1dcfe72c1edc16cbe5d6aa1e`。
随后结算 1 个进行中房间和 2 个轮间房间。现场验证每个房间追加一条结算事件并保留原有积分，
此前的 276 条 Guess 事件、24 条发牌统计和 3 个已结算房间均与备份一致。

Windows 和 Linux 各通过 413 项自动化测试。本地浏览器验证三人完整一轮、轮间换人、
24 小时无活动结算和匿名观战的卡片可见范围。公网验证默认池全部 89 页及编号摘要，
搜索「龙」为 430 张、18 页，另检查已结算房间的匿名观战、9 个页面和 34 个静态文件。
Aly 的 7 个服务均正常，两套数据库通过完整性和外键检查。主卡库 SHA256 为
`04b1197239517ab50fb49db8450f83e920a81f5d82a83bdc8f9c7f7ed1aa8400`，
资源清单 SHA256 为 `dd2f1c3674af4411c4dc90c52cda5a3b75d63a3736ff3af0305907087658d735`。
Cube 启动时报告的 3 组历史重复桌号在发布前备份中已存在，由现有兼容逻辑处理。
本地构建、现场和公网验收日志位于 `data/local-dev/guess-recency-release/`。

## 开局提示与候选筛选 Aly 发布

`20261108-guess-hints-6c5868d` 从 `codex/guess-opening-hints` 的本地提交
`6c5868da4d9e162c4c539fcb262c23bd0aac3f51` 构建。Web Build ID 为 `XwRCB9QlxWbPr6HtcXVtB`，
应用包 SHA256 为 `cbf7a09673554a98e800d771d64e2e0e92fe81792045a0b63ddef5edbdf244fb`。

发牌后从 12 种方式混抽开局提示，所有玩家及观战者都能查看各座位的提示。玩家候选按本人提示和
其他座位已知牌过滤。猜错的牌保留在结果中并标记，重复选择或提交由 API 拒绝。
首发年代按 2026-11-08 复核快照覆盖 14,747 个卡号，当前默认池全部覆盖。

发布前确认原生宿主、游戏 TCP 连接和进行中猜牌轮次均为 0。仅切换 Cube API 与 Web。
数据库备份位于 `/opt/ygocube/backups/20261108-guess-hints-6c5868d/cube.sqlite`，SHA256 为
`95472635206e1db3dd544d97daf931d49bd8d45d4311e142b23b8f72c8c64d44`，通过完整性和外键检查。

Windows 和 Linux 各通过 415 项自动化测试。本地核对 12 种方式的全部 36 个提示组及 API 重启恢复。
公网八人房 `68F63E41` 完成提示公开、本人候选、错牌禁用、刷新、中英文界面和结算验收，写入 8 条
发牌统计。4 号默认池「20261108精选」的 2,378 个编号经公网 100 页核对，原卡池及历史房间记录经备份比对。
七项服务均正常。构建及验收日志位于 `data/local-dev/guess-opening-release/`。

## 提示说明与观战揭牌 Aly 发布

`20261108-guess-hint-details-15074ef` 从 `codex/guess-opening-hints` 的本地提交
`15074ef17677eb812d2c46a3197d770bc30c8f21` 构建。Web Build ID 为 `YqzdA3xHYZPSzlRdt1Bs8`，
应用包 SHA256 为 `df04feaceed182e038c923df28fb0224324e77a281a650ceb171d44a962c5426`。

加入攻守比较后共有 13 种开局提示。各座位的提示可悬停查看规则，中文「以上」「以下」和区间两端均含本数。
字段规模按完整卡库的非衍生物成员数计算，默认池中的无字段、小字段、中字段和大字段分别有 584、568、606、620 张。
猜测记录的卡名支持悬停和点击查看详情，投降后观战者可见答案。

在原生对局和 Guess 对局空闲时切换了 Cube API 与 Web。数据库备份位于
`/opt/ygocube/backups/20261108-guess-hint-details-15074ef/cube.sqlite`，SHA256 为
`328c41cf13df59da5d400220692cb815ce27e22e2aadb116dc5bc8c9a78284f0`。
备份和运行库通过完整性与外键检查，既有卡池和历史房间已与备份核对。

Windows 和 Linux 各通过 417 项自动化测试。公网八人房 `5F5AA85B` 完成建房、加入、候选范围与分页、
公开提示、猜错禁用、历史卡名详情、投降揭牌及一轮结算，计入 8 条发牌统计。
4 号默认池「20261108精选」的 2,378 张经公网逐页核对。七项服务均正常，页面与静态资源检查通过。
构建及验收日志位于 `data/local-dev/guess-hint-details-release/`。

## 字段去重与提示点击 Aly 发布

`20261108-guess-distinct-fields-a59578f` 从 `codex/guess-opening-hints` 的本地提交
`a59578fdc45571afa8fccc2f81a9a64627bd0341` 构建。Web Build ID 为 `jGj8JpZYEJORqZa1GjWk0`，
应用包 SHA256 为 `a77f51a91160f16ffce823fd9dcaabb2028ce4c26624af16ba50d08c53885952`。

Aly 卡库有 15,170 条卡片记录。字段统计排除 265 张衍生物及 151 张九位及以上编号的非衍生物，
每组异画只统计最小有效编号，共去掉 496 个重复异画编号。规则同名卡分别计数。
用于统计的卡共有 14,258 张，覆盖 485 个基础字段，线上 API 计数逐一与独立复算吻合。
默认池有 85 张换档。无字段、小字段、中字段和大字段分别有 584、611、605、578 张。
新轮次使用修订后的统计口径，历史轮次显示各自发牌时的口径。

座位简写与本人候选区提示均支持悬停和点击。Windows 和 Linux 各通过 419 项自动化测试。
本地八人房验证了八个座位的触屏点按、键盘关闭与焦点恢复、候选范围和 API 重启恢复。
公网八人房 `E9CD8A72` 完成一轮结算，写入 8 条发牌统计。默认池「20261108精选」的
2,378 张经公网逐页核对。

在对局空闲时切换 Cube API 与 Web，七项服务、页面和静态资源验收通过。数据库备份位于
`/opt/ygocube/backups/20261108-guess-distinct-fields-a59578f/cube.sqlite`，SHA256 为
`d3e482974c2597cbca4a6384153c91d079140a9bdd7ec7973de2fddf728164bc`。
备份和运行库通过完整性与外键检查，历史房间及卡池已与备份核对。
统计、构建及验收日志位于 `data/local-dev/guess-distinct-fields-release/`。

## 高级检索与房间操作 Aly 发布

Cube 和独立 Duel 同步发布 `20261108-guess-search-9a2a0b7`，由本地提交
`9a2a0b7542839eca4ad01549821344dd7c825a18` 构建。Cube Web Build ID 为 `7fSpS3s9kNdDY2QfJqhQW`，
Duel Web Build ID 为 `P5hMq9GBZdIlyhypCj4ab`。应用包 SHA256 为
`83a7e821e2f0e5f889fc05f0bdf1d89c08421bb638685548872c708c5b0daa98`。

猜牌卡池、房间候选和 Duel 构筑共用结构化筛选、英文双引号词组查询和分页。首发年份按已知 OCG／TCG
最早正式发行年，从已复核的 YGOPRODeck 日期快照生成。索引覆盖 14,748 个卡号和默认池全部 2,378 张牌。
房主可按投降结算最后一人并直接开启下一轮。轮间名单随房间轮询更新，房主可移除其他玩家并保留其积分。

Windows 和 Linux 各通过 423 项自动化测试。本地从旧发布启动并续玩四人房，核对了版本、行动人、提示和候选。
公网卡池组合筛选命中 54 张，指定两个连接方向和数目命中 14 张。Duel 的 `"RANK 4"` 超量筛选命中 218 张，
指定两个连接方向命中 75 张。公网四人房 `BC29A4F1` 完成两轮，写入 8 条发牌统计。

切换前原生对局空闲。发布后逐条比对了等候、游戏中及轮间各一间既有房，保存状态均与备份一致。
两套 API 和 Web 切换完成，七项服务和公网静态资源均通过检查。
Cube 与 Duel 的数据库备份各在所属实例的 `backups/20261108-guess-search-9a2a0b7/` 中。
`cube.sqlite` 的 SHA256 为 `62af96d4fa7a1dd87a155f71455c2bc6884f7f8ddd96674b635aa20d27271f52`，
`duel.sqlite` 的 SHA256 为 `e541a7bbb9d4796e648056d23d595ca9e56ddf4f234d350603ac5d25253db567`。
备份和运行库通过完整性与外键检查。构建及验收日志位于 `data/local-dev/guess-search-release/`。

## 子类型组合筛选与 Guess 人数 Aly 发布

Cube 和独立 Duel 同步发布 `20261109-guess-filters-capacity-d773f24`，源码提交为
`d773f243a060d16b19291b989548086b924ea45b`。Cube Web Build ID 为 `uYEop-JbEN0XO_4QDZ7sq`，
Duel Web Build ID 为 `MLlINCyp3grcRHxijtk7S`。应用包 SHA256 为
`92240ad7220ab3079d00a7f8ae72902ce981d5b9e81db4bde5a77d6c63c0d2e3`。

切换前确认原生对战空闲。备份两套数据库后，以 `maintenance` 原因结算一间游戏中和一间轮间的
Guess 房间，并保留一间尚未开局的等候房。结算事件保留既有积分，已完成轮次的卡池统计经比对一致。
两套 API 与 Web 已切换，七项服务正常。卡库及资源清单哈希与切换前一致。

Linux 发布构建通过 425 项自动化测试，Windows 通过 14 项 Guess 接口回归。公网用
`（超量 或 连接）与 效果怪兽` 配合 2–4 的统一数值区间，默认池命中 276 张，独立 Duel 命中 741 张。
公网页面引用的 33 个不同静态资源均返回 200 和正确 MIME。

十个独立浏览器会话在公网房 `6804E5AE` 完成创建、加入、发牌和一轮结算。十张牌各不相同。
验收覆盖匿名观战、局内组合筛选、跳过、公开当前选牌、猜错锁定、投降揭牌及最终排名。
九人依次得 10 至 2 分，最后一人投降得 0 分。数据库写入 10 条发牌统计，测试房已结算。

两份备份位于各实例的 `backups/20261109-guess-filters-capacity-d773f24/`。`cube.sqlite` 的
SHA256 为 `bcc3a2920e412887d4d302bac1fe6d9c4912297400ea6ab108ede29a8cdbd347`，`duel.sqlite` 的
SHA256 为 `aa570cef29bb5229e04f9ab6b8d1cde30ef5a4db369fa24460e002be70f6c7d3`。
备份及运行库通过完整性和外键检查。Cube 启动日志报告三组既有历史对战桌号重复，已与备份核对。
验收后清理本次 Aly 上传和解包暂存目录，日志保存在 `data/local-dev/guess-filter-capacity-release/`。

## 子类型取反、标签配色与连接值 Aly 发布

Cube 和独立 Duel 同步发布 `20261109-guess-not-filter-b1ad45b`，源码提交为
`b1ad45b95bc7ea46f1deaf678afaca4b2dda30e3`。Cube Web Build ID 为 `WvEMSO_dvH3yCRBLbMzz7`，
Duel Web Build ID 为 `2fWedDrbO5sag1ZqXfzl5`。应用包 SHA256 为
`2ee0d7942e5a4c20534a2f668b97a29b63f9242cd04ae2bb1a3c948d7532e967`。

Aly 卡库的 515 张连接怪兽均满足连接值等于有效箭头数。网页以统一的等级／阶级／连接值范围筛选数目，
连接方向仍支持多选取交集。旧 API 的箭头数量参数继续兼容。
子类型的「非」可作用于标签或括号组，优先于「与」和「或」。确认标签按卡框或大类着色，点击即删除。

Windows 和 Linux 各通过 425 项自动化测试。本地与公网浏览器均验证了十种配色、直接删除、
无效表达式阻止提交、括号取反和局内候选。公网用 `（超量 或 连接）与 非（灵摆 或 连接）` 与 2–4 区间
筛选时，默认池命中 101 张，独立 Duel 命中 315 张。默认池内连接值 3 且同时有左下和向下箭头的有 13 张。
公网两人测试房 `7B871330` 完成一轮并结算，写入两条发牌统计。

切换时已开局的 Guess 房和原生对战均空闲。15 间既有房与发布前备份逐条比对一致。
七项服务及 33 个公网静态资源通过检查。两份备份位于各实例的 `backups/20261109-guess-not-filter-b1ad45b/`。
`cube.sqlite` 的 SHA256 为 `34dd505391208b6de8c3429db653e13dad38520954e2420ef4cdce99d54ec4eb`，
`duel.sqlite` 的 SHA256 为 `bdfede84c83182cdd3f091c13f93d0e6387f3e87a2ac2617f7229a9176b60947`。
备份和运行库通过完整性及外键检查，卡库和资源清单哈希与切换前一致。
验收后清理本次 Aly 上传和解包暂存目录，日志保存在 `data/local-dev/guess-not-filter-release/`。
