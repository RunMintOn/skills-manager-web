# Skill Manager Web — CONTEXT

个人本地工具：管理只读 Skill Vault、多个 Agent 路径和通用文件系统链接。界面为 localhost Web，Node 服务在 WSL 内运行，Windows 浏览器访问。使用者：本人与 AI Agent。

## 已确认决策（用户确认）

- **技术栈**：React + Vite + TypeScript。样式 Tailwind CSS，组件以 shadcn/ui 风格自建轻量集。
- **形态**：localhost Web 应用，不打包、无桌面壳。Node 服务在 WSL 内监听 127.0.0.1:8787。
- **入口**：Windows 开始菜单快捷方式 → wsl.exe 启动 WSL 内服务 → 自动打开浏览器到 localhost:8787。
- **代码位置**：/home/lee/11MyProjrct/44-skills-manager-web（WSL 原生文件系统，不用 /mnt）。
- **依赖**：WSL 侧一份 node_modules，不跨系统共享。
- **UI 信息架构（三列）**：
  - 顶栏：Vault 仓库、刷新、配置、校验摘要
  - 左列：Agent 列表（名称、路径、问题计数；添加/编辑/删除）
  - 中列：Vault Skill 按顶层分类（Collection）分组，含校验状态与相对路径；搜索、多选
  - 右列：选中 Skill 详情（Vault 路径、frontmatter、目录名一致性、Agent 实际条目、将建链接、风险）
  - 底栏：选择计数 + 预览同步
- **视图**：Repository（审计 Vault）/ Compare（默认，Agent vs Vault）/ Agent actual（只看 Agent 实际条目），同一三列布局切换。
- **领域核心**：复用已验证 TypeScript core（来源：skill-manager-opentui-spike 与 skill-manager-opentui 的 src/core）。
- **Agent 可调用**：CLI `status --json` / `plan --json`（薄包装，复用同一核心，独立于服务可运行）。
- **阶段顺序**：三列界面 + mock → 真实扫描核心 → HTTP API → 预览 → 真实链接执行与通用链接工作台。

## 决策历史

- 否掉 Rust + Wry：构建摩擦有实测记录（papercuts.md）；改 UI 需重编译；自定义 IPC 成本高。
- 否掉 TUI（OpenTUI/Bun）：实测后手感不符合"像软件"的期待；视觉上限低；截图对比自动化闭环弱。
- 否掉 Electron/Tauri：对个人工具无分发需求，打包体积与壳无必要；localhost Web 迭代最快。
- 选 localhost Web：开发最快、Agent 生态最熟、不打包、浏览器截图对比方便。
- 运行环境全 WSL：避开 Windows 依赖与跨边界坑；Junction 经系统互操作调用 Windows 命令（已验证）。
- WSL2 localhost 转发：假定默认可用，Web 服务联调时首验。

## 术语

**Vault（中央仓库）**：只读。绝不修改其内容。

**Collection**：Vault 内包含 SKILL.md 子目录的目录（任意深度递归识别）。Skill 按 Vault 相对路径第一段归组；Vault 根下的 Skill 归为 **Loose Skills**。

**Skill Directory**：SKILL.md 的直接父目录，最小管理单元。有效条件：目录名与 frontmatter `name` 精确一致（含大小写）。

**Agent Path**：消费者加载 Skill 的目录。每个 Agent 有 id、显示名、host、实际路径。

**Flattened Link**：直接建在 Agent Path 下的 Skill 名称目录。来源 Collection 只记录在应用配置中，不体现在文件系统层级。

**Agent 条目分类**：
- repo-link：指向 Vault 内有效 Skill 的链接
- repo-copy：真实目录，元数据可识别为 Vault Skill 但非链接
- local-dir：无法识别为 Vault 副本的真实目录
- external-link：指向 Vault 外的活动链接
- broken-link：目标无法解析的链接
- invalid：无法通过完整性规则的条目或 Skill

**比较状态**：已链接 / 待链接 / 本地目录 / 外部链接 / 断链 / 无效。Agent-only 条目单独保留显示。

**链接概念**：Link Target（已存在的文件或目录）、Link Path（新链接条目，不得已存在）、HostKind（wsl / windows，显式，不做字符串猜测）。通用链接由用户输入任意目标路径和链接路径。用户确认后由软件执行真实链接操作。

**同步概念**：Skill 同步不是复制内容。它是在选定 Agent Path 下，为缺失 Skill 创建扁平链接。Vault 保持只读。冲突条目不覆盖。

## 资产地图

- `docs/specs/001-unified-link-and-skill-manager.md`：86 条用户故事与测试决策（从 opentui 项目迁入并修订技术栈）
- `docs/adr/001-web-over-tui-electron.md`：技术栈决策记录
- 可复用 core 参考（只读）：`/mnt/d/15_dev/管理skill插件/skill-manager-opentui-spike/src/core`、`skill-manager-opentui/src/core`
- Windows 链接能力已验证（临时目录 smoke test）：WSL→WSL、WSL→/mnt/c、Windows 主机 wsl.exe、Windows Junction
- 参考只读：wsl-symlink-manager（行为参考）、skill-manager-tui（UI 参考，有未提交修改，不碰）

## 阶段规划（tickets 预览）

- T1：脚手架（Vite + React + TS + Tailwind）+ 三列布局骨架 + mock 数据
- T2：领域核心迁移（扫描/校验/分类/差异/计划）+ 测试
- T3：Node HTTP API + 配置读写 + 真实 WSL 扫描
- T4：前端对接 API；视图切换；搜索多选
- T5：同步预览 + 键盘可达性
- T6：开始菜单快捷方式脚本 + 启动文档 + 联调验收
- T7：真实执行 Skill 链接；通用链接工作台；链接扫描、删除和常用路径

## 管理者拍板（用户可否决）

- 端口固定 8787
- 配置存 `data/config.json`（gitignore），通过 UI 配置页维护；首次运行不隐式读写用户 home
- 通用链接工作台和真实链接执行属于当前产品范围。创建和删除必须经过预检、明确确认，并返回真实结果。
- 不引入重型组件库，按需自建 shadcn/ui 风格组件