# 本地工程修复与验收（2026-10-02）

本轮按“先整理 Git，再修复和本地测试”执行。没有推送 GitHub、部署 Aly、修改生产数据库或启用生产定时任务。生产仍保留审查时的版本和问题，不能把本地通过视作线上已修复。

## 分支与工作区

- 根 main 快进到已存在的 `504561c`；当前开发分支为 `codex/review-hardening-20261002`。原 main/cube/duel/resource-sync 指针保存在 `archive/20261002/*` 标签，已合并的本地任务分支已清理。
- ygopro 使用 `cube-server`（`db1b431f`），srvpro 使用 `cube`（`4d4e45a`）；子模块 master 未修改，根 gitlink 未变化。
- 远端分支保持原样。GitHub 分支保护、远端 main 快进及远端旧分支清理尚未执行。规则详见 `11-branch-release-plan.md`。
- 原有未跟踪文件 `dev_docs/16-srvpro-modern-ts-rewrite.md` 保留，不纳入本轮提交。运行时资源、数据库、测试日志与 pnpm store 不入 Git。

## 修复结果

| 问题 | 本地修复及边界 |
| --- | --- |
| Express 路径大小写/尾斜杠绕过管理员、创建者和候选池鉴权 | Guard 使用已匹配 handler/controller 的 Access 元数据，不再按原始 URL 文本判断权限；路由 tid 优先于冲突 header。实际 Nest HTTP 测试验证大小写、尾斜杠、跨比赛和凭据轮换。 |
| 成对资源发布失败时子步骤过早启动服务 | 两套子步骤 deferred start；同一锁内恢复及验证后才统一启动；恢复失败保留停服状态、staging 和备份。添加 IPv4/IPv6 入口规则台账，验证期间保留 loopback 探针。没有在生产执行这些规则。 |
| 历史重复桌号使唯一索引不可用 | 启动时安装防新增冲突的触发器，保留旧记录比分更新能力；另提供只读检查/离线修复 CLI，保留 match ID、比分和事件历史。生产记录未修改。 |
| 对战页初次加载失败只显示加载中；meta 失败误显示 localhost | 显示可重试错误；只有地址读取成功才显示连接说明。 |
| 独立 Duel 卡组 cookie 容量小、附带在请求中 | 改用 IndexedDB，旧 cookie 事务迁移后删除；迁移标记防覆盖/复活；保存失败不报成功，异步保存/导入保留新编辑。卡组仍只在本浏览器，不自动同步服务器。 |
| release 顶层 commit 难以说明各组件版本 | 记录 API/Web/srvpro/host/resources 内容哈希与分别的来源证据，保留未修改组件来源；旧历史元数据标记 legacy，无法证明的来源标记 unknown。应用发布前要求新版 helper。 |
| 无日常独立可验证备份 | 新增 SQLite 在线一致性备份工具、校验/恢复演练和镜像目录支持，以及 systemd 模板；未安装或启用。 |
| CI 与维护规范缺口 | 新增 Windows/Linux 测试构建 workflow；同步接口契约、分支约定和 update skill。CI 尚未在 GitHub 运行。 |

## 验收

- Windows 和 WSL Ubuntu 22.04 分别安装本平台依赖：API **252**、Web **55**、duel-protocol **41** 项均通过；API/Web 构建均通过。Linux standalone 的静态目录准备成功。
- Python 资源/发布/备份回归 **52** 项通过，包括故障恢复成功/失败、入口规则幂等、硬链接不可变性、组件来源及内容漂移。使用临时目录和 mock systemctl/防火墙；不能替代未来 Aly 维护窗口内的现场验收。
- Windows 的备份专项 **2** 项通过，确认 SQLite 连接关闭后可清理临时文件、WAL 内容一致、镜像可恢复和拒绝覆盖旧备份。
- Windows 与 Linux 各运行隔离真实宿主 BO3/重连探针，均 `ok: true`、`reconnected: true`，各记录 96 帧；Linux 只使用既有 Linux 宿主，未复制 Windows 二进制或依赖。
- Edge/Playwright 真实浏览器：对战初次失败可重载、meta 失败无虚假 localhost 地址、重试成功、旧 cookie 迁移、11 副卡组保存刷新、删除后刷新不复活，页面异常为 0。
- `update` skill quick_validate、维护 Python 语法、`git diff --check` 通过。systemd 模板语法检查通过；WSL 的系统单元/挂载权限警告不代表已安装模板。

可重复命令（仓库根执行，pnpm 项目命令在 cube 执行）：

```text
cd cube
pnpm install --frozen-lockfile
pnpm test
pnpm build
cd ..
python3 -m unittest discover -s scripts -p 'test_*.py'
node scripts/e2e/web-duel-smoke.cjs
node scripts/e2e/review-hardening-browser.cjs http://127.0.0.1:3330
```

浏览器用例需先在 `cube/apps/web` 启动 `next start -p 3330`，设置 `PLAYWRIGHT_MODULE_PATH` 和 `CHROMIUM_PATH` 指向本机安装；API 全部使用页面级 fixture。Linux 脚本回归需 Bash。Windows 备份专项用 `python -m unittest discover -s scripts -p test_backup_database.py`。本轮 Windows 日志在忽略目录 `.card-resource-sync/review-20261002/`，Linux 隔离目录在 `/tmp/ygocube-review-20261002/`。

## 历史桌号的后续离线修复

审查时发现的三组冲突均在 tournament 16、round 2、table 1/2/3，每组两个不同对局；不得删除其中任意对局来消除告警。先在数据库副本演练，逐场核对事件与实际赛果，确定新的桌号。

```text
node cube/apps/api/dist/maintenance/repair-match-tables.js --db /absolute/path/copy.sqlite
```

此命令默认只读，不运行迁移。输出含 conflicts 和 plan。将 **plan 对象本身**存为 reviewed-plan.json，逐条填入正整数 tableNo，保持 fingerprint 与全部冲突记录的 ID 不变，目标桌号在各轮内不能重复。不自动推荐哪场对局占原桌号。

应用前用现有管理员冻结功能冻结涉及的比赛，再重新读取计划（冻结会改变 fingerprint）；停止 API 和所有其他数据库写入者。需要单独授权生产操作时，先准备已复核计划与备份位置。应用命令：

```text
node cube/apps/api/dist/maintenance/repair-match-tables.js --db /absolute/path/copy.sqlite --apply-plan reviewed-plan.json --offline --backup /absolute/path/new-backup.sqlite
```

CLI 要求新备份路径，不覆盖旧文件。确认 fingerprint 未变、所有冲突都在计划内、投影与事件中轮次/玩家/比分一致后，事务追加桌号修正事件、更新投影及管理员操作日志并恢复唯一索引。任一不一致拒绝修复，事务回滚。复查 `remaining: 0`、事件重放和赛果后再恢复服务/解冻。该工具不替管理员决定业务正确的桌号，也不自动停服务。

## 独立备份与运维落地

```text
python3 scripts/backup-database.py --db /absolute/path/cube.sqlite --destination /backup/cube-unique.sqlite --mirror-dir /mounted-independent-backup/cube
```

脚本用 SQLite backup API 保留已提交 WAL 内容，执行 integrity_check、foreign_key_check、复制恢复和 SHA 校验，成功才写同名 `.json` 清单。每次使用新的目标名；失败残留文件不算成功备份。镜像目录应是独立存储挂载，同一磁盘第二目录不构成异地备份；脚本不自动配置挂载、上传或删除历史备份。

`scripts/systemd/ygocube-backup@.service` / `.timer` 是待安装模板，建议以 0644 权限安装。每个实例的 `/etc/ygocube-backup-<instance>.conf` 需配置 BACKUP_SCRIPT、DATABASE、BACKUP_DIRECTORY、MIRROR_DIRECTORY，配置文件权限 0600。先手动验证目标挂载、空间、权限及恢复，再启用 timer；每日约 04:00 运行。部署时仍须备份，日常备份不能替代发布回滚材料。

## 后续发布边界

当前没有 Aly 发布授权。未来发布先在维护窗口验证新版 helper 与 iptables/ip6tables 可用，再核验成对资源、七服务、HTTPS 静态资源 MIME 和实际对局。数据库历史修复及备份 timer 的安装需要独立操作记录。暂不开展 srvpro 整体 TypeScript 重写；先使现有链路稳定并积累接口回归覆盖。
