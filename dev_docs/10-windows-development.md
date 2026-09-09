# Windows / Linux 开发环境

## Windows 原生开发

Windows 工作目录为 `C:\projects\ygocube`。源码、Git 历史、递归子模块、卡片资源和本地数据已从 WSL 复制；`node_modules`、Python 环境和宿主可执行文件在 Windows 重新安装或编译。不要复制 Linux 的依赖目录或二进制到 Windows，也不要将 Windows 生成物部署到 Linux。

依赖：Windows x64、Node.js 22、Git、Python 3、Visual Studio 2022 的 C++ 桌面开发组件和 Windows 10/11 SDK。首次安装：

```powershell
cd C:\projects\ygocube
.\scripts\setup-windows.ps1 -Python '你的 Python 可执行文件路径'
. .\scripts\activate-windows.ps1
```

安装器在 `envs/windows` 放置 pnpm 11.20.0、Python 虚拟环境、libvips，以及宿主编译依赖；C++ 和 libvips 下载使用固定版本和 SHA-256 校验。构建使用现有 `cube-server`、`cube` 子模块源码，不替换其业务逻辑。已有依赖时可以单独运行 `scripts/build-ygopro.ps1 -SkipDownload`。

统一配置仍为根目录 `config.yaml`，可用 `CONFIG_FILE` 覆盖。相对路径以配置文件位置为准。卡片资源仍需按 `config.example.yaml` 提供。

本次迁移使用 SQLite backup API 将 WSL 数据库制作成 `data/cube.windows.sqlite`，完成 `integrity_check` 后将 Windows 的 `config.yaml` 指向该快照。原始数据库及 WAL、WSL 原目录均保留；它们与 Windows 快照不会自动双向同步。

## 启动与停止

```powershell
.\scripts\dev-windows.ps1                   # Cube: http://127.0.0.1:3200
.\scripts\dev-windows.ps1 -Duel             # Duel: http://127.0.0.1:3100/duel
.\scripts\dev-windows.ps1 -Action Status
.\scripts\dev-windows.ps1 -Duel -Action Status
.\scripts\dev-windows.ps1 -Action Stop
.\scripts\dev-windows.ps1 -Duel -Action Stop
```

Windows Cube 默认使用 3200，避免本机 3000 无法绑定的问题；可用 `-Port 3000` 指定其他可用端口，API 使用 Web 端口加一。启动器拒绝占用已有端口，只停止经过进程归属检查的本项目服务。

| 项目 | Cube | 独立 Duel |
|---|---|---|
| Web / API | 3200 / 3201 | 3100 / 3101 |
| srvpro TCP / HTTP | 7911 / 7922 | 17911 / 17922 |
| Next 开发输出 | `.next-cube` | `.next-duel` |
| 数据库 | 根配置中的迁移快照 | `data/local-dev/duel/duel.sqlite` |
| 日志与生成配置 | `data/local-dev/cube` | `data/local-dev/duel` |

本地启动器仅监听回环地址，生成的本地配置允许开发占位 token。生产配置不被改写。Cube 保持原生客户端流程，独立 Duel 单独启用网页入口；原生客户端可连接 `127.0.0.1:17911`。

也可前台运行 `node scripts/dev-local.cjs` 或 `node scripts/dev-local.cjs --duel`，Ctrl+C 停止子进程。Linux 上此入口默认使用 Cube 3000 / API 3001；现有 `pnpm --dir cube dev` 和 Bash 启动入口继续可用。

## 构建与验证

```powershell
. .\scripts\activate-windows.ps1
pnpm --dir cube build
pnpm --dir cube test
npm --prefix srvpro run build
npm --prefix srvpro test
python -m unittest discover -s scripts -p test_card_resources.py
node scripts/e2e/web-duel-smoke.cjs
$env:STANDALONE_ONLY='1'
$env:EXPANSION_CODE='100267021'
node scripts/e2e/web-duel-smoke.cjs
Remove-Item Env:STANDALONE_ONLY, Env:EXPANSION_CODE
```

浏览器测试使用 `PLAYWRIGHT_MODULE_PATH` 指定 Playwright 包、`CHROMIUM_PATH` 指定 Windows Chrome/Edge。输出使用系统临时目录。`standalone-browser.cjs` 测试两个真实浏览器玩家；`standalone-interop.cjs` 测试网页先建房和原生 TCP 先建房两个方向。测试使用独立数据库与随机端口，结束后清理自己创建的进程树。

Windows 无文件符号链接权限时，资源测试中仅该权限相关用例明确 skip；SQLite、先行卡和 AVIF 用例必须正常通过。同一套资源测试在 Linux 完整执行。

## Linux / Aly 发布兼容

- Linux 默认 `output: standalone`，postbuild 继续复制 `.next/static` 和 `public`；Windows 默认标准 Next 构建，以 `next start` 运行，不要求管理员符号链接权限。`NEXT_STANDALONE=1` 可在具备权限的 Windows 上显式启用 standalone，`NEXT_STANDALONE=0` 显式关闭。
- Linux 发布必须在 Linux 构建宿主、原生 Node 依赖和 Next 产物。现有 `scripts/build-ygopro.sh`、`scripts/update-card-resources.sh` 与 Aly 发布脚本保留。Windows 本地开发不需要启动 WSL；WSL 可以作为额外的 Linux 回归及发布构建环境。
- srvpro 的 CoffeeScript 构建改用 Node 枚举源文件，Windows 和 Linux 共用，避免 shell 通配符差异。宿主启动按平台选择 `ygopro.exe` 或 `ygopro`。
- 宿主结束前检查待发送缓冲，至少等待 50ms、最长 1s，使最后胜负消息得以发送；避免 Windows 上过早退出导致一端丢失最终结果。协议格式不变。
- SQLite 资源读取及测试显式关闭连接，避免 Windows 文件锁，也减少 Linux 句柄占用。
- Git 对脚本固定 LF；禁止将 Windows `node_modules`、`.next*`、`envs/windows` 或 `.exe` 打入 Aly Linux 发布包。

## 本次验收记录（2026-09-09）

- Windows API 205 项、协议 30 项以及前端测试通过；srvpro 测试通过。
- Windows 真实宿主 Cube BO3、重连、独立 Duel 与先行卡通过。
- Windows 双向原生／网页互通连续三轮通过，共 6 场 BO3、12 局，覆盖换备与房间邀请。
- Windows Edge 390 / 1440 宽度布局、真实网页对战、卡组 cookie、旁观／重连及先行卡 100267021 的图片读取／刷新通过。
- Windows 资源处理 16 项：15 通过、1 项因文件符号链接权限 skip；Linux 执行全部 16 项。
- WSL 单元测试、资源维护测试、Linux 宿主和 standalone 前端构建回归通过；Aly 线上服务不在本次迁移中重启或发布。
