# 04: Mac 测试与验收收口

**What to build:** Mac 测试独立运行，不调用 Windows 能力。typecheck、build、Mac 测试、Localhost 启动和临时目录链接流程全部通过。旧代码和 Mac 使用说明保持清晰。

**Blocked by:** 02: Mac Skill 工作区; 03: Mac 通用链接工作区

**Status:** done

- [x] Mac 测试命令不调用 `powershell.exe`、`wsl.exe`、Windows Junction 或镜像同步。
- [x] Windows 专用测试保留在独立命令或环境中。
- [x] 自动化测试只使用 fixtures 或系统临时目录。
- [x] `npm run typecheck` 通过。
- [x] `npm run build` 通过。
- [x] Localhost 服务可以启动并返回 Mac 工作区的空配置状态。
- [x] 临时目录完成一次 Skill 链接和通用链接的创建、扫描、删除流程。
- [x] README 说明 Mac 启动、配置和当前不支持的能力。

实现约束：

- 使用 Ticket 01 已建立的 `npm run test:macos`，不再设计新的通用测试框架。
- `npm test` 保留旧测试覆盖；macOS 验收以 `npm run test:macos` 为准。
- 只验证真实 localhost 服务和临时目录，不读取用户 home，不使用真实 Vault 或 Agent 路径。

## Comments

- 2026-09-10：`npm run test:macos` 13/13 通过；`npm run typecheck` 和 `npm run build` 通过。
- 2026-09-10：完整 `npm test` 为 36 个通过、3 个失败；失败均为旧 Windows 测试缺少 `powershell.exe`，没有新增 Mac 失败。
- 2026-09-10：完成真实 localhost、CLI Mac status/plan 和 EGO 浏览器临时目录验收。
