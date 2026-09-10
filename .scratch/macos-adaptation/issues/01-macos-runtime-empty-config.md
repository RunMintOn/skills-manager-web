# 01: Mac 基础运行与空配置

**What to build:** Mac 上可以启动 Localhost Web。应用进入 Mac 工作区，只显示技能管理和通用链接。首次运行显示空配置。用户可以保存 Mac Vault 和 Agent 路径。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 应用在 macOS 上使用 `macos` Host 处理本地绝对路径。
- [x] 首次运行显示空配置，不读取旧 WSL 配置，不扫描 home 目录，不展示 fixtures 作为真实数据。
- [x] Mac 工作区只显示技能管理和通用链接入口。
- [x] 旧 WSL/Windows 工作区代码保留，但 Mac 用户没有入口。
- [x] 用户可以保存 Mac Vault 和 Agent 配置。
- [x] Localhost Web 可以通过现有启动方式运行。

## Comments

- 2026-09-10：完成 Mac Host、空配置加载、旧配置隔离、Mac 导航限制和配置保存。
- 2026-09-10：新增 `npm run test:macos`；Mac 专用测试 9/9 通过。Windows 专用测试仍由旧 `npm test` 保留，当前在 macOS 上有 3 个 `powershell.exe` 缺失失败。
- 2026-09-10：采用简化实现：增加 `runtimeHost()` 和 Mac 配置分支，不引入 Workspace Profile、capabilities 注册表或第二套 Mac 配置结构。
