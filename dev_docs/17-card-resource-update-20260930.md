# 2026-09-30 卡片资源与 Aly 维护验收

## 发布结果

- 两套 current：`card-sync-20260930-043549-f48da03`。
- 发布功能提交：根仓库 `f48da03aa576c5d5ca49ad96b544144c7e9948e2`；srvpro 的 `cube` 分支为 `4d4e45a03e36e6b1c671ce32cd1b4c33246e574d`，均已推送 fork 特性分支。
- ygopro 为 `db1b431ff20d7aac82bda27d027c821571d7723c`，已包含上游 `server` 的 `176fc60c9bb2d3ee1d984a743647629b1503d4ca`；script/ocgcore gitlink 本次未改变。没有新的 C++/二进制依赖变化，复用已通过 Linux 启动、依赖和对局验收的宿主。
- Super Pre 使用 2026-09-29 21:12:19 更新的官方包；SHA-256 为 `b9da60d73d6ae0aee08b8cb3b523eec5588e91e7b1a369738e5b6e4a75615860`。release 列表为 91 张，两份扩展 CDB 共验收 332 张卡。
- 新增 `100262301`（屋素姆的魔龙王）、`101307029`（盟约之标枪甲虫）；两套 API 均可检索。更新了 release CDB、8 个扩展 Lua 和两张 AVIF。
- 重新获取并验证 YGOCDB 的版本标识与名称归档；其 MD5 仍为 `4ccbfbdd77bca4d9762bb0efeae6ea3e`，名称缺失报告为空。精确编号映射缺失的扩展卡按约定回退到 CDB 名称。

## 修复范围

1. 发布/回滚用一个锁覆盖 Cube 与 Duel。先关闭 Duel API 建房并暂停原生接入，再复查宿主；出现新房时恢复入口并取消维护。
2. SSH、上传和回滚步骤失败明确传播非零状态；不依赖条件上下文中的 Bash errexit。
3. 发布前读取服务器实际 manifest，打包后在锁内复查 SHA；发布和回滚后刷新本地基线。回滚同时使两套派生 cards 缓存失效，保留玩家、赛事和事件数据。
4. 应用/Web 发布器克隆硬链接、先替换文件再展开归档、原子更新 JSON；三条维护入口共同检查 Cube/Duel 同代资源。一次性安装/旧目录迁移入口禁止覆盖现有新流程。
5. 禁限表日期保留上游日历日期。线上最新显示为 `2026.10.01 OCG` 和 `2026.09.01 TCG`；UTC、上海、洛杉矶回归通过。
6. srvpro 应用修改通过 `--srvpro-app` 与资源一起安装到两套新 release；重启 Duel Web，解除其实际工作目录对旧 release 的引用。
7. 当前备份与 shared 工具目录保存完整事务工具，成功 staging 清理后仍可回滚。最后的维护提交补充工具留存、skill、验收记录和测试 SQLite 句柄释放，不改变线上应用功能提交。

## 验收证据

| 项目 | 结果 |
| --- | --- |
| 资源维护测试 | Linux 47 项通过；Windows 40 项通过、7 项 Linux 信号/锁或目录符号链接检查跳过 |
| API | Windows/Linux 各 21 suites、235 tests 通过，构建通过 |
| Web | Windows/Linux 各 50 tests 通过，构建通过 |
| srvpro | 原有验证测试及禁限表解析/时区测试通过；两端构建通过 |
| Cube E2E | Windows/Linux 各 20 项通过 |
| 八人 BO3 | Windows 57 秒、Linux 56 秒完成完整模拟赛 |
| 扩展卡实际执行 | 两端新增扩展卡入场通过；`100268005` 召唤、发动并检索 `1596508` 的效果通过；不声称逐卡效果全部验证 |
| 同步幂等 | 对当前官方包复跑受管扩展同步，435 项本地清单完全相同 |
| 线上搜索 | Duel 332 张扩展卡逐张按编号及完整显示名检索；两套 API 额外核验两张新增卡 |
| 线上卡片缓存 | 两套均为 15,110 条、metadata version 6，CDB 与缓存编号/类型一致，SQLite 检查为 ok |
| 资源共享 | 29,063 项完整检查同一 device/inode；主/扩展 CDB、Lua、两处禁限表、映射与 AVIF 一致 |
| 线上宿主与原生协议 | 两套 srvpro 各创建专用空测试房，原生 TCP 入场成功；房间关闭后宿主端口关闭，测试房未写入赛事数据 |
| 网页与静态资源 | `/api/health`、首页、`/duel/decks` 和 21 个引用的 JS/CSS 均通过，MIME 正确 |
| 服务与进程引用 | 七个服务 active；两套 API/srvpro/Web 的实际 cwd 均对应当前 release |
| 卡图 | 15,145 张 AVIF；最大 138×200、最大文件 5,255 字节，无超尺寸项 |

部署 manifest SHA-256：`64ab8335a315e64a67dd606f633f8aea99ce778a63df1fbccfbbbd4554cee5b8`。
AVIF 目录指纹：`301f24b9452f73406b194e9975b1c10f2a28c4973208c009af159e1c757d03ad`。
主 CDB SHA-256：`04b1197239517ab50fb49db8450f83e920a81f5d82a83bdc8f9c7f7ed1aa8400`。

Cube 关闭独立 Web Duel 时，`/public/duel/options` 的 503 为配置预期；卡片搜索仍可用。一次现场搜索请求超时，复查两套新增卡查询均正常。
首次发布尝试因 SSH helper 的结构化输出解析而在停服前拒绝；已修复并补测。该次没有服务器资源切换。

## 历史清理与恢复材料

先核对 current、systemd 路径、实际进程 cwd、备份完成记录与资源校验，再执行 28 项具体路径清理，释放约 1.10 GiB。
删除更旧 release/备份、所有 `.pre-*`、4 个有明确成功证据的 staging 和未使用的 Duel shared AVIF 副本；30 个失败或未确认结果的 staging 保留。

归档复查发现旧失败包 `card-sync-20260909-032952-7ae3200/payload.tar.gz` 含 70 张原图。仅移除原图条目，保留其余 340 项与失败目录，并记录原包 SHA、每个移除条目的 SHA/大小及新包 SHA。原图清理后的归档不能作为原始校验包使用。
重新扫描保留的 19 个归档，原图条目与损坏归档均为零；两套展开的受管资源也无原图。

保留：

- Cube 当前 release 和 `20260920-native-windbot-r22` 回滚 release。
- Duel 当前 release 和 `card-sync-20260929-105422-886d408` 回滚 release。
- 两套 `backups/card-sync-20260930-043549-f48da03/`，包含一致的数据库备份、私有配置、旧指针及资源恢复材料；Cube 备份保存 `apply-duel.py`、`apply.sh`、`transaction.sh`。
- `/opt/ygocube/shared/card-resource-tools/` 的持久化工具与 `cleanup-20260930-043549-f48da03.json` 清理记录。

显式回滚命令：

```bash
bash scripts/update-card-resources.sh rollback --backup-id 20260930-043549-f48da03
```

## 独立待处理事项

Cube 旧业务数据库已有 3 组重复的 `(tournament_id, round, table_no)`，每组两条不同对局记录，额外行共 3 条。2026-10-02 只读复核纠正此前“涉及 3 个比赛”的表述：三组均位于 tournament 16、round 2、table 1/2/3；不能把分组数量视为比赛数量。
更新前的一致数据库备份也有相同 3 组，确认不是本次资源更新引入。外键检查无违规，但历史记录阻止唯一索引创建，启动会输出已知告警。
这不是可直接删除的重复卡片缓存；后续需要核定旧对局的投影与事件，再单独迁移。此次保留全部玩家与赛果，没有通过删记录消除告警。

用户已有的未跟踪文件 `dev_docs/16-srvpro-modern-ts-rewrite.md` 保持原样，不纳入此次提交。
本次详细测试和现场 JSON 日志保存在被 Git 忽略的 `.card-resource-sync/`，不提交运行时资源或敏感配置。
