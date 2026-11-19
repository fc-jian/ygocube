---
name: ygocube-games
description: 在 YGO Cube 仓库新增网页小游戏或维护 /games/guess 时使用。沿用项目的界面风格、共享卡库和检索、房间状态与权限设计，以及 Windows 本地验证和 Aly 应用发布约定。
---

# YGO Cube 小游戏开发

以 Guess the Card 为已有实现。新增游戏通常挂在 `/games/<slug>`，在首页提供入口，随 Cube 的 Web/API 运行。独立 Duel 属于另一个发布实例。

## 开始工作

1. 先读根目录约定。涉及 HTTP 请求、返回字段、权限或房间阶段时，先更新接口契约，再同步共享 TypeScript 类型及前后端。Guess 的现行规则见契约 §2.6。[AGENTS.md](../../../AGENTS.md) · [接口契约](../../../dev_docs/07-protocol-api-design.md)
2. 前端使用 `cube/apps/web` 的 Next.js App Router、React、TypeScript 和 Tailwind。路由放在 `app/games/<slug>/`，交互组件放在 `components/<slug>/`。客户端通过 `lib/api.ts` 请求同源 API。后端使用 `cube/apps/api` 的 NestJS，在 `src/<slug>/` 放控制器和服务并注册到 `AppModule`。跨端类型放在 `cube/packages/shared`。[Guess 路由](../../../cube/apps/web/app/games/guess) · [Nest 注册](../../../cube/apps/api/src/app.module.ts) · [共享契约](../../../cube/packages/shared/src/index.ts)
3. 卡牌读取、检索、卡图和详情复用现有组件与服务。房间、游戏专用卡池及统计用各自的表名保存在 Cube 的应用 SQLite 库。多人游戏由服务端判断权限、行动和结算，对玩家、观战者分别返回可见字段。
4. 默认在本地实现和验证。按本次授权确定 Aly 发布、现有对局结算和线上测试的范围。涉及上游卡库、先行卡、图片资源或宿主时，改走仓库的资源维护流程。[update 技能](../update/SKILL.md)

## 按任务查阅

- 界面、文案、交互和共享卡牌组件，读 [UI 与交互](references/ui.md)。
- 卡片编号、游戏数据、房间权限和已有 Guess 规则，读 [卡库与房间数据](references/data.md)。
- 端口、配置、启动、回归和 Aly 路径，读 [运行与发布](references/runtime.md)。

## 验证变更

- 新游戏先验证正常入口和一局完整流程。多人玩法用独立浏览器会话核对各身份可见内容、重新进入及结算。
- 修改已有游戏时，覆盖受影响的房间阶段、旧房间数据或查询参数。共享检索改动同时验证 Guess 的卡池与局内，以及独立 Duel 的 `/duel/decks`。
- 应用变更按仓库约定在 Windows 和 Linux 回归。纯文档或技能改动校验文件结构、链接及与现行代码的一致性。
