# 01 - 项目总览与当前架构

> 本文是仓库当前实现的入口说明（最后核对：2026-08-09）。需求原稿见
> `original_guide.md`；接口字段以 `07-protocol-api-design.md` 和
> `cube/packages/shared/src/index.ts` 为准。

## 1. 项目目标

YGO Cube 把 YGOPro 的对战引擎、srvpro 的联网房间和一个 Web 控制端组合成
完整的轮抽比赛：

`报名 → 选牌（draft）→ 构筑（deck build）→ 排表/对战 → 结果与排名`

当前支持：

- `passing` 传递式选牌（默认）和用于旧比赛回放的 `serial` 串行模式；每堆
  卡数可任意设置，默认 24；新比赛默认生成不超过卡池容量的 `4×玩家数` 堆，
  即最多四轮，passing 默认按整轮发堆、每轮可随机换位。
- 每名玩家独立的选牌计时与 400 秒保留时间；超时才自动随机选牌。暂停会
  持久化冻结时刻的剩余时间，恢复后原样继续。
- 服务器权威的主/额外/副卡组构筑、YGOPro 同逻辑整理、手动拖动和主卡组
  随机洗牌模拟；默认主卡组 40--60、额外/副卡组各最多 30、单卡最多 1 张。
- 明确赛制：单循环、手动轮数的瑞士轮（可选单败淘汰，淘汰人数可为 0）和
  双败淘汰。创建时按人数写入推荐值，开赛后不再自动改赛制。
- 卡池导入、字面卡名校验、缺失编号报告、默认卡池、事件日志/快照/回溯和
  SSE 实时刷新。

## 2. 系统组成

```
玩家浏览器 ── REST/SSE ──▶ cube/apps/api (NestJS + better-sqlite3)
     │                            │
     │                            └── HTTP + X-Cube-Api-Key
     │                                         ▼
玩家 YGOPro 客户端 ◀── srvpro (cube 分支，房间代理/结果) ──▶ ygopro 宿主
                                                        (cube-server 分支)
```

- 根仓库 `fc-jian/ygocube` 保存控制端、契约、脚本和文档。
- `srvpro/`、`ygopro/` 是分别指向 `fc-jian/srvpro:cube` 与
  `fc-jian/ygopro:cube-server` 的 Git submodule；它们保留各自上游许可证。
- srvpro 每个房间启动一个无头 ygopro 宿主，读取 stdout 中的动态端口并代理
  客户端流量。Cube 房间还会同步服务器权威卡组和安全的卡组文件名。

## 3. 技术栈与目录

| 目录/组件 | 当前实现 |
| --- | --- |
| `cube/apps/api` | NestJS、TypeScript、better-sqlite3；事件日志同时维护查询投影 |
| `cube/apps/web` | Next.js 14 App Router、React、TailwindCSS、SSE |
| `cube/packages/shared` | 浏览器/API/srvpro 共用的类型与协议常量 |
| `srvpro` | CoffeeScript 源码及编译后的 JS，Cube HTTP API 在 `cube.coffee` |
| `ygopro` | C++ premake 工程；server/client 共用源码，Cube 扩展在 `cube-server` |
| `dev_docs` | 架构、接口、实现状态与验收记录 |

根仓库只追踪运行控制端所需的最小元素。`assets/` 是运行时挂载点，整个目录
（包括符号链接、卡图、数据库和生成缩略图）由 `.gitignore` 排除，不属于
仓库内容。

## 4. 生命周期与默认值

状态机为：

`registration → drafting → deckbuilding → matches → finished`

| 配置 | 默认值 | 说明 |
| --- | ---: | --- |
| `packSize` | 24 | 每堆卡数，不参与“公平”判断 |
| `draftMode` | `passing` | 每轮发堆，队首堆顺时针传递 |
| `pickSeconds` | 40 秒 | 基础选牌时间 |
| `reserveSeconds` | 400 秒 | passing 每玩家保留时间，耗尽才自动选 |
| `evenPackCount` | `true` | 牌堆数须为玩家数整数倍；关闭时末轮随机分配 |
| `reseatEachRound` | `true` | passing 每轮结束重新随机座位 |
| `deckbuildingSeconds` | `null` | 无限；管理员确认后手动进入对战 |
| `mainMin/mainMax` | 40/60 | 主卡组限制 |
| `extraMax/sideMax` | 30/30 | 额外/副卡组上限 |
| `maxCopies` | 1 | 三个区域合计的构筑许可上限 |

牌堆数是玩家人数的整数倍时，每名玩家在完整一轮得到同样的 `packSize` 张
牌；不满足时 UI/API 只给出可获得区间，并不会把每堆大小误判为不公平。
`packCount`、`dropMode`、`dropPublic` 和 `packStrategy` 仍支持显式配置及旧
比赛回放。

## 5. 赛制

`matchFormat` 在创建时或首场对局前由管理员明确保存：

1. `round_robin`：轮转法单循环。
2. `swiss`：`swissRoundCount` 手动指定轮数，`playoffSize` 为 0 或不超过
   有效人数的 2 次幂；瑞士排表把所有历史对手作为硬排除约束，无法产生完整
   配对时返回 `NO_VALID_PAIRING`。
3. `double_elimination`：胜者组/败者组，两败淘汰，最后一场为一次性总决赛。

缺少赛制字段的历史比赛只按旧配置兼容回放。新建比赛的推荐值为：2--5 人
单循环；6--8 人瑞士 4 轮无淘汰；9--16 人瑞士 4 轮 Top 4；17 人以上瑞士
`ceil(log2(n))+1` 轮 Top 8。推荐值只是创建时写入的初始值，管理员仍可修改。

## 6. 运行端口与部署

| 服务 | 默认端口 | 用途 |
| --- | ---: | --- |
| Web | 3000 | 玩家/管理员页面 |
| cube API | 3001 | REST、SSE、卡图代理 |
| srvpro 游戏 | 7911 | YGOPro 客户端连接 |
| srvpro HTTP | 7922 | `/cube/*` 与现有管理接口 |
| srvpro HTTPS | 7923 | 可选 |
| ygopro 宿主 | 动态 | 每房间由 srvpro 读取 stdout 端口 |

所有 cube API 启动配置从根目录 `config.yaml`（或 `CONFIG_FILE`）读取；相对
路径按配置文件目录解析。生产环境必须设置唯一的 admin/srvpro token，并把
`server.allowed_origins` 精确列出 Web 来源。

运行时卡牌资源必须由部署脚本或管理员另行提供：

```text
cards.cdb   ygocdb_cards.json   script/   pics/   expansions/
```

它们可以放在 `srvpro/ygopro/`，也可以用 `server.cards_cdb`、`server.card_names_json`、
`pics.ygopro_root` 指向已有安装。原始卡图不入库；可选的低清 AVIF 由
`pics.avif_dir` 提供。

## 7. 关键设计约束

1. 所有比赛状态先写 append-only 事件，再由同一 `apply()` 回放；快照用于
   快速恢复，管理员回溯会冻结比赛、关闭活动房间并截断未来事件。
2. 玩家接口默认校验 `tournamentId + playerId + token`；super token 可作
   调试用万能玩家 token。每场比赛可由管理员显式关闭 token 校验。
3. SSE 只广播脱敏事件：不带卡牌/卡组内容，也不带其他对局房间名；客户端
   收到事件后重新读取自己的状态。
4. ygopro 启动参数只在末尾追加 4 个运行时 deck limit，旧参数组合继续按
   40/60/15/15 工作；游戏协议结构只增不改。

## 8. 文档索引

| 文档 | 内容 |
| --- | --- |
| `02-codebase-analysis.md` | 两个 submodule 的分支、关键文件与实际扩展点 |
| `03-ygopro-modification-plan.md` | 宿主参数、运行时 deck limit、客户端同步实现 |
| `04-srvpro-modification-plan.md` | Cube 房间、长密码、卡组覆盖和 webhook |
| `05-cube-backend-plan.md` | 后端状态机、牌堆、构筑、排表、数据库和配置 |
| `06-cube-frontend-plan.md` | 页面路由、交互、脱敏、卡图和实时刷新 |
| `07-protocol-api-design.md` | 三侧唯一接口契约 |
| `08-task-breakdown.md` | 已完成项、未完成验证项和验收命令 |
