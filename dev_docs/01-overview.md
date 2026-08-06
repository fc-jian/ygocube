# 01 - 项目总览与总体架构

## 1. 项目目标

基于开源 `ygopro` 游戏引擎 + `srvpro` 服务端，构建一套全流程 **轮抽模式 (Cube)** YGO 对战系统：

一次完整 Cube Tournament 流程 = **选牌 (Draft)** → **构筑 (Deck Building)** → **对战比赛 (Matches)**。

| 阶段 | 说明 |
|---|---|
| 报名 | 主办方确定人数/卡池/模式等参数，生成 URL；玩家打开网页 UI 报名 |
| 选牌 | 全卡池随机打乱 → 若干牌堆（每个牌堆大小为玩家数×3，drop last 且预先公开）；玩家按圆桌蛇形轮转选牌，30s 时限（超时随机），选牌互相不可见 |
| 构筑 | 用选到的牌构筑主卡组(40~60) + 额外(≤15) + 副卡组(≤15，Match 模式)；锁定后服务器校验，超时自动补/删 |
| 对战 | 按人数规则排表（单循环/瑞士轮+淘汰赛），每轮通过 srvpro 建房间，自动获取赛果并排下一轮 |

## 2. 系统组成

```
┌──────────────────────────── 部署拓扑 ────────────────────────────┐
│                                                                  │
│  [玩家浏览器]                                                     │
│     │  HTTPS / SSE (选牌、构筑、排表、房间信息)                     │
│     ▼                                                             │
│  ┌─────────────────────────────────────────────┐                 │
│  │  cube  (本项目新开发, cube/ 目录)             │                 │
│  │  ├─ apps/web    Next.js 前端 (选牌/构筑/对局UI)│                │
│  │  └─ apps/api    NestJS 后端 + SQLite          │                │
│  │      └─ SrvproClient: HTTP 调用 srvpro        │                │
│  └────────────────────┬────────────────────────┘                 │
│                       │ HTTP (api_key 鉴权)                       │
│                       ▼                                           │
│  ┌─────────────────────────────────────────────┐                 │
│  │  srvpro  (mycard/srvpro, CoffeeScript)      │                 │
│  │  ├─ 房间管理 / 玩家代理 / 战绩与卡组记录       │                 │
│  │  └─ spawn 每房间一个 ygopro 无头宿主进程      │                 │
│  └────────────────────┬────────────────────────┘                 │
│                       │ 命令行参数 + stdout(端口) + 游戏协议       │
│                       ▼                                           │
│  ┌─────────────────────────────────────────────┐                 │
│  │  ygopro server binary (mycard/ygopro        │                 │
│  │  **server 分支** 编译, 无头宿主模式)          │                 │
│  │  └─ ocgcore 规则引擎 + netserver (房间内对战) │                 │
│  └────────────────────┬────────────────────────┘                 │
│                       │ 游戏协议 (CTOS/STOC, 7911 经 srvpro 代理)  │
│                       ▼                                           │
│  [玩家 ygopro 客户端]  ←── 玩家手动用 ydk 卡组进房对战              │
└───────────────────────────────────────────────────────────────────┘
```

**关键架构事实（来自代码勘察，详见 02-codebase-analysis.md）：**

1. **srvpro 本身不跑规则引擎**。`Room.spawn()` 为每个房间 `spawn './ygopro', param, {cwd:'ygopro'}`（`ygopro-server.coffee:1287,1454`），子进程把监听端口打印到 stdout（`ygopro-server.coffee:1480-1483`），srvpro 再把玩家 socket 代理到该端口。被 spawn 的 `./ygopro` 是无头宿主模式，其源码在 mycard/ygopro 的 **`server` 分支**（`gframe.cpp` 的 `main()`：`argc >= 13` 时按位置参数启动宿主，支持 `MAX_MATCH_COUNT` 个 seed 参数）。
2. **deck 大小限制目前是编译期常量**：`gframe/deck_manager.h:17-20`（`DECK_MAX_SIZE=60 / DECK_MIN_SIZE=40 / EXTRA_MAX_SIZE=15 / SIDE_MAX_SIZE=15`），在 `DeckManager::CheckDeck()`（`deck_manager.cpp:87`）中硬编码执行。
3. **srvpro 已有大量可复用机制**：房间名即规则字符串（Room 构造器解析 `LP8000,TIME180,NOCHECK,...` 等 token）；战绩/卡组/回放 webhook 上报（`arena_mode.post_score`，`room.delete():1510`）；断线重连模块（`settings.modules.reconnect`，`CLIENT_reconnect`）；HTTP 服务器（`settings.modules.http.port`，默认 7922，已有 websocket roomlist）。
4. **结果获取已有成熟模式**：srvpro 追踪 `room.scores` / `duel_stage` / `decks`，房间销毁时通过 axios POST 到外部 URL（带 10 次重试）。cube 直接复用/扩展该模式。

## 3. 技术栈

| 组件 | 技术 |
|---|---|
| cube 前端 | Next.js (App Router) + React + TailwindCSS；SSE 实时推送 |
| cube 后端 | NestJS + TypeORM/SQLite；事件日志 + 快照实现可恢复状态 |
| srvpro | CoffeeScript（Node.js），原样扩展，新增 `modules.cube` |
| ygopro | C++ (premake5)，server 分支改造 |
| 数据库 | SQLite（cube 专用；srvpro 侧保持其现有存储） |

## 4. 目录规划

```
ygocube/
├── AGENTS.md            # 项目约定（本文档的总结）
├── dev_docs/            # 开发文档（本套文档）
├── ygopro/              # mycard/ygopro，master=客户端；改动必须新建分支
│   └── (新分支 cube-server 基于 origin/server)   # 无头宿主二进制
├── srvpro/              # mycard/srvpro，改动必须新建分支 (cube)
├── assets/              # 卡牌数据库 cards.cdb / pics/ / script/ / expansions/
└── cube/                # 新开发 web 控制端
    ├── apps/web/        # Next.js 前端
    ├── apps/api/        # NestJS 后端
    ├── packages/shared/ # 共享类型/常量（前后端 + srvpro 契约）
    └── docs/            # 运行/部署说明
```

## 5. 端口与部署约定（初始值，可在 .env 覆盖）

| 服务 | 端口 | 说明 |
|---|---|---|
| cube web | 3000 | Next.js，面向玩家 |
| cube api | 3001 | NestJS REST + SSE |
| srvpro 游戏 | 7911 | 玩家 ygopro 客户端直连（srvpro 代理） |
| srvpro http | 7922 | cube↔srvpro API（新增 `/cube/*` 端点） |
| srvpro ssl | 7923 | 可选 |
| ygopro 宿主进程 | 动态 | 每个房间一个，端口随机，stdout 打印 |

部署布局：`srvpro/ygopro/` 目录内放置 server 分支编译产物 + `assets/` 内容（cards.cdb、script/、pics/、expansions/）。

## 6. 核心设计决策

1. **所有状态在服务器**（cube 后端），浏览器断线/刷新可随时恢复；后端事件日志 append-only，支持故障恢复与管理员时间回溯。
2. **鉴权三要素**：`tournamentId + playerId + token`。所有后端输入（REST/SSE/ws）都必须携带并校验；token 由服务器报名时签发，入 cookie 且支持手动输入。
3. **服务器不存储/传输原始卡图**：原图由前端配置本地 ygopro 路径读取 pics。例外：服务器保存**低清 avif 缩略图**（`assets/pics_avif/`，vips Q30/200px 批量生成），本地绑定失败时前端先 fallback 到 `GET /pics/:code.avif`，再尝试原图代理，最后空白卡。后端只下发卡牌 code 与卡面文本数据（从 cards.cdb 导入 SQLite）。
4. **协议兼容**：ygopro 协议 struct 只增不改；宿主二进制新增参数追加在 spawn 参数尾部；srvpro 仅在 cube 房间启用新参数。
5. **分支纪律**：ygopro/srvpro 均禁止直接改 master；各自新建特性分支开发适配（见 08-task-breakdown.md M0）。
6. **对局结果采集双通道**：srvpro webhook 主动推送（主）+ cube 轮询（兜底）。

## 7. 相关文档索引

| 文档 | 内容 |
|---|---|
| 02-codebase-analysis.md | ygopro / srvpro 现状勘察与扩展点 |
| 03-ygopro-modification-plan.md | 宿主二进制改动方案 |
| 04-srvpro-modification-plan.md | srvpro 改动方案 |
| 05-cube-backend-plan.md | cube 后端模块 + SQLite 设计 |
| 06-cube-frontend-plan.md | cube 前端页面与交互设计 |
| 07-protocol-api-design.md | 三侧接口/协议/鉴权详细定义 |
| 08-task-breakdown.md | 里程碑与任务拆分 |
