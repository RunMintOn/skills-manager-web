# macOS 本地工作区适配规格

## Problem Statement

当前项目面向 WSL/Windows 运行。用户现在要在当前 Mac 上运行同一个工具，管理 Mac 本地的 Skill Vault、Agent 和文件系统链接。旧配置包含原机器路径，不能直接迁移。Mac 用户也不需要远程管理、跨环境链接或镜像同步。

## Solution

在同一个代码库和 Localhost Web 应用中增加 macOS 本地工作区。应用在 macOS 运行时进入 Mac 工作区，只展示技能管理和通用链接。旧 WSL/Windows 代码保留在代码库中，但 Mac 用户没有入口。

Mac 工作区使用独立的 `macos` Host。Vault、Agent、链接目标和链接路径都必须属于当前 Mac。现有 React 页面、工作台、领域核心和 API 尽量复用，只隔离必要的 Host 适配和 Mac 入口。

首次运行显示空配置。用户填写 Mac Vault 和 Agent 路径后，应用才扫描真实目录。启动方式保持 `npm start` 和 `localhost:8787`。

实现保持直接：当前只增加一个运行时 Host 判断和 Mac 配置分支。不引入通用 Workspace Profile、通用 capabilities 系统或第二套 Mac 配置结构。

## User Stories

1. As a Mac user, I want to start the manager locally, so that I can manage local Skills without WSL.
2. As a Mac user, I want the application to enter the Mac workspace automatically, so that I do not need to choose an incompatible legacy environment.
3. As a Mac user, I want to see only Skill management and generic links, so that cross-environment controls do not distract me.
4. As a Mac user, I want the legacy WSL/Windows workspace to have no Mac entry point, so that I cannot trigger an unsupported operation.
5. As a first-time user, I want to see an empty configuration state, so that old machine paths and demo data are not treated as my real workspace.
6. As a Mac user, I want to configure one local read-only Vault path, so that the application has a clear source of truth.
7. As a Mac user, I want to configure multiple local Agent paths, so that I can compare the same Vault with different consumers.
8. As a Mac user, I want the application to validate that configured paths use the macOS path format, so that invalid paths fail before scanning.
9. As a Mac user, I want the Vault scan to find nested Skill directories and Loose Skills, so that the existing repository structure remains usable.
10. As a Mac user, I want frontmatter and directory-name validation to remain visible, so that invalid Skills cannot enter a sync plan.
11. As a Mac user, I want to compare a local Agent with the local Vault, so that linked, pending, copied, local, external, broken, and invalid entries remain understandable.
12. As a Mac user, I want to search and select Skills, so that I can prepare a focused sync preview.
13. As a Mac user, I want to preview every selected Skill operation, so that I can inspect the target, link path, strategy, risks, and execution state before writing.
14. As a Mac user, I want to create missing local Skill links, so that an Agent can consume the selected Vault Skills without copying their contents.
15. As a Mac user, I want existing directories, files, conflicts, and invalid Skills to remain protected, so that synchronization never silently replaces local content.
16. As a Mac user, I want to scan a local directory for links, so that I can inspect direct children or a complete tree.
17. As a Mac user, I want to create local file and directory symbolic links after confirmation, so that generic link operations remain available on Mac.
18. As a Mac user, I want to delete only identified symbolic-link entries, so that the link target is preserved.
19. As a Mac user, I want paths with spaces, Unicode, and shell characters to remain safe, so that normal Mac paths do not require manual escaping.
20. As a Mac user, I want to refresh scans explicitly, so that external filesystem changes appear when I request them.
21. As an automation user, I want the CLI to report Mac Vault, Agent, comparison, and preview data as JSON, so that scripts can use the same domain behavior.
22. As a maintainer, I want Mac tests to run without Windows dependencies, so that Mac validation reports only Mac behavior.
23. As a maintainer, I want the existing Windows tests to remain available separately, so that preserving legacy code does not erase its regression coverage.

## Implementation Decisions

- Use one application and one shared domain seam. Existing React workbenches and domain operations remain shared.
- Add `macos` as an explicit Host. Use a small `runtimeHost()` helper to select `macos` on macOS and preserve the existing legacy runtime behavior elsewhere.
- Do not add a general Workspace Profile, capabilities registry, or a second Mac configuration schema. The API exposes the selected `runtimeHost`; the UI uses that value to hide Mac-incompatible controls.
- On macOS, a missing config or an existing config whose Vault Host is `wsl`/`windows` is treated as an empty setup state. The old file is not imported or rewritten until the user explicitly saves a Mac config.
- Mac Vault, Agent, and common paths must be absolute POSIX paths. POSIX path detection receives the current Host because path syntax alone cannot distinguish WSL from macOS.
- Treat unsupported Hosts and cross-environment requests as blocked. The Mac UI omits those controls, and the service rejects such requests if they are sent directly.
- Use native macOS filesystem operations for local symbolic links. Do not add a shell command layer for Mac links.
- Keep the Mac navigation limited to Skill management and generic links. Keep mirror synchronization and its controls out of the Mac workspace. The existing mirror implementation remains legacy-only.
- Use an empty first-run setup state. Do not import the old ignored configuration and do not scan the home directory automatically. Fixtures remain test data only.
- Preserve the existing API shapes where they already describe the behavior. Add only the Host and setup-state data needed by the Mac workspace.
- Keep the existing localhost service model and port. Do not add a desktop shell, LaunchAgent, installer, or automatic startup in this slice.
- Keep the old WSL/Windows code in the Mac branch. Do not rewrite or duplicate the old frontend.

## Testing Decisions

- Test observable behavior at the shared domain seam: Mac path validation, empty setup loading, legacy config isolation, API workspace state, Vault scanning, Agent classification, comparison, sync planning, link preflight, link creation, link scanning, and safe deletion.
- Use temporary directories and project fixtures. Do not touch a user's real Mac Vault, Agent path, or links in automated tests.
- Verify the HTTP API through the same local service boundary used by the UI.
- Verify the Mac workspace renders only the supported navigation and shows empty setup state before configuration.
- Run Mac tests without invoking `powershell.exe`, `wsl.exe`, Junction logic, or mirror synchronization.
- Keep Windows-specific tests in a separate command or environment. Their failure must not make the Mac test command red.
- Use `npm run test:macos` for the Mac test suite. Keep the existing legacy test command and Windows coverage available separately.
- Ticket 01 acceptance requires `typecheck`, production build, Mac tests, local service startup, and the empty setup state. The temporary local-link workflow belongs to Ticket 04 after Tickets 02 and 03.

## Delivery Slices

- Ticket 01: runtime Host, empty setup, Mac navigation, config save, and independent Mac test command.
- Ticket 02: shared Skill workspace on the Mac Host, including scan, compare, preview, and Skill links.
- Ticket 03: native Mac generic file and directory links.
- Ticket 04: final validation, documentation, and temporary-directory end-to-end workflows.

## Out of Scope

- Remote WSL or Windows management.
- WSL-to-Mac, Mac-to-Windows, or any other cross-environment link operation.
- Windows Junctions and PowerShell execution in the Mac workspace.
- Vault mirror synchronization.
- Importing the old WSL configuration or migrating old filesystem links.
- Automatic home-directory discovery.
- Desktop packaging, LaunchAgent startup, installer work, or visual redesign.
- Removing the old WSL/Windows implementation.

## Further Notes

The work starts from the clean `master` baseline at commit `15106d0` on the `macos-port` branch. The current Mac worktree already has the dependencies installed. Ticket 01 added `npm run test:macos`; existing Windows-specific tests still require `powershell.exe` and remain outside that command.
