# 分支与发布整理（2026-09-15）

## 发布前核对

main=7ae3200，当前开发分支 codex/card-resource-sync-deploy=bd567cd。codex/final-hardening 已包含在当前 HEAD，没有独有提交。

Aly Cube 为 20260909-web-layout-pics-r12，COMMIT 仍为 7ae3200，但已叠加 API/Web 补丁；独立 Duel 为 20260910-duel-room-information-r14，sourceCommit=bd567cd 且 workingTreeChanges=true。因此发布前 main 与线上实际代码不完全一致。

Windows 既有 Duel 房间选卡组、交互与 Windows 客户端脚本改动纳入本次可追溯版本，不丢弃。WSL 有独立未提交改动，保持原样；Linux 构建在 .card-resource-sync/details-build-20260915 隔离目录。

## 合并与清理方案

1. srvpro 只提交 cube 特性分支，推送目标必须是 fc-jian/srvpro 的 cube，禁止推 upstream。
2. 根仓库保留原提交的 archive/20260915-* 标签；main fast-forward 合并验证后的开发提交。
3. 根仓库仅保留 main、codex/duel、codex/cube 三个分支，删除已归档且已合并的 final-hardening 与 card-resource-sync-deploy；子模块特性分支不受此清理影响。
4. 普通 push，禁止 force push；GitHub 推送需要本轮自动审批要求的明确远端授权。
5. 两套 Aly 应用由同一 main 提交构建，分别采用 Cube 默认路径与 Duel /duel-api、/duel-assets。release.json 和 COMMIT 记录同一来源提交及各自 build ID。

## 验收与发布

Windows/Linux API 各 211 项、协议 31 项、Web 29 项通过；srvpro 编译及新旧测试通过。1440/390 真实浏览器完整详情、字段、同名卡名、禁限切换与角标、无横向溢出通过；Windows 隔离真实宿主 BO3 与重连通过。

scripts/deploy-card-details.py 校验归档和逐文件哈希，准备独立 release；激活前确认无活动宿主，备份 SQLite 并检查完整性，原子切换并重启两套应用，检查 API、HTTPS 页面及引用静态资源 MIME。失败切回旧 release，保留备份；Nginx 与宿主二进制、卡片资源不变。
