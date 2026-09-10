# 02: Mac Skill 工作区

**What to build:** 用户可以复用现有 Skill 工作台扫描 Mac Vault，查看 Collection、Skill 和 Agent 对比，搜索和选择 Skill，生成同步预览，并创建本地 Skill 符号链接。

**Blocked by:** 01: Mac 基础运行与内置 Agent 路径

**Status:** done

- [x] Mac Vault 可以递归扫描并识别 Collection、Loose Skill、frontmatter 和有效性。
- [x] Mac Agent 可以显示已链接、待链接、本地目录、外部链接、断链和无效状态。
- [x] 用户可以在 Mac 工作区搜索、选择 Skill，并查看详情。
- [x] 同步预览显示目标、扁平链接路径、风险和执行状态。
- [x] 用户确认后可以创建缺失的 Mac 本地 Skill 符号链接。
- [x] Vault 保持只读，冲突条目不会被覆盖。
- [x] 现有 Skill 工作台和领域核心得到复用，不复制一套前端。

实现约束：

- 使用 Ticket 01 已保存的 `macos` Host 配置。
- 只增加共享扫描、比较、计划和本地链接适配所需的 Mac 分支。
- 不增加 Workspace Profile，不复制 Mac 前端，不接入镜像同步或跨环境操作。
- 新增测试放入 `npm run test:macos`，不得调用 `powershell.exe`、`wsl.exe` 或 Windows Junction。

## Comments

- 2026-09-10：完成 Mac Vault/Agent 扫描、比较状态、Skill 预览和 `macos-symlink` 创建。
- 2026-09-10：EGO 浏览器验收通过临时 Vault/Agent 配置、7 个 Skill 扫描、Skill 链接预览和确认创建。
