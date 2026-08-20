# 对抗性审查报告：44-skills-manager-web vs wsl-symlink-manager（真相源）

## 0. 修正状态（2025-08-20 第一轮）

已修正（语义对齐，测试 11/11 + 真实 vault 验证通过）：

- **D1** 重名不再判无效：`prototype` 两来源均有效、保留候选；duplicateIds 仅展示。
- **D2** name-mismatch 恢复为 invalid（精确一致含大小写）。
- **D5** repo-link 索引未命中按真相降级（目标目录 SKILL.md 有效 → repo-link；无效 → invalid-skill）。
- **D6** agent 本地目录 name 不一致 → invalid-skill；fixture 补了合法 repo-copy 用例。
- **D7** frontmatter 改宽松：有效性只看 name；`description`（含 `|-` 块标量）仅展示。真实 vault 的 `claude-api` 恢复有效。
- **D8** 排除名单对齐（.git + node_modules）；Vault 顶层点目录跳过，深层点目录照扫。

真实 vault 结果：88 全发现，81 有效 / 7 无效（7 个全部为目录名与 name 不一致的 `@runmi`/`anysearch-skill`）。

待办：D3（链接记录持久化）、D4（拷贝转链接）、D10（技能页删除链接）、D11（冲突二次确认流程）、D12（last_scan_path）。

## 0.2 第二轮（2025-08-20）

已实现（测试 14/14，typecheck/build 通过，隔离端口端到端冒烟通过）：

- **D3** 链接记录持久化：`config.links: {skill, collection, agentId}`；同步创建成功、拷贝转换成功时写入；删除链接后清除；配置校验/读写/API/UI 展示（详情面板显示来源集合）全部接通。
- **D4** 拷贝转链接：核心 `convertCopyToLink`（备份→建链→验证→删备份，失败回滚）+ `POST /api/agent-links/convert`（守卫：目录名与 SKILL.md name 一致、必须在 vault 中）+ UI「转为链接」按钮（含改动丢失确认）。
- **D10** 技能页删除链接：`POST /api/agent-links/delete`（守卫：非断链时目标必须是有效 skill 才可删；只删链接条目）+ UI「删除链接/删除断链」（含确认）。
- **D11** 冲突项改「确认后跳过」语义：blocked 操作执行时不再计失败，返回 skipped，结果整体 completed。
- **D12** lastScanPath：通用链接页记住上次扫描路径，打开时自动恢复。

---

- 日期：2025-08-20
- 基准：`/home/lee/11MyProjrct/01-Misc/wsl-symlink-manager`
- 对象：`/home/lee/11MyProjrct/44-skills-manager-web`
- 审查维度：**机制与逻辑处理**（非代码长相、非技术栈）
- 判定原则：一切以 wsl-symlink-manager 为准；本报告只读，未修改任何数据。

---

## 1. 真相源基线（已通读全部源码）

### 1.1 功能清单

| 功能区 | 能力 |
|---|---|
| 通用链接 | 扫描（flat/递归，不跟进链接目录）、创建（WSL symlink / Windows Junction）、删除（仅链接条目，不删目标）、路径规范化（WSL↔Windows）、常用路径保存/编辑/删除、上次扫描路径记忆、文件/文件夹选择器 |
| 技能管理 | 配置 Vault（只读）+ Agent 列表（name+path）；Vault 扫描树（Collection + Loose）；Agent 条目分类（repo-link / repo-copy / local-dir / external-link / broken-link / invalid-skill）；批量建链（预览 → 冲突二次确认 → 跳过冲突重试）；删除技能链接（含删除断链）；**repo-copy 转链接（备份-建链-验证-回滚事务）**；链接记录持久化（skill+collection+agent） |
| 兼容切片 | `--skills-compat` 只读验证页（Svelte），独立于默认 UI |

### 1.2 架构图

```
┌─ Windows 主机 ──────────────────────────────┐
│  Wry 窗口 (ui.html / skills-compat 页面)     │
│    │ IPC {id, cmd, ...args}（工作线程执行）  │
│    ▼                                        │
│  ipc.rs dispatch → AppState（模式/缓存/配置） │
│    ├─ WslBackend   → wsl.exe --exec bash 批量脚本（NUL 分隔协议）
│    └─ WindowsBackend → 直接 fs / junction crate
│    ├─ link.rs      → SkillLink 接口原语 + vault 目录收集/name 校验
│    ├─ domain.rs    → LinkMode/EntryKind/SkillRef/VaultIndex/VaultTree
│    └─ config.rs    → config.json（vault/agents/links/last_scan_path）
└─────────────────────────────────────────────┘
```

### 1.3 核心机制清单（每条均有源码依据）

**扫描（以 `link.rs::collect_skill_dirs` / `ipc.rs::scan_vault` 为准）**
- 递归收集：任意深度、任意层级；**点目录（如 `.agents/`）是合法容器，必须收集**。
- 排除名单：仅 `.git` 与 `node_modules`（`collect_skill_dirs`）。
- Vault 顶层：**点开头目录直接跳过**（不是 Collection）；顶层直接含 SKILL.md = loose。
- Agent 扫描：只看直接子项（flat），不递归；扫描不跟进链接目录（WSL `find -P`，Windows 仅 Directory 下钻）。
- 无 name 的 SKILL.md 记录**不丢弃**（空 name 保留，交给上层标无效）。

**有效性模型（`link.rs::skill_name_validation_error`）**
- 只有两个判据：① name 缺失 → 无效；② 目录名与 name 不精确一致（含大小写）→ 无效。
- 输出是**单个字符串**（validation_error），无问题列表、无分级。
- frontmatter 只提取 `name:` 行（支持引号），无 YAML 头 = name 缺失；**不存在 malformed 概念**。
- id = frontmatter name；name 缺失时 id = vault 相对路径。

**重名消歧（`ipc.rs::vault_index` / `resolve_skill_rel` / `classify_local_dir`）**
- `VaultIndex: id → [SkillRef{collection, dir, rel}]`，**同 id 允许多个候选（重名是常态，不是错误）**。
- 建链/识别时按 collection 精确匹配，否则取第一个候选；本地目录识别按「目录名一致优先」消歧。
- 索引只收录 valid skill；vault 路径不变时缓存复用。

**Agent 条目分类（`ipc.rs::scan_agent` / `classify_link` / `classify_local_dir`）**
- 链接条目：目标路径前缀在 vault 内 → repo-link（用索引 rel 解析真实身份）；**索引中没有时降级为 repo-link（collection=首段，id=链接名），不判无效**。断链 → broken-link；其余 → external-link。
- repo-link（非断链）会对 target 目录再校验一次 SKILL.md name，失败 → invalid-skill。
- 本地目录：SKILL.md name 缺失或目录名 != name → **invalid-skill（不允许按 id 降级匹配）**；name 在索引 → repo-copy（目录名一致优先消歧）；否则 local-dir。
- 身份的 host 判定：**路径前缀**（`/` 开头 = WSL，否则 Windows），`skill_backend` 是唯一分叉入口；无 host 字段、无 cross-host 概念。

**链接记录（`config.rs::LinkRecord`）**
- create/convert 成功后写 `{skill, collection, agent}` 到配置；agent 重命名时记录跟随（`rename_agent`）。
- UI 用记录判定「已启用」、把已链接项从勾选移除；删除链接后清理记录。集合信息只存软件内部。

**批量建链流程（`ipc.rs::create_skills` + ui.html）**
- 服务端过滤不在索引里的 skill（skipped_invalid）→ 批量预检冲突（`exists_many`，一次调用）→ 有冲突且未确认时返回 `need_confirm`+冲突列表 → 前端确认弹窗 → `skip_conflicts=true` 重试（存在的跳过）→ 批量创建（`create_many`，失败收集 idx+原因）→ 写记录。
- 创建前提：target 必须存在、link 必须不存在、父目录必须存在；Junction 仅指向文件夹。

**删除链接（`ipc.rs::delete_skill_link`）**
- 仅删除链接条目；**删除前校验 target 是有效 skill，无效则拒绝删除**；删除后清记录；三种结果消息（已删除/记录已清/不存在）。断链可删（「删除断链」）。

**拷贝转链接（`link.rs::SkillLink::convert_copy`，wsl.rs / windows.rs 实现）**
- 一次调用事务：改名备份 → 建链接 → 验证 → 删备份；失败自动回滚。UI「转为链接」有数据丢失警告。
- 前提：目录名与 SKILL.md name 一致且 name 在 vault 索引中。

**通用链接安全（`wsl.rs::validate_create_paths`、`windows.rs`）**
- 创建四前提同上；删除只接受链接条目（普通文件/目录拒绝）；Junction 删除后清理空目录但不递归。

---

## 2. 我们项目的现实状态

- 技术栈：Node 服务 + React web（localhost:8787），核心在 `src/core/*`（TS），来源是 skill-manager-opentui-spike 的 core 迁移（tickets.md T2），**并非直接从 wsl-symlink-manager 移植**。
- 已有：Vault 扫描、frontmatter 完整解析、Collection/Loose 归组、Agent 分类、比较状态机、同步预览/执行、通用链接工作台（preflight/create/delete/scan）、配置 API、CLI。

---

## 3. 机制偏差清单（按严重度）

### P0 — 语义与真相相反或整体缺失（必须修）

**D1. 重复 ID：我们把"重名"当错误，真相把它当可消歧的常态**
- 真相：`VaultIndex` 允许多候选；建链按 collection 消歧；本地目录按目录名一致性优先。重名不产生任何无效。
- 我们：`vault.ts` 中 duplicate-id → 两个 skill 全部判 invalid、不可同步。
- 实际影响（真实 vault）：`prototype`（Matt 与 emilk 两来源）在我们这全部红色不可用；真相下两者都可用、按来源选择。
- 证据：真相 `ipc.rs::vault_index/resolve_skill_rel/classify_local_dir`；我们 `vault.ts` duplicateIds 处理。我们的 spec #47 原文还写着"列出所有候选来源以便消歧"——实现做反了。
- 修正方向：删除 duplicate-id 无效化；引入 SkillRef 多候选与消歧。

**D2. name-mismatch：我上一轮改成了 warning 不阻塞，与真相相反**
- 真相：目录名与 name 不精确一致（含大小写）= 无效（`skill_name_validation_error`），不可同步、不可转换。
- 我们（上次改动后）：name-mismatch 降为 warning，可同步。
- 实际影响：`@runmi` 等 7 个真实技能在真相下应判无效，我们放行了。
- 证据：真相 `link.rs` 校验函数与测试（case mismatch 断言无效）；我们 `vault.ts createSkill`、`core.test.ts` 的预期（已按错误方向改写）。
- 修正方向：恢复精确匹配 = invalid；删除 warning 分级（真相没有分级语义）。

**D3. 链接记录（LinkRecord / 来源集合持久化）整体缺失**
- 真相：create/convert 后写 `{skill, collection, agent}`，UI 依赖记录判断"已启用"、刷新勾选、删除、重命名跟随。
- 我们：完全没有记录；"已链接"完全靠实时扫描文件系统推断；flatten 后的来源集合不可知。
- 实际影响：无法知道某链接来自哪个 Collection（D1 消歧后尤其需要）；spec #76 明确要求"记录 Source Collection，flattening 不丢失 provenance"——我们没实现。
- 证据：真相 `config.rs::LinkRecord/rename_agent`、`ui.html refreshLinks`；我们 `types.ts` 无对应模型。
- 修正方向：config 增加 links 记录；create 成功后写入；UI 用它驱动已链接状态。

**D4. repo-copy 转链接（convert_copy 事务）缺失**
- 真相：备份 → 建链 → 验证 → 回滚 + UI「转为链接」按钮（含数据丢失确认）。
- 我们：只展示 repo-copy 状态，无转换动作。
- 证据：真相 `wsl.rs::convert_copy`、`ui.html` 详情面板。
- 修正方向：核心加 convert 原语与服务端接口按真相语义实现。

### P1 — 行为差异（应该修）

**D5. repo-link 判定：索引未命中时我们判 invalid，真相降级为 repo-link**
- 真相：目标前缀在 vault 内即 repo-link；索引未命中时降级（collection=首段，id=链接名），仅对非断链重新校验 target 的 SKILL.md。
- 我们：`agent.ts` 对"指向 vault 内但找不到有效 skill"的链接判 invalid（invalid-entry + error）。
- 证据：真相 `ipc.rs::classify_link` 降级分支 vs 我们 `agent.ts findByCanonical` 失败分支。
- 修正方向：按真相降级。

**D6. Agent 本地目录的 name 校验：我们缺失"目录名 != name 即 invalid-skill"**
- 真相：`classify_local_dir` 先校验目录名与 name 一致性，不一致 → invalid-skill（测试明确"不允许按 id 降级匹配"）。
- 我们：`agent.ts` 只要 frontmatter 完整就按 name 找 id → repo-copy，或 local-dir；不一致只当 local-dir（warning），不判无效。
- 证据：真相 `ipc.rs::classify_local_dir` + 测试 `renamed-dir` 用例 vs 我们 `agent.ts` 目录分支。
- 修正方向：按真相补校验。

**D7. frontmatter 严格度：我们有 malformed/完整解析，真相只读 name 行**
- 真相：只提取 `name:` 行；无 YAML 头 = "缺少 name"；无 malformed 概念。
- 我们：完整 YAML 标量解析，`description: |-` 块标量报 malformed、重复字段报错等。
- 实际影响（真实 vault）：`claude-api` 用 `description: |-`，我们判 invalid（frontmatter-malformed）；**真相下它是 valid（name 行正常）**。88 个真实技能在真相机制下全部有效，我们标了 3 个无效。
- 证据：真相 `link.rs::frontmatter_name` vs 我们 `frontmatter.ts parseFrontmatter`；真实文件 `06_from_anthropic/claude-api/SKILL.md`。
- 修正方向：按真相只提取 name（可保留 description 作为展示增强，但不得影响 validity）。

**D8. Vault 顶层与排除名单差异**
- 真相：顶层点目录跳过（不是集合）；递归排除 `.git` + `node_modules`。
- 我们（上次改动后）：任何层点目录都扫、只排 node_modules。
- 实际影响：真实 vault 无顶层点目录、`.git` 内无 SKILL.md → 当前无可见差异，但机制不一致（我们会走进 `.git`）。
- 修正方向：对齐排除名单与顶层策略。√ 我上一轮"无条件"只对了一半（点目录如 `.agents` 必须进，但 `.git` 排除与顶层跳过被丢了）。

**D9. Agent 身份模型：真相只有 name+path，我们发明了 id+host+cross-host**
- 真相：Agent = `{name, path}`；backend 按路径前缀选择；无 cross-host 概念。
- 我们：`{id, name, host, path}`；host 不同时链接判 invalid（cross-host-link）。
- 影响：多了一层显式 host（与配置模型耦合），cross-host 判 invalid 在真相框架里不存在（真相下"Windows agent 路径 + vault 在 WSL"由建链策略处理）。
- 修正方向：保留我们既有配置结构（我们的 spec #34-35 要求 id/host）作为**配置层增强**，但分类逻辑按真相：链接的目标在 vault 前缀内就按链接分类，不因 host 字段判无效。此条需你确认（见第 5 节 B）。

### P2 — 机制小差异

- **D10 技能页删除链接缺失**：真相技能页有"删除链接/删除断链"（含 target 有效性前置校验）；我们技能页无删除入口（仅通用链接工作台有）。修正方向：按真相补（含"无效 skill 不能删"的守卫）。
- **D11 批量建链的冲突二次确认**：真相 = 服务端预检 exists_many → need_confirm → skip_conflicts 重试跳过；我们 = plan 静态标记 blocked。结果都安全，但真相允许"确认后跳过冲突继续"而我们是"有冲突则该项失败"。建议对齐为真相流程。
- **D12 上次扫描路径记忆（last_scan_path）**：真相有；我们无。低优先级。

---

## 4. 我们独有、真相没有的机制（保留，但指认清）

- 比较状态机（linked/pending/local-dir/…）与三视图（Repository/Compare/Agent actual）：真相只有扫描结果视图，无状态机；这是我们 spec 的扩展，保留。
- 同步预览计划（plan/execute 分离、argv/typed 参数、shell:false）：真相的 create 是"直接执行"风格，预览靠前端弹窗；我们更严。保留。
- severity 分级问题列表、validation-pill、issueCount：真相是单错误字符串。**建议收敛**：有效性语义回真相，分级展示可作为 UI 呈现手段，不作为领域语义。
- 通用链接工作台的 preflight 风险列表（可写性、目标内部嵌套检查）：比真相的 create 四前提更细，保留。

---

## 5. 单独记号：需要你拍板的点

- **A（真相内部小问题，无实际影响）**：真相 WSL 批量 name 提取脚本（`READ_SKILL_NAMES_RECURSIVE_SCRIPT`）用 `find .` 不排除 `.git`，与 Rust 侧 `collect_skill_dirs` 的排除不一致；因 name 表多余行不被引用，无后果。建议不动。
- **B（配置模型冲突）**：我们的 Agent 有 id/host 字段、真相只有 name/path。D9 我建议"保留我们配置结构、但分类语义按真相"。如果你认为应该连配置结构也对齐真相（去掉 id/host），告诉我，那会牵动配置迁移。
- **C（frontmatter）**：D7 若按真相只读 name 行，"description 搜索/展示"（我们 spec #65）会失去来源——我建议保留 description 解析仅用于展示，不参与有效性。默认按此执行，除非你否定。

---

## 6. 建议动作顺序（待你确认后执行）

1. 回退 D2（name-mismatch 恢复为 invalid）+ 修 D1（重名消歧）——两者联动，是核心语义。
2. 修 D7（frontmatter 只读 name 判定有效性）→ 真实 vault 88/88 全部有效，`claude-api` 回归 valid。
3. 补 D3（LinkRecord 持久化）与 D4（convert_copy）——新机制，工作量中等。
4. 修 D5/D6/D8/D10/D11（分类与流程对齐）。
5. P2 项（D12）可延后。