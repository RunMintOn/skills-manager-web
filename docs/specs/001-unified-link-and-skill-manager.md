# 统一链接与 Skill 管理器

状态：Draft（2026-08 修订：技术栈从 OpenTUI 改为 localhost Web + React；运行环境改为 WSL 原生）

## Problem Statement

开发者现在需要在命令行中手动处理两类工作：

1. 在 WSL 和 Windows 路径之间创建、扫描和删除链接。
2. 在只读 Vault 与多个 Agent Path 之间管理 Skill。

命令行操作有几个问题：

- WSL symlink、Windows Junction、Windows 路径和 WSL 路径的规则不同。
- 目标路径、Link Path、父目录和链接目标的状态需要人工确认。
- 递归扫描时难以快速识别正常链接、断链、普通目录和外部链接。
- Vault 中的 Collection、Loose Skill、Skill Directory 和 Agent actual 内容容易混淆。
- 同一个 Skill 可能存在多个来源，Skill ID 重复时需要消歧。
- Agent 中可能存在 repo-link、repo-copy、本地目录、外部链接、断链和无效 Skill。
- 人需要可操作的界面，Agent 和脚本需要稳定的 JSON CLI。

当前正式项目已经有 Skill 管理的扫描、比较和预览基础，但还缺少统一的通用链接工作台。产品需要统一两类工作流，并让 TUI 与 CLI 共用同一 TypeScript 领域层。

## Solution

构建一个使用 React、Vite 和 TypeScript 的本地 Web 应用。Node 服务运行于 WSL 原生环境，Windows 浏览器通过 localhost 访问。应用有两个顶层主导航：

1. **通用链接**：用于扫描和实际创建/删除链接。
2. **技能管理**：用于配置 Vault、管理 Agent Path、浏览 Repository、比较 Agent、查看 Agent actual，并生成 Skill 同步计划。

两部分共用一个链接服务和显式的 host adapter：

- WSL runtime 使用 WSL adapter。
- Windows runtime 使用 Windows adapter。
- Windows runtime 可以通过 `wsl.exe` 操作 WSL 路径。
- WSL runtime 可以处理 WSL 路径和 Windows 挂载路径；Windows 原生 Junction 需要 Windows adapter 或明确的 Windows bridge。
- 所有创建和删除操作都必须经过预检、用户确认和安全边界。
- 自动化测试只使用本项目 fixture 或系统临时目录。
- 扫描不会创建、删除或修改用户实际 Vault、Agent Path 或链接。

运行环境为 WSL 原生 Node 服务：直接处理 WSL 路径与 WSL symlink；Windows Junction 经系统互操作调用 Windows 侧命令完成（本机已验证 powershell.exe/cmd.exe 可用）。Windows 浏览器通过 WSL2 localhost 转发访问界面，无需打包。源码位于 WSL 原生 /home/lee/11MyProjrct/44-skills-manager-web，开发与运行使用同一份工作树，依赖只在 WSL 侧安装一份。

第一阶段交付真实的通用链接工作台，并保留技能管理的真实扫描、比较和同步预览。技能批量同步的实际执行复用同一链接服务，按后续切片接入。

## User Stories

### 通用链接

1. As a developer, I want to open a dedicated 通用链接 tab, so that I do not need to mix generic filesystem links with Skill management.
2. As a developer, I want to enter or paste a Link Target, so that I can choose the existing file or directory without typing a shell command.
3. As a developer, I want to enter or paste a Link Path, so that I can choose where the new link entry will appear.
4. As a developer, I want to choose a target file or directory with a path picker when the host supports it, so that path entry is less error-prone.
5. As a developer, I want the application to normalize WSL and Windows path representations, so that `C:\...`, `/mnt/c/...`, and WSL paths are not confused.
6. As a developer, I want the application to identify the host of each path explicitly, so that a path is not classified from an unsafe string heuristic alone.
7. As a developer, I want to create a WSL-to-WSL link, so that I can replace a manual `ln -s` command.
8. As a developer, I want to create a WSL-to-Windows link, so that I can place a WSL-created link in a Windows-mounted directory.
9. As a developer, I want to create a Windows-to-Windows link, so that I can create a native Windows directory Junction when both paths are Windows paths.
10. As a developer, I want to create a Windows-to-WSL link, so that a Windows target can be exposed in a WSL path when the selected adapter can safely convert both paths.
11. As a developer, I want the application to show the selected link strategy and host adapter before creation, so that I understand which runtime will execute the operation.
12. As a developer, I want a preflight check to verify that the Link Target exists, so that a new link does not point to an absent target.
13. As a developer, I want a preflight check to verify that the Link Path does not already exist as an entry, so that an existing file, directory, symlink, or Junction is never silently replaced.
14. As a developer, I want a preflight check to verify that the Link Path parent is a directory, so that a creation failure is explained before execution.
15. As a developer, I want to see a confirmation containing the exact target and link paths, so that a real filesystem change requires an intentional click.
16. As a developer, I want a successful creation message and a refreshed entry state, so that I can verify the link immediately.
17. As a developer, I want an actionable error when creation fails, so that I know whether the target, parent, permissions, host adapter, or existing entry caused the failure.
18. As a developer, I want to delete only a selected link entry, so that deleting a link never deletes its target contents.
19. As a developer, I want deletion to reject ordinary files and directories, so that the application cannot perform an accidental destructive delete.
20. As a developer, I want Junction deletion to remove only the Junction entry and not recursively delete the target directory, so that Windows link safety is explicit.
21. As a developer, I want to scan a selected directory without recursion, so that I can inspect only its direct children.
22. As a developer, I want to enable recursive scanning, so that I can inspect a complete directory tree.
23. As a developer, I want each scanned entry to show whether it is a file, directory, WSL symlink, Windows Junction, unsupported link, or other entry, so that filesystem state is understandable.
24. As a developer, I want each link entry to show its resolved or raw target, so that I can inspect where it points.
25. As a developer, I want each link entry to show `Exists` or `Broken`, so that broken links are easy to find.
26. As a developer, I want recursive scanning to avoid following links as directories, so that scanning does not loop through cycles or escape the managed scope.
27. As a developer, I want the scan to distinguish an unreadable path from an empty directory, so that an adapter failure is not presented as no entries.
28. As a developer, I want to save a frequently used path, so that I can reuse it without pasting it again.
29. As a developer, I want to edit and delete a saved common path, so that the list remains useful over time.
30. As a developer, I want to copy a common path, so that I can paste it into another tool.
31. As a developer, I want duplicate common paths to be rejected, so that the list stays unambiguous.
32. As a developer, I want unsupported host combinations to be blocked with a clear reason, so that the application never pretends an operation was executed.

### 技能管理配置与 Repository

33. As a developer, I want to configure one read-only Vault baseline path, so that the application has a central source of truth.
34. As a developer, I want the Vault host to be explicit, so that Windows and WSL path semantics are not mixed.
35. As a developer, I want to add an Agent Path with an ID, display name, host, and actual path, so that I can manage multiple consumers.
36. As a developer, I want to edit an Agent configuration item, so that a changed path or display name does not require editing raw JSON.
37. As a developer, I want to delete an Agent configuration item, so that obsolete consumers do not remain in the list.
38. As a developer, I want Agent configuration changes to modify only the application configuration, so that adding or deleting an Agent item never creates or deletes an actual directory.
39. As a developer, I want to refresh the Vault and Agent scans explicitly, so that external filesystem changes can be brought into the current view.
40. As a developer, I want the application to find every managed Skill Directory containing `SKILL.md` according to the selected scan policy, so that nested Collections are not missed.
41. As a developer, I want a nested Skill to be grouped by the first Vault-relative path segment, so that `engineering/tools/lint-helper` belongs to the `engineering` Collection.
42. As a developer, I want a Skill directly below the Vault root to appear under `Loose Skills`, so that it is not mistaken for a Collection.
43. As a developer, I want to see a Skill's Vault-relative path, so that nested source locations remain unambiguous.
44. As a developer, I want to see a Skill's directory name and declared `name`, so that identity problems are visible.
45. As a developer, I want a Skill whose directory name does not exactly match frontmatter `name` to be invalid, so that malformed Skills cannot be synchronized.
46. As a developer, I want a Skill with missing or malformed frontmatter to be invalid, so that incomplete metadata cannot be silently treated as healthy.
47. As a developer, I want duplicate Skill IDs to list all candidate source directories, so that I can resolve ambiguity instead of silently linking the wrong directory.
48. As a developer, I want the Repository view to show Collections, Loose Skills, valid Skills, invalid items, and duplicate IDs, so that I can audit the Vault without selecting an Agent.
49. As a developer, I want a validation summary in the top bar, so that the number of Vault issues is visible without opening a separate report.
50. As an Agent, I want the same Vault scan exposed through stable JSON, so that scripts can audit Skill integrity without using the TUI.

### 技能管理 Compare 与 Agent actual

51. As a developer, I want an Agent sidebar showing name, actual path, and issue count, so that I can choose a consumer and understand its health.
52. As a developer, I want the Compare view to be the default Skill management view, so that the common task is visible immediately.
53. As a developer, I want to compare the selected Agent Path with the Vault, so that I can see what is linked and what is missing.
54. As a developer, I want a valid Vault Skill with a matching repository link to show `已链接`, so that existing managed content is clear.
55. As a developer, I want a valid Vault Skill with no matching Agent entry to show `待链接`, so that missing content is actionable.
56. As a developer, I want a same-name real Agent directory to show `本地目录` or a more specific `repo-copy` classification, so that a copy is not mistaken for a link.
57. As a developer, I want a same-name Agent entry pointing outside the Vault to show `外部链接`, so that unmanaged sources are visible.
58. As a developer, I want a same-name broken Agent link to show `断链`, so that stale entries are visible.
59. As a developer, I want invalid Vault Skills and invalid Agent entries to show `无效`, so that they cannot enter a normal sync plan.
60. As a developer, I want Agent entries that do not correspond to a Vault Skill to appear in an Agent-only group, so that local content is not lost from the comparison.
61. As a developer, I want the Agent actual view to show only the selected Agent's actual entries, so that I can audit the consumer independently of the Vault.
62. As a developer, I want Agent actual entries to preserve their path, entry kind, target, and target status, so that a later action can be reviewed safely.
63. As a developer, I want `repo-link`, `repo-copy`, `local-dir`, `external-link`, `broken-link`, and invalid Skill states to remain distinct in the domain layer, so that UI labels do not collapse important safety information.
64. As a developer, I want the selected Skill detail to show Vault path, Collection, relative path, frontmatter, directory-name validation, Agent entry, planned Link Path, and all risks, so that I can make an informed decision.
65. As a developer, I want to search by Skill ID, frontmatter name, Collection, description, or relative path, so that large Vaults remain navigable.
66. As a developer, I want search to preserve Unicode text, so that non-ASCII Skill names and descriptions work.
67. As a developer, I want to select multiple Skills with Space, so that a sync preview can contain more than one operation.
68. As a developer, I want keyboard focus to move with Tab and Shift+Tab, so that every important action has a non-mouse path.
69. As a developer, I want arrow keys to move through Agent, Skill, and actual-entry lists, so that the TUI is usable without a mouse.
70. As a developer, I want Enter to activate the focused control and Esc to cancel or return, so that the main workflow is keyboard-complete.
71. As a developer, I want mouse clicks and scroll-wheel actions to work on lists, tabs, inputs, and buttons, so that the TUI is usable interactively.
72. As a developer, I want a sync preview to show one operation per selected Skill, so that no batch action is hidden behind an opaque command.
73. As a developer, I want a preview operation to show target path, flattened Link Path, link strategy, risks, and execution state, so that I can inspect it before confirmation.
74. As a developer, I want the preview to contain argv arrays or typed filesystem arguments rather than a shell command string, so that quoting and injection risks are explicit.
75. As a developer, I want a conflicting Agent entry to block or require an explicit resolution, so that a local directory or external link is never silently replaced.
76. As a developer, I want successful Skill synchronization to record the Source Collection in application state, so that flattening does not lose provenance.
77. As an Agent, I want `status --json` to expose the Vault, Agent entries, issues, and comparison in a stable schema, so that automation can consume it.
78. As an Agent, I want `plan --json` to expose selected Skill IDs, per-item operations, risks, and `not-run` execution state, so that automation can review a plan without executing it.
79. As an Agent, I want `config init --config <file>` to create a project-local or explicitly selected configuration, so that first use never reads or writes an implicit user-home configuration.

### 安全与运行环境

80. As a developer, I want real link creation and deletion to require an explicit button action and confirmation, so that scanning and viewing cannot mutate files.
81. As a developer, I want automated tests to create and clean temporary targets and links, so that tests never touch a user's Vault or Agent Path.
82. As a developer, I want a failed operation to report whether it was attempted and whether rollback occurred, so that the UI never claims success without evidence.
83. As a developer, I want the application to use argv or typed filesystem APIs with `shell: false`, so that paths containing spaces, Unicode, or shell metacharacters remain safe.
84. As a developer, I want Windows and WSL adapters to expose the same domain operations, so that TUI and CLI do not duplicate host-specific business logic.
85. As a developer, I want the same source tree to be runnable from WSL and Windows when it is stored on the shared Windows-mounted project path, so that native Windows acceptance does not require an UNC path or an ad-hoc copied worktree.
86. As a developer, I want the application to report an unavailable adapter instead of returning an empty scan, so that runtime limitations are not hidden.

## Implementation Decisions

### Product seams

The highest shared seam is a typed `LinkService`/host-adapter boundary. It owns path normalization, scan, preflight, create, delete, and common link safety. The TUI and CLI call this boundary rather than implementing filesystem behavior themselves.

The Skill management boundary consumes the same link and scan results. It adds Vault indexing, Skill validation, Agent classification, comparison, and preview planning. The TUI and CLI both consume a `WorkspaceSnapshot`-style domain result.

Tests should be placed at these seams:

- LinkService with temporary directories and real temporary links where the host supports them.
- Workspace comparison and plan generation with fixture Vault and Agent Paths.
- CLI process boundary for stable JSON.
- TUI startup and manual interaction at the rendering boundary.

### Host and path model

- `HostKind` is explicit: `wsl` or `windows`.
- A path has a host representation and is never treated as a generic string once an operation begins.
- Path storage location is separate from runtime host. Keeping the source tree on `/mnt/d` allows WSL and Windows to open the same worktree; it does not make a WSL process a Windows process.
- Windows runtime is the final primary acceptance target. WSL runtime remains a supported development and test target.
- WSL operations use argv-based WSL execution or direct WSL filesystem APIs where appropriate.
- Windows directory links use native Windows filesystem behavior and are restricted to directories when the operation is a Junction.
- Unsupported cross-host operations return a typed blocked result with an explanation. They are not represented as successful empty scans.

### Generic link model

The generic link domain uses these concepts:

- `Link Target`: an existing file or directory.
- `Link Path`: the new entry path.
- `EntryKind`: file, directory, WSL symlink, Windows Junction, unsupported link, or other.
- `TargetStatus`: not applicable, exists, or broken.
- `LinkSpec`: target plus link path.
- `LinkOperation`: typed WSL argv or typed Windows filesystem operation.

Creation preflight requires an existing target, an absent Link Path entry, and an existing parent directory. Deletion accepts only an identified link entry. Deletion never recursively follows a link target.

Generic scanning supports direct and recursive modes. Recursive scanning uses a no-follow traversal policy for link entries and reports unreadable or unsupported roots distinctly.

### Common paths

Common paths are application configuration data, not managed filesystem entries. Add, edit, delete, duplicate detection, and copy operations do not touch the referenced path. The current first-use configuration remains project-local or explicitly selected; there is no implicit user-home configuration.

### Vault model

- Vault is the read-only central repository.
- A Skill Directory is a directory containing `SKILL.md`.
- The frontmatter `name` is the Skill ID when present.
- The directory name must exactly equal `name`, including case.
- A direct child Skill of the Vault is a Loose Skill.
- Any nested Skill belongs to a Collection identified by the first Vault-relative path segment.
- Duplicate Skill IDs preserve all candidates and invalidate ambiguous synchronization.
- Invalid Skill entries remain visible in Repository and Compare views but cannot produce a normal create-link operation.

### Agent model

Each Agent has an ID, display name, host, and one Agent Path. The Agent scan distinguishes:

- `repo-link`: a link whose resolved target is a valid Skill inside the Vault.
- `repo-copy`: a real directory whose valid Skill metadata identifies a Vault Skill but is not a link.
- `local-dir`: a real directory not identified as a Vault copy.
- `external-link`: a live link whose target is outside the Vault.
- `broken-link`: a link whose target cannot be resolved.
- `invalid`: an entry or Skill that cannot pass the integrity rules.

The comparison layer maps these actual states to the user-facing states `已链接`, `待链接`, `本地目录`, `外部链接`, `断链`, and `无效`. Agent-only entries remain visible separately.

Skill link destinations are flattened directly under the Agent Path. Collection provenance is stored in application data and is not represented by nested Agent directories.

### Web UI and CLI

- 界面为 React 单页应用，两个顶层导航：通用链接 和 技能管理。
- 通用链接 owns create/delete/scan/common-path workflows。
- 技能管理 owns Vault configuration, Agent configuration, Repository, Compare, Agent actual, search, detail, and sync preview。
- 前端通过 localhost HTTP API 调用 Node 服务；Node 服务与 CLI 共享同一 domain 函数与类型化结果。
- 键盘可达性保留：Tab/Shift+Tab、方向键、Space、Enter、Esc 与鼠标点击、滚轮等价覆盖主要操作（按 Web 无障碍语义实现）。
- JSON schemas carry an explicit schema version and preview/execution state。
- Preview data never contains a shell command string。It contains argv arrays or typed filesystem arguments。
- Real execution is only reachable from an explicit confirmed action。Scan, status, and plan are read-only。

### Runtime and source layout

源码位于 WSL 原生 /home/lee/11MyProjrct/44-skills-manager-web。Node 服务进程在 WSL 内运行并监听 127.0.0.1:8787。Windows 浏览器通过 WSL2 localhost 转发访问。Windows 开始菜单快捷方式（.bat/.vbs）通过 wsl.exe 启动服务并自动打开浏览器。Junction 操作经系统互操作调用 Windows 侧命令。node_modules 与依赖只在 WSL 侧一份。

## Testing Decisions

- Tests assert external behavior at the highest available seam. They should not assert React component internals, private helper call counts, or shell command formatting beyond the typed safety contract.
- Generic LinkService tests use system temporary directories. They verify successful creation, target preservation after deletion, absent-target rejection, existing-Link-Path rejection, parent rejection, broken-link scan, recursive scan, and no-follow behavior.
- WSL tests run on the current WSL environment when available. Windows Junction lifecycle tests run only on a Windows environment that supports Junctions; a non-Windows environment tests the blocked adapter result instead of pretending success.
- Cross-host path tests verify conversion, host mismatch rejection, spaces, Unicode, drive paths, mounted paths, and traversal/invalid-segment rejection.
- Vault fixture tests cover nested Collections, Loose Skills, missing frontmatter/name, exact name mismatch, duplicate Skill IDs, and stable collection ordering.
- Agent fixture tests cover repo-link, repo-copy, local-dir, external-link, broken-link, invalid entries, Agent-only entries, and duplicate Agent entries.
- Comparison tests cover linked, pending, local, external, broken, invalid, conflict, and duplicate-source states.
- Plan tests verify one typed operation per selected Skill, flat Agent destination paths, no shell string, blocked conflicts, `not-run` execution state, and no filesystem mutation.
- CLI tests invoke the process and parse stdout as JSON. They verify stable top-level schema, status summaries, selected-agent comparison, plan operations, and explicit configuration paths.
- 前端组件测试覆盖三列布局、搜索、多选、视图切换与键盘可达性。视觉验收通过浏览器人工观察与截图对比；Windows 浏览器 + WSL 服务联调为手动验收项。
- All tests use project fixtures or temporary directories. No test reads or writes a user's actual Vault, Agent Path, home configuration, or link tree.

## Out of Scope

- Rust、Wry、Electron、Svelte、OpenTUI/Bun TUI、桌面 WebView 壳，以及非 localhost 的远程浏览器服务。
- Implicit discovery or mutation of user-home configuration during first use.
- Automatic filesystem changes caused by scanning, refresh, status, or plan commands.
- Shell command strings, `bash -c` construction from user path input, or unescaped path interpolation.
- Cloud synchronization, remote Vaults, multi-user permissions, or a background daemon.
- Automatic migration of arbitrary user directories without an explicit confirmation flow.
- Full YAML execution or arbitrary YAML tags in Skill frontmatter.
- Deleting a Vault entry as part of Agent synchronization.
- Treating a Windows Junction as an ordinary WSL symlink when the Windows adapter is unavailable.
- 在手动验收前声称 Windows 浏览器 + WSL 服务联调已通过。

## Further Notes

- The Rust project is a read-only behavioral reference for LinkEntry, TargetStatus, SkillLink, WSL/Windows backend separation, recursive scans, common paths, Vault indexing, and safe link deletion. Its Rust/Wry implementation is not the target implementation.
- The OpenTUI spike is a read-only capability reference for Bun startup, focus, keyboard, mouse, paste, and ScrollBox behavior. Its demo data and preview-only assumptions are not the final domain model.
- 实施基址为 /home/lee/11MyProjrct/44-skills-manager-web。领域模型沿用本 spec，可直接复用已验证 TypeScript core（来源：skill-manager-opentui-spike 与 skill-manager-opentui 的 src/core）。
- 已实测能力：WSL→WSL symlink、WSL→/mnt/c symlink、Windows 主机 wsl.exe 调用链、Windows Junction（Windows PowerShell 安全临时 smoke test）。WSL 内经互操作调用 Windows 命令建立 Junction 需在 Web 服务联调时复验。
- 尚未验收：Windows 浏览器经 WSL2 localhost 转发访问服务；三列界面的视觉与键盘手感。
- Issue-tracker publication is pending until `/setup-matt-pocock-skills` is completed.
