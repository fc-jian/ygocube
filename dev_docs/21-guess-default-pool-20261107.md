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
