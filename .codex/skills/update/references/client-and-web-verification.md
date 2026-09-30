# 客户端、Web 与先行卡验收补充

GUI/容量变更、Web/本地图片行为变更或正式先行卡互通验收时，读取对应章节。

## GUI 客户端与 Windows 容量验收

需要 GUI 客户端时另外执行并验收：

```bash
bash scripts/update-card-resources.sh build --client
# 或按构建机依赖显式补齐 --build-freetype/--build-png/--build-jpeg/--build-opus-vorbis
```

这条命令默认是当前 WSL/Linux 工具链；Windows 客户端必须在
`C:\projects\ygopro` 的 Cube feature 分支使用现有 `premake5.exe` 与 VS2022
工作流构建。生成 VS2022 解决方案时不要传 `--no-audio`，确认 miniaudio/Ogg/
Opus/Vorbis 等实际链接到 Release 配置；用 PE 架构检查、依赖检查和启动 smoke
test 验证，而不是只看编译命令成功。若二进制明显小于已知成功产物、音频依赖未
解析或版本后缀丢失，立即停止，不把该客户端放入发布包。

#### Windows Cube 客户端容量参数验收

- Windows 完整客户端使用仓库的 `scripts/build-ygopro-client.ps1`，默认源码目录为相邻 `../ygopro`、分支为 `cube-server`，默认 extra/side 各 30；需要更大容量时显式传入 `-MaxExtra` / `-MaxSide`，与目标比赛约定一致。
- 每次构建必须重新生成 VS 工程，显式传 `--max-extra=30 --max-side=30`（或本次约定的容量）及完整音频参数。仅运行 MSBuild 会复用旧工程；`1.036.2-cube` 后缀只能证明代码版本，不能证明容量宏正确。
- 构建前核对 Release|x64 的 `YGOPRO_MAX_EXTRA`、`YGOPRO_MAX_SIDE` 和音频宏，缺项直接失败。未传容量参数时源码默认 15，会导致组卡/普通加载截断；Cube 推送后保存并重新加载也经过这条路径。
- 用超出 15 张的真实 YDK 在本次生成的 exe 内打开，核验界面 main/extra/side 实际数量。2026-09-10 回归夹具为 40/30/30；记录新 exe 路径、SHA-256 和实际运行验证，不把头文件常量或项目配置单独当作二进制验收。


## 先行卡发布后补充验收

- 两套服务分别访问公网实际搜索路由及 Cube `/api/pics/<code>.avif`、独立 Duel
  `/duel-api/pics/<code>.avif`，检查 MIME 和实体内容；
  页面 200、文件存在、staging 测试通过均不代表生产已生效。
- 用先行卡进入实际房间、准备并完成比赛；验证 BO3 换备和重连。独立 Duel 还需
  测试网页建房→原生客户端加入、原生建房→网页加入两个方向。
- 至少执行一个先行卡效果，覆盖召唤/发动、卡组选择、连锁处理/送墓等实际
  ocgcore 链路。全量元数据检查不等于逐一卡片效果实现均通过，应明确样例范围。
- 可用隔离探针：`EXPANSION_CODE=<code> STANDALONE_ONLY=1 STANDALONE_MATCH=1
  /usr/bin/node scripts/e2e/web-duel-smoke.cjs`；本轮 `EXPANSION_EFFECT=1` 使用
  固定的「优秀精灵」与装备卡夹具。测试必须在独立目录/数据库/房间执行。
- 若 WebSocket 反复连接，检查实际关闭码和 srvpro 日志。曾遇到代理统一使用
  loopback 后被全局 `BAD IP` 封禁；不要用关闭超时/取消所有协议检查来掩盖问题。
- Git 提交前检查根仓库和 submodule 的全部差异、运行时资源及敏感信息。
  已授权跨轮开发一起归档时可拆分提交；先推 fork 的特性分支再更新根 gitlink，
  不得把 srvpro/ygopro 推向 mycard 的 upstream origin。推送后核对远端 SHA。


## Web 样式与本地卡图验收补充

- Next build 的启动目录会影响 Tailwind 的默认配置查找与 content 扫描。PostCSS
  必须显式定位应用的 Tailwind 配置，content 使用相对配置文件的路径；从仓库根目录
  构建也要跑测试。不得把“编译成功、CSS 200”当作完整样式生成的证明。
- 部署校验除 MIME 外，还要验证生成 CSS 含关键布局与主题工具类；真实浏览器检查
  grid 的 display、间距和主题颜色，并截图检查首页、后台、Duel、构筑页的桌面/手机布局。
- 本地图片测试需覆盖实际用户提供的编号/图片，损坏但非空的 JPG、可用 PNG 回退、
  根目录绑定以及刷新恢复。图片存在但不能解码时，继续尝试其他本地候选或服务器低清图。
- 真实外部目录和 OPFS 测试的权限行为不同；OPFS 通过不能证明用户原有授权仍有效。
  提供显式重新读取/更换目录入口，强制重新检查授权与刷新缓存，不要静默停留在坏图上。
