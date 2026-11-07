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
