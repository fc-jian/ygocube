# 08 - 实施状态、验收与待办

> 状态核对：2026-08-24。✅ 表示代码已在当前 checkout 实现并有自动化覆盖；
> “待实测”表示需要真实 srvpro/客户端/部署环境，不能仅凭单元测试宣称完成。

## 1. 当前里程碑

| 里程碑 | 状态 | 当前结果 |
| --- | --- | --- |
| M0 环境与分支 | ✅ | 根仓库 + `fc-jian` 两个 fork submodule；配置、构建和 E2E 脚本在仓库内 |
| M1 ygopro | ✅ | marker + 运行时 deck limit、严格 seed 解析、长密码、`STOC_CUBE_DECK`、`-cube` 版本后缀 |
| M2 srvpro | ✅ | 严格 Cube HTTP API、幂等建房、开局覆盖/siding 校验、长密码、精简 webhook |
| M3 后端核心 | ✅ | passing/serial 回放、整轮发堆、reserve/暂停冻结、构筑校验/修复、卡池/事件/回溯 |
| M4 对局编排 | ✅* | 单循环/瑞士无重复对手约束、手动赛制、webhook+轮询、DSQ/bye；双败 bracket 需真机复核 |
| M5 玩家前端 | ✅ | 独立玩家 URL、脱敏 SSE、六列牌堆、整理/随机排序、卡图 fallback、对战刷新提示 |
| M6 管理前端 | ✅ | 统一创建/编辑参数、创建者凭据、默认卡池、玩家 token 重设、卡池字面名警告、合规确认、事件回溯 |
| M7 集成与部署 | ⏳ | 真实 4+ 人比赛、Windows 客户端 smoke、Aly SSH 部署和故障演练待环境验证 |

`M4*` 的双败实现已持久化 winners/losers/grand-final 字段，但当前配对器按胜负
组重新配对，并非完整商业 bracket；生产上线前必须用固定 seed 做整 bracket 回归。

## 2. 已完成的关键验收点

### 2.1 资源与安全

- 根仓库不再追踪 `assets/cards.cdb`、`assets/pics`、`assets/script`、
  `assets/expansions` 等个人路径符号链接；`.gitignore` 排除整个运行时 `assets/`。
- `config.yaml` 不入 Git；默认拒绝占位 super token 和空 srvpro API key；比赛管理 token 已取消。
- 玩家、管理员、srvpro webhook 均有独立鉴权路径；SSE 不广播卡组内容或其他桌房间名。
- 玩家 token 比较使用恒定时间摘要比较；SSE 用按比赛隔离 cookie，不再把 token
  放进 URL。关闭 token 鉴权仍拒绝未报名 pid。
- 比赛命令使用 SQLite 事务同步事件和投影，提交后再广播；状态/抓位缓存采用有界
  LRU，服务销毁时清理 draft/deckbuilding/match/SSE 定时器与连接；SSE 有连接数、心跳和反压上限。
- 创建者权限按 `created_by` 作用域校验；删除/轮换创建用户立即撤销其全部比赛权限。
  旧 `admin_token_hash` 迁移时先保留 `data/cube.sqlite.pre-auth-migration.bak`，失败自动回滚。
- 玩家暂停投票接口固定返回 `410 PAUSE_VOTING_REMOVED`；暂停/恢复只能由超级管理员或比赛创建者
  后台执行，暂停不自动恢复并持久化所有倒计时剩余时间。

### 2.2 选牌与构筑

- 默认每堆 24 张；新建比赛默认 `4×玩家数` 堆（卡池不足时减少轮数），`packSize` 与公平性解耦；牌堆数为玩家数倍时每轮每人同样张数，
  非整轮 API 返回预计值/区间，不再误报“不公平”。
- passing 队列按轮发堆，座位随机换位后状态栏从左到右实时刷新；每人 reserve、
  超时自动选、暂停/冻结剩余时间都落事件日志。
- 构筑默认无限时；管理员手动进入对战先得到不合规报告，确认后随机把超限卡移到
  side/未使用区，main 不足下限的玩家 DSQ。
- `maxCopies>1` 允许在已选编号许可内复制卡；未使用区移出的卡会从服务器 deck
  payload 排除，卡组同步文件使用 `cube-deck-<tid>-<pid>-<timestamp>.ydk`。
- 卡池/搜索/选牌状态/详情按 exact card code 保留 alias 相关卡；只有卡组规则副本
  上限按 alias identity 归并。牌堆前端自动使用 `deck_sort_lv` 显示排序，不改服务端
  抽牌顺序。
- `cards/status` 按每次选牌前的实际剩余卡重建玩家视角；前位玩家已选走的卡不会
  被后位玩家误报为已见，返回 code 不做 alias 替换。
- 整理按钮使用与 YGOPro `deck_sort_lv` 相同的比较器；手动拖动仍保留顺序，随机
  按钮只洗 main；卡池编辑页复用同一排序逻辑。
- SSE 在线时页面不再高频轮询；断线才启用 10--15 秒、可见性受控的备用轮询，状态
  加载单飞且卡片元数据使用有界 TTL/LRU 缓存。普通 JSON 响应 gzip，SSE 保持流式。

### 2.3 卡池与元数据

- 新建/编辑支持每行 `code` 和 `code<TAB>name`；缺失编号、非法行、字面名不匹配
  均逐行报告。字面名读取 `ygocdb_cards.json` 的 exact-code 映射，不会把
  `cards.cdb` 的 `texts.name` 仅在所有外部译名字段为空时作为最终原名回退；不得使用 `datas.alias` 的规则名称替换 exact code 原名。
- cards.cdb 导入效果文本、刻度、Link 标记、系列名；浏览器名称从
  `assets/ygocdb_cards.json`（`sc_name` → `md_name` → `jp_name` → `cn_name` → `en_name`，再回退 CDB `texts.name`）读取，其他本地化
  名称字段加入搜索索引；`TYPE_TOKEN` 衍生物从用户搜索和卡池/候选池导入中过滤；卡图不入库，使用本地 → AVIF
  → 原图只读代理 → 空白卡 fallback。

## 3. 自动化验证

在已安装依赖且 `config.yaml` 允许测试的环境运行：

```bash
cd cube/apps/api
npm run build
npm test -- --runInBand

cd ../web
npm run build

cd ../../..
git diff --check
```

E2E 探针（需要真实 API/srvpro 与外部 cards.cdb）：

```bash
bash scripts/e2e/run-e2e.sh
bash scripts/e2e/run-full-sim.sh
```

本地宿主若链接 `envs/ygocube/lib` 的 libevent，启动 srvpro 时需把该目录加入
`LD_LIBRARY_PATH`；部署镜像则由 `srvpro/Dockerfile.lite` 提供对应运行库。

宿主/协议回归：

```bash
bash scripts/build-ygopro.sh
(cd srvpro && npm test && npm run build)
(c++ -std=c++14 -Wall -Wextra -Werror ygopro/tests/server_args_test.cpp -o /tmp/server_args_test && /tmp/server_args_test)
git -C srvpro diff --check
git -C ygopro diff --check
```

## 4. 上线前待办

1. **Windows**：用 `C:\projects\ygopro` 的完整源码/依赖和现有 `premake5.exe`
   生成 VS2022 Release `YGOPro.exe`，确认文件大小、依赖 DLL、启动、长密码、
   `STOC_CUBE_DECK`、BO3 siding；不要交付 Debug 或中间文件。
2. **Aly SSH**：配置外部 cards.cdb/script/pics/expansions、唯一 token、CORS
   allowlist、srvpro API key；部署后执行 health、创建房间、结果 webhook 和重启恢复。
3. **真实赛制**：至少跑 4/5/8 人单循环/瑞士、奇数 bye、重复对手无解、双败完整
   winners→losers→grand final；核对 DSQ 后剩余玩家与赛制参数。
4. **CORS**：浏览器 origin 必须出现在 `server.allowed_origins`；若出现
   `CORS_ORIGIN_DENIED`，先检查实际 `Origin`（协议、域名、端口）和反代是否改写，
   不要用 `*` 绕过 credentials。
5. **故障演练**：冻结/解冻、API 重启、srvpro 重启、webhook 重试、回溯关闭房间；
   确认无重复计分、无错误恢复到旧 deck。

## 5. 变更纪律

- 协议字段先改本文件与 `07-protocol-api-design.md`，再同步 shared/API/srvpro/ygopro。
- CoffeeScript 和生成的 JS 必须同一提交；submodule 指针只在对应 fork 分支更新后 bump。
- 运行时卡牌资源、数据库、日志、缩略图和符号链接不提交；根仓库保持可复现的
  最小控制端源码和文档。

## 6. 上游同步审计（2026-08-24）

- `ygopro` 已把 `origin/server@04f0bc5f` 无冲突合入功能分支，并同步其
  `ocgcore@c87afdda`；上游网络版本仍为 `0x1362`/`1.036.2`，Cube 只追加
  `-cube` 展示后缀。
- `srvpro` 的 Cube fork 与 `origin/mercury@a252923` 已长期结构分叉（审计时
  391 个本地提交、75 个上游提交，整分支试合并有 13 组核心冲突），不适合机械
  merge。本轮逐项核对并移植了与当前架构有关的踢人房间状态、最大玩家数和
  超长聊天日志抑制修复；同时移植了 cloud replay 关闭时不再创建无用 recorder
  连接的资源修复。
  已有的 room cap、版本读取和 Node socket 兼容实现保留。后续同步继续按提交审计、
  小批移植和 Cube API 回归测试进行。

## 7. 资源更新验收清单

资源更新使用 `scripts/update-card-resources.sh` 的固定顺序：

```bash
scripts/update-card-resources.sh check
scripts/update-card-resources.sh sync --commit
scripts/update-card-resources.sh prepare --refresh-names
scripts/update-card-resources.sh build
scripts/update-card-resources.sh test
scripts/update-card-resources.sh deploy --confirm-maintenance
```

`sync` 在专用 `codex/card-resource-sync-*` 分支执行 no-ff 合并；出现 C++、
cards.cdb 或 gitlink 冲突时必须人工解决，脚本不会自动选择任一侧。`prepare`
生成包含上游提交、SQLite 哈希/行数、Lua 与 AVIF 文件哈希、图片 ETag 和删除
清单的 `resource-manifest.json`，状态目录不入 Git。缺失新卡字面名称默认阻止
发布；`--allow-missing-names` 只适用于已记录审计的例外。

部署前的远程脚本取得锁并备份 `cube.sqlite`、WAL/SHM、配置、宿主目录和 AVIF，
校验数据库后进入维护模式，原子切换仅含变化文件的资源目录，按 API → srvpro →
Web → Nginx 启动。验收必须同时覆盖四个 systemd 服务、`/api/health`、首页全部
Next JS/CSS 的 200 与 MIME、srvpro 协议探针、宿主 `ldd` 和新 cards.cdb；失败
自动调用 `rollback --backup-id` 恢复旧资源并保留备份。
