# 01: Mac 基础运行与内置 Agent 路径

**What to build:** Mac 上可以启动 Localhost Web。应用进入 Mac 工作区，只显示技能管理和通用链接。首次运行不加载旧配置和 fixtures，预置三个 `$HOME` Agent 路径，Vault 保持未配置。用户可以保存 Mac Vault 路径。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 应用在 macOS 上使用 `macos` Host 处理本地绝对路径。
- [x] 首次运行显示未配置 Vault 和三个内置 Agent 路径，不读取旧 WSL 配置，不扫描未列出的 home 路径，不展示 fixtures 作为真实数据。
- [x] Mac 工作区只显示技能管理和通用链接入口。
- [x] 旧 WSL/Windows 工作区代码保留，但 Mac 用户没有入口。
- [x] 用户可以保存 Mac Vault 配置；内置 Agent 路径使用 `$HOME/...` 表达式保存。
- [x] Localhost Web 可以通过现有启动方式运行。

## Comments

- 2026-09-10：完成 Mac Host、默认配置加载、旧配置隔离、Mac 导航限制和配置保存。
- 2026-09-10：新增 `npm run test:macos`；Mac 专用测试 14/14 通过。Windows 专用测试仍由旧 `npm test` 保留，当前在 macOS 上有 3 个 `powershell.exe` 缺失失败。
- 2026-09-10：采用简化实现：增加 `runtimeHost()` 和 Mac 配置分支，不引入 Workspace Profile、capabilities 注册表或第二套 Mac 配置结构。
- 2026-09-10：补充三个内置 Agent 路径：`$HOME/.codex/skills`、`$HOME/.pi/agent/skills`、`$HOME/.agents/skills`。运行时展开，配置不写入具体用户名路径。
