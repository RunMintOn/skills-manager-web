# Skill Manager Web — Tickets

执行方式：外部一口气交付成品。以下票据为内部切片，按编号顺序执行，各自完成后才进入下一张；最终交付物是完整可用的成品。

## T1 — 工程脚手架与视觉基座

- 范围：Vite + React + TypeScript + Tailwind CSS。npm scripts：dev、build、typecheck、test。目录结构 src/web（React）、src/server（Node）、src/core（领域）。
- 视觉基座：复刻 wsl-symlink-manager/src/ui.html 的设计语言——CSS 变量双主题（浅色：#f4f5f7/#ffffff/#1f2328/accent #2563eb；深色：#101216/#1a1d24/#e6e8eb/accent #3b82f6），卡片、边框、row-hover/row-selected、表格头。顶部 header + 两个导航（技能管理/通用链接占位）。
- 验收：npm run dev 可打开页面；npm run typecheck 通过。
- 阻塞边：无。

## T2 — 领域核心（复用已验证代码）

- 范围：从 skill-manager-opentui-spike/src/core 与 skill-manager-opentui/src/core 迁移并整合：配置读写、Vault 扫描、frontmatter 解析、Collection/Loose Skills 归组、name 精确匹配校验、重复 ID 检测、Agent 扫描、条目分类（repo-link / repo-copy / local-dir / external-link / broken-link / invalid）、比较状态映射、同步预览计划（argv/typed fs 参数，无 shell 字符串，not-run）、路径安全校验（防遍历、注入）。
- 数据只读：本票不创建/删除/修改任何真实链接。
- 测试：vitest，fixtures 覆盖嵌套 Collection、Loose、无效、重复、六类条目、计划不执行。全部测试只用项目 fixtures 或系统临时目录。
- 验收：npm test 通过。
- 阻塞边：T1（目录结构）。

## T3 — 配置与 HTTP API

- 范围：Node 服务（Express 或 Node 内置 http，倾向 Express）。端口 8787，仅监听 127.0.0.1。端点在 spec 的 Web UI and CLI 语义内：GET /api/init（配置摘要）、GET /api/vault（扫描结果）、GET/PUT /api/config（配置读写）、GET /api/agent/:id（Agent 实际扫描）、POST /api/plan（同步预览计划）。
- 配置：data/config.json（gitignore），显式路径，绝不隐式读写用户 home。配置含 vault 路径与 agents 列表（id、name、host、path）。
- 验收：起服务后 curl 各端点返回稳定 JSON；配置写回成功。
- 阻塞边：T2。

## T4 — 三列主界面（复刻 Wry 视觉 + 新信息架构）

- 范围：三列布局——左：Agent 列表（名称、路径、问题计数；添加/编辑/删除）；中：Vault Skill 按 Collection 分组（有效/无效/重复徽标、相对路径、对当前 Agent 的状态、搜索、多选）；右：选中 Skill 详情（Vault 路径、Collection、frontmatter、目录名校验、Agent 实际条目、将建 Flat Link 路径、风险）。顶栏：Vault 仓库、刷新、配置入口、校验摘要。底栏：选择计数 + 预览同步按钮。
- 数据：T4 可先以 T3 真实 API 为准；若个别能力后端未就绪，用清晰"未就绪"状态，不得伪造数据。
- 验收：dev 模式三列可见、搜索过滤、多选计数正确、详情随选中更新。
- 阻塞边：T1、T3。

## T5 — 视图与同步预览 + 键盘可达

- 范围：Repository / Compare（默认）/ Agent actual 三视图切换（同一三列布局）。同步预览弹层：每选中 Skill 一行，显示 target、flattened link path、link strategy、风险、execution=not-run；不执行任何文件操作。键盘可达：Tab/Shift+Tab 焦点循环、↑↓ 列表移动、Space 多选、Enter 激活、Esc 关闭/返回、/ 聚焦搜索。
- 验收：三种视图可切换；预览只读；键盘路径完整。
- 阻塞边：T4。

## T6 — CLI、测试收口、运行入口

- 范围：cli.ts（node src/server/cli.ts）复用同一 core：config init --config <file>、status --json、plan --json。vitest 全量通过。README：开发、生产运行、配置、已验证/未验证清单。scripts/start 快捷方式素材：start.bat / start.vbs（wsl 环境双击入口说明，Windows 开始菜单快捷方式步骤写文档）。
- 验收：typecheck、test、build 全过；CLI 三命令跑通并保存 artifacts；README 完整。
- 阻塞边：T2、T3、T5。

## T7 — 真实链接执行与通用链接工作台

- 范围：真实 Skill 链接创建；通用目标/链接路径输入；主机适配器预检；真实创建与安全删除；目录扫描；常用路径配置；创建后刷新状态。
- 安全：Vault 只读；创建必须确认；链接路径已存在时阻止；删除只接受链接入口；不递归删除目标。
- 验收：临时目录覆盖预检、真实创建、扫描、删除和目标保留；API 与生产 UI 构建通过。

## 全局约束（所有票）

- 只写 /home/lee/11MyProjrct/44-skills-manager-web。
- 绝不修改参考项目：skill-manager-tui、skill-manager-opentui*、wsl-symlink-manager。
- 开发和测试不得操作用户真实 Vault、Agent 路径或链接；真实操作只使用用户在产品中明确确认的路径，自动化测试只使用项目 fixtures 或系统临时目录。
- 测试只使用项目 fixtures 或系统临时目录。
- 不向用户提问；不确定性取最安全实现并记录。
- 每张票完成后，执行其验收命令并向管理者报告。