# WindBot 独立对战

入口 `/duel/bot/`，选择机器人与昵称后自动生成独立房间。玩家首先入房成为房主，然后 API 启动原生 WindBot 作为第二位玩家。入房后选择自己的卡组，准备并开始。固定单局、无限制禁限卡表，正常校验卡组张数。页面使用“机器人 → 机器人卡组”双层下拉框，按上游角色配置提供 24 个分组、70 套随包卡组；切换角色时重置为该角色的首套卡组。

## 构建与配置

源仓库 https://github.com/IceYGO/windbot ，锁定 `7acd93d654834343fd06e5e8460549bb74c14763`（MIT）。不得使用未审核的浮动最新二进制。Linux 使用 Mono 构建与独立打包的运行时：

```bash
python3 scripts/windbot/mono-compat.py /path/to/windbot
cd /path/to/windbot && xbuild /p:Configuration=Release WindBot.csproj
bash /path/to/ygocube/scripts/windbot/package-mono.sh /path/to/windbot /path/to/output
python3 scripts/windbot/prepare-database.py /path/to/ygopro/cards.cdb /path/to/output/cards.cdb /path/to/output/Decks
```

兼容补丁仅把上游两处列表元素的元组交换改成临时变量交换，不改变 AI 逻辑。Mono 运行时打包包含许可文件。Windows 使用 .NET Framework 4.8；若用 Mono 交叉构建，需要将上游 `ThirdParty/sqlite/{x64,x86}` 复制至输出根目录同名子目录。

根 `config.yaml` 的 `windbot` 配置见示例。所有路径相对配置文件，生产只在 `/opt/ygoduel/shared/config.yaml` 启用。WindBot CDB 由正式 CDB 加按名称排序的 expansion CDB 合并，后加载覆盖同号；不改原资源。以后卡库更新须重新生成并核验此派生文件。

不开放 WindBot 自带 HTTP ServerMode；API 直接使用无 shell 的参数数组启动固定程序，Host/Port/密码由服务端决定。默认最多 4 个进程，建房全局冷却 3 秒；同房重连不重复创建。机器人对战不限时，玩家 WebSocket 断连后立即关闭房间、宿主与机器人；连接接管除外，API 停止时回收子进程。机器人继承独立 Duel 服务的普通用户权限及 systemd 生命周期，不接入 Cube srvpro。

## 验收与发布

- 单元测试：`cube/apps/api/test/windbot.spec.ts`；真实浏览器：`scripts/e2e/windbot-browser.cjs BASE YDK BOT_ID`，确认自动入房、准备、出牌及结算。
- Linux 产物不得混入 Windows 依赖。应用按 `scripts/deploy-card-details.py` 校验包、备份、原子切换；首次启用可指定 `--windbot-root /opt/ygoduel/windbot/7acd93d`，失败恢复配置和旧应用。已经存在配置时应显式更新，不追加重复键。
- 首次部署机器人运行时和数据库先安装到版本目录、验证哈希并以生产用户做加载检查，再激活应用。服务不会因为仅安装未启用的运行时而重启。
- 生产验证 `/duel/bot/`、其静态 JS/CSS MIME、机器人实际出牌和胜负结算、进程清理，确认 Cube 的 bot API disabled。
- 上游 AI 并不保证每套卡组最优决策；本入口仅开放已验证卡组，不提供任意上传 AI 脚本或进程参数。

## 2026-09-20 Aly 发布记录

- 应用版本：`20260920-native-windbot-r22`；应用源码 `3394103364e1ab8a2fd7f20f47d447461b3b4261`，分支 `codex/cube` 已推送。
- 应用包 SHA-256：`a675ec36d4cb1950acfd3ecafd855967ddaa216365cdd6282826de152f18139b`。
- Cube build ID：`vgTPGgsEp4b2S1_Ie_ts2`；Duel build ID：`OTE9NfqDvpA0KDE524ZLv`。
- WindBot：`/opt/ygoduel/windbot/7acd93d`；运行时包 SHA-256 `c159fad6e597768d7043e9a44aa98fd6b7b8ade384a323c467c73818b3a3ac44`；exe SHA-256 `5f6068eb8a133420a8c9bc602447ae55657243cbfe019a1ced838539286eef09`；合并 CDB SHA-256 `0156138e1c0b429f6253c52d7a8ed43d274a2d2a08656fe9ac14bed9d4553405`。
- 备份分别在两实例的 `backups/20260920-native-windbot-r22/`，包含旧版本路径、配置、SQLite 备份、验收 JSON；上一正式版本为 `20260919-artwork-loading-r20`。
- Linux：228 项 API、46 项 Web、41 项协议测试通过，两套 Next standalone 与 API 构建通过；Windows：构建、20 项 Duel/Bot API 测试和网页／协议测试通过。
- 本地与公网均验证四套机器人：选机器人、自动建房、卡组上传、准备、猜拳、实际出牌／效果、投降结算。另在本地黑魔术师完成玩家 LP 归零结算。公网桌面 1440 和竖屏 390 无横向溢出或页面异常。
- HTTPS 首页、Duel、组卡、机器人页及所引用静态 JS/CSS 的状态和 MIME 正常；七个服务均 active；两个实例的原生宿主和正式 CDB 哈希保持不变；Cube 的 bot API 为 disabled，Duel 返回四套可选 bot。验收结束未残留 WindBot 或 ygopro 对局宿主；本地测试服务已关闭。
- 首次 r21 尝试因把 block YAML 追加到 JSON 格式的 `config.yaml` 导致启动校验失败，自动回滚到 r20。r22 改为停服前解析完整配置、再序列化为 JSON（合法 YAML），已通过。后续发布不得对配置盲目追加文本。


## 完整机器人目录

`scripts/windbot/generate-catalog.py SOURCE OUTPUT` 从锁定版本的 `BotWrapper/bot.conf`、Executor 的 Deck 声明及 Dialog 文件生成 `cube/apps/api/src/duel/bot-catalog.ts`。优先保持上游机器人名称、卡组名、说明与 Dialog 对应关系；未写入 bot.conf 但有实体 YDK 的 9 套卡组归入“默认机器人”。后台只接受目录内 Deck ID，固定传入 Name 和 Dialog；旧版四个 Deck ID 保持兼容。

上游 72 个 Executor 中，Test 与 Lucky 指向未提供的 AI_Test.ydk；P2 是需要用户另选卡组的包装器入口，不能作为随包预设直接开局。随机难度条目是包装器的选牌策略，不是额外的 AI 卡组。此目录覆盖全部 70 套实际附带卡组，不把这些占位条目伪装成可用预设。

更新目录后必须用 `scripts/e2e/windbot-catalog.cjs RUNTIME CDB CATALOG_JSON` 对实际生产运行时逐项检查角色、台词加载、协议握手、提交卡组与自动准备；`scripts/e2e/windbot-selection.cjs BASE` 检查两层下拉框所有分组与切换重置、桌面和移动布局。数据库生成器也须遍历全部 YDK 校验卡号。

### r23 完整目录发布

独立 Duel 已于 2026-09-20 更新到 `20260920-windbot-catalog-r23`，应用源码 `518b974b8e367d40f7d4f1097998f83e065bdd08`（已推送）。Build ID：`uG1clXg_wlKia4PNpi-S6`；应用包 SHA-256：`8a451a529e350f6f1d67867f3bb90968f1da8093762be4bee48583539de84141`。Cube 仍为 r22，服务 PID 与启动时间未变；WindBot 二进制、卡库、srvpro 代码均未修改。

70 套配置逐一通过 Aly 实际运行时的 Name/Dialog 加载、提交卡组与自动准备检查；全部卡号存在。Windows／Linux API 测试各 21 项及生产构建通过。公网桌面 1440、竖屏 390 的 24 个分组和全部 70 个选项、切换重置、页面资源检查通过；“尼亚 / 拉比林斯迷宫”真实效果、连锁与投降结算通过。完整握手日志、JSON 验收结果和发布备份位于 `/opt/ygoduel/backups/20260920-windbot-catalog-r23/`。本地测试服务已关闭。
