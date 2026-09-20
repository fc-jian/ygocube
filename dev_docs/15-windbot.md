# WindBot 独立对战

入口 `/duel/bot/`，选择机器人与昵称后自动生成独立房间。玩家首先入房成为房主，然后 API 启动原生 WindBot 作为第二位玩家。入房后选择自己的卡组，准备并开始。首版固定单局、无限制禁限卡表，正常校验卡组张数；青眼、黑魔术师、幻变骚灵与效果伤害四套上游卡组可选。

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

不开放 WindBot 自带 HTTP ServerMode；API 直接使用无 shell 的参数数组启动固定程序，Host/Port/密码由服务端决定。默认最多 4 个进程，建房全局冷却 3 秒；同房重连不重复创建。玩家离线保留 30 分钟，单进程最多 2 小时，API 停止时回收子进程。机器人继承独立 Duel 服务的普通用户权限及 systemd 生命周期，不接入 Cube srvpro。

## 验收与发布

- 单元测试：`cube/apps/api/test/windbot.spec.ts`；真实浏览器：`scripts/e2e/windbot-browser.cjs BASE YDK BOT_ID`，确认自动入房、准备、出牌及结算。
- Linux 产物不得混入 Windows 依赖。应用按 `scripts/deploy-card-details.py` 校验包、备份、原子切换；首次启用可指定 `--windbot-root /opt/ygoduel/windbot/7acd93d`，失败恢复配置和旧应用。已经存在配置时应显式更新，不追加重复键。
- 首次部署机器人运行时和数据库先安装到版本目录、验证哈希并以生产用户做加载检查，再激活应用。服务不会因为仅安装未启用的运行时而重启。
- 生产验证 `/duel/bot/`、其静态 JS/CSS MIME、机器人实际出牌和胜负结算、进程清理，确认 Cube 的 bot API disabled。
- 上游 AI 并不保证每套卡组最优决策；本入口仅开放已验证卡组，不提供任意上传 AI 脚本或进程参数。
