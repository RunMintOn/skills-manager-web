# ADR-001：localhost Web（React）取代 TUI/OpenTUI 与 Electron

状态：Accepted（2026-08-19，用户确认）

## 背景

项目经历四轮技术方向摇摆：Rust+Wry（现状参考）→ TUI/OpenTUI（已实现能力原型与第一切片）→ Electron 讨论 → localhost Web。用户实际试用 TUI 后确认：功能可用，但手感与视觉不符合"像软件"的期待；GUI 更符合使用直觉。同时用户花费在技术栈讨论上的成本已高于收益，需要一锤定音。

## 决策

- 界面：React + Vite + TypeScript + Tailwind（shadcn/ui 风格轻量组件），localhost Web。
- 服务：Node 服务在 WSL 原生环境运行，监听 127.0.0.1:8787。
- 入口：Windows 开始菜单快捷方式（.bat/.vbs）→ wsl.exe 启动 WSL 内服务 → 自动打开浏览器。
- 不打包、无桌面壳、无端口服务生命周期之外的进程管理。
- 领域层保持纯 TypeScript，Web 前端、HTTP API、CLI 三者共享。

## 理由

- 开发速度：浏览器热更新最快；无编译、无打包、无壳。
- Agent 效率：React + TypeScript 是 Agent 训练数据最多的组合。
- 视觉上限：浏览器 CSS 的自由度高于终端；用户核心诉求是"UI 更好看、交互细化"。
- 自动化：浏览器截图对比生态成熟，符合用户"Agent 自跑、截图、对比、继续"的迭代方式。
- 系统能力：Node 服务可直接做 WSL 操作；Windows Junction 经互操作调 Windows 命令（已验证）。
- 个人工具：无分发需求，Electron/Tauri 的体积与壳优势无意义。

## 后果

- 每次使用需先启动服务（由快捷方式解决，双击即用体验）。
- WSL2 localhost 转发为前置依赖（需联调首验）。
- Junction 操作跨一次系统边界（已验证 powershell.exe/cmd.exe 可用）。
- 不产生可分发安装包；升级即更新代码。

## 备选与否定理由

- TUI（OpenTUI + Bun）：用户实测手感不符；视觉与自动化闭环弱。
- Electron：无需打包分发；体积与浏览器重复无收益。
- Tauri：需 Rust 后端，与本项目在 papercuts.md 中实测的构建摩擦冲突。
- 继续 Rust/Wry：改 UI 需重编译，构建环境坑有记录。
- 纯静态网页无服务：无法执行系统操作（Junction、wsl.exe）。