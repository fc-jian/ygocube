# 官方简体中文禁限表

这里保存经过审核的官方 SC 禁限表快照，运行时文件仍由资源管线生成，不直接维护服务器上的 `lflist.conf`。

当前版本是 **2026-10-01 生效、第 19 次更新**。截至 2026-11-12，官网简体中文列表的最新条目为 id=35：禁止 29 张、限制 65 张、准限制 16 张，另有解除限制 2 张。解除限制记录只留作审核，不写入限制映射。

- [官方简体中文卡表目录](https://www.yugioh-card-cn.com/limiter?queryData=2)
- [官方本期页面](https://www.yugioh-card-cn.com/limiter/detail?type=2&id=35)
- [官网公开目录接口](https://webadmin.windoent.com/front/yxw-public/forbidden/forbbidengroup/webList?type=2)
- [官网本期数据接口](https://webadmin.windoent.com/front/yxw-public/forbidden/forbbidengroup/webinfo/35)

此表独立于 OCG。比如本期「怒刹帝利・芬里尔」在 SC 限制，在 OCG 禁止。卡片范围 `rule=2` 只表示允许使用简体中文已发行卡，不等于选择 SC 禁限表；建房时仍需单独选表。

## 更新方法

1. 从官方目录确认当前生效的 SC 条目，保存目录 JSON 和对应详情 JSON 到 `.card-resource-sync/`。不要把一般 OCG 页面或第三方整理当作 SC 来源；公告的内部 `id` 也不是 YGOPro 卡号。
2. 使用经过资源更新流程校验的 `ygocdb_cards.json` 和 CDB 离线生成新快照：

```text
python scripts/official_banlists.py import-sc --index <官方目录.json> --detail <官方详情.json> --names assets/ygocdb_cards.json --cdb ygopro/cards.cdb --source-id <官方条目ID> --out config/banlists/YYYY.MM.DD-sc.json
```

生成器只用 `sc_name` 做 NFKC、空白与中点规范化匹配；异画通过 CDB alias 归为同一个宿主编号。不做模糊猜测，不用网页记录 ID 当卡号。未知名称、多义名称、重复卡号、分组数量不一致均失败，需补齐卡库或人工核验来源后再生成。快照记录源 JSON、名称表与 CDB 的 SHA-256。

3. 审核快照差异，更新 `test_official_banlists.py` 的当前版本断言，再通过标准 `scripts/update-card-resources.sh prepare` 准备资源。管线保持固定上游卡表在前，在末尾追加审核后的 SC 表，将完整合成内容安装到根目录和 expansions 两处。`banlistSource.officialLists` 记录附加来源，后续资源更新不会默默丢失 SC。
4. 运行 srvpro/Web/资源工具测试与 `node scripts/e2e/banlist-native.cjs <合成卡表>`。首次部署此功能需同时发布新的 `ygopro-server.js`、`cube.js`、`cube-banlists.js`；只替换资源文件会让旧服务错误标注 SC。
5. 生产发布按 `update` 技能维护流程操作。验收逐张比较 API `limits` 与宿主资源，不再只检查卡表名称。

仅预览合成文件、不安装到运行目录：

```text
python scripts/official_banlists.py compose --upstream ygopro/lflist.conf --out .card-resource-sync/lflist-preview.conf --metadata-out .card-resource-sync/official-banlists.json
```

快照是明确版本的审核输入，构建和服务器启动不会联网查询官网。后续资源更新前仍须核对官方目录是否已公布新表。
