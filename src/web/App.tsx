import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react"
import type { AgentConfig, AgentEntry, AgentScan, ComparisonResult, ComparisonRow, HostKind, SkillManagerConfig, SyncPlan, VaultSkill, VaultScan } from "../core/types.ts"
import { api, type InitResponse } from "./api"
import { LinksWorkbench } from "./LinksWorkbench"
import { SkillMatrix } from "./SkillMatrix"

type TopTab = "skills" | "links"
type View = "repository" | "compare" | "actual"
type AgentDraft = { id: string; name: string; host: HostKind; path: string }

const stateLabels: Record<string, string> = { linked: "已链接", pending: "待链接", "local-dir": "本地目录", "external-link": "外部链接", "broken-link": "断链", invalid: "无效", valid: "有效" }
const kindLabels: Record<string, string> = { "repo-link": "repo-link · Vault", "repo-copy": "repo-copy · 拷贝", "local-dir": "local-dir · 本地目录", "external-link": "external-link · 外部", "broken-link": "broken-link · 断链", invalid: "invalid · 无效" }
const emptyConfig: SkillManagerConfig = { schemaVersion: 1, vault: { path: "", host: "wsl" }, agents: [] }

function entryForSkill(entries: AgentEntry[], skill: VaultSkill): AgentEntry | undefined { return entries.find((entry) => entry.skillId === skill.id || (!entry.skillId && entry.name === skill.directoryName)) }
function displayError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function focusListItem(selector: string, current: HTMLElement, delta: number): void { const items = [...document.querySelectorAll<HTMLElement>(selector)]; const index = items.indexOf(current); if (index < 0) return; items[Math.max(0, Math.min(items.length - 1, index + delta))]?.focus() }
function operationText(action: string): string {
  if (action === "create-link") return "将创建"
  if (action === "already-linked") return "已存在"
  return "已阻止"
}
function operationClass(action: string): string {
  if (action === "create-link") return "preview-action create"
  if (action === "already-linked") return "preview-action existing"
  return "preview-action blocked"
}
function typedOperation(plan: SyncPlan["operations"][number]): string {
  if (!plan.link) return "(没有可执行操作：blocked)"
  if (plan.link.kind === "wsl-command") return `argv: ${JSON.stringify([plan.link.executable, ...plan.link.args])}`
  return `fs.promises.symlink args: ${JSON.stringify(plan.link.fsArgs)}`
}

export function App(): ReactElement {
  const [topTab, setTopTab] = useState<TopTab>("skills")
  const [view, setView] = useState<View>("compare")
  const [dark, setDark] = useState(() => { try { return window.localStorage.getItem("skills-manager-theme") === "dark" } catch { return false } })
  const [init, setInit] = useState<InitResponse | null>(null)
  const [config, setConfig] = useState<SkillManagerConfig>(emptyConfig)
  const [vault, setVault] = useState<VaultScan | null>(null)
  const [agent, setAgent] = useState<AgentScan | null>(null)
  const [comparison, setComparison] = useState<ComparisonResult | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState("")
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [actualSelectedPath, setActualSelectedPath] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [agentModal, setAgentModal] = useState<AgentDraft | null>(null)
  const [vaultPathDraft, setVaultPathDraft] = useState("")
  const [preview, setPreview] = useState<SyncPlan | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [syncExecuting, setSyncExecuting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const collapsedGroupsInitialized = useRef(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const previewCloseRef = useRef<HTMLButtonElement>(null)

  const loadAgent = useCallback(async (id: string, vaultValue: VaultScan) => {
    const result = await api.agent(id)
    setAgent(result.agent); setComparison(result.comparison); setActualSelectedPath(null)
    setSelectedSkillId((current) => current && vaultValue.skills.some((skill) => skill.id === current) ? current : vaultValue.skills[0]?.id ?? null)
  }, [])
  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const initValue = await api.init(); const configValue = initValue.config.config; const vaultValue = (await api.vault()).vault
      setInit(initValue); setConfig(configValue); setVault(vaultValue)
      const id = initValue.selectedAgentId ?? configValue.selectedAgentId ?? configValue.agents[0]?.id ?? ""; setSelectedAgentId(id)
      if (id) await loadAgent(id, vaultValue); else { setAgent(null); setComparison(null); setSelectedSkillId(vaultValue.skills[0]?.id ?? null) }
    } catch (loadError) { setError(displayError(loadError)); setInit(null); setVault(null); setAgent(null); setComparison(null) } finally { setLoading(false) }
  }, [loadAgent])
  useEffect(() => { void load() }, [load])
  useEffect(() => { setVaultPathDraft(config.vault.path) }, [config.vault.path])
  useEffect(() => { try { window.localStorage.setItem("skills-manager-theme", dark ? "dark" : "light") } catch { /* storage can be unavailable */ } }, [dark])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key === "/" && target?.tagName !== "INPUT" && target?.tagName !== "TEXTAREA" && !preview && !agentModal) { event.preventDefault(); searchRef.current?.focus() }
      if (event.key === "Escape") { if (preview) setPreview(null); else if (agentModal) setAgentModal(null) }
    }
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown)
  }, [preview, agentModal])
  useEffect(() => { if (preview) setTimeout(() => previewCloseRef.current?.focus(), 0) }, [preview])

  const selectAgent = async (id: string) => { if (!vault) return; setSelectedAgentId(id); setError(null); try { await loadAgent(id, vault) } catch (loadError) { setError(displayError(loadError)) } }
  const filteredSkills = useMemo(() => {
    if (!vault) return []
    const needle = query.normalize("NFKC").toLocaleLowerCase("en-US").trim()
    return vault.skills.filter((skill) => !needle || [skill.id, skill.name ?? "", skill.collection, skill.description ?? "", skill.relativePath].join(" ").normalize("NFKC").toLocaleLowerCase("en-US").includes(needle))
  }, [vault, query])
  const groups = useMemo(() => { const map = new Map<string, VaultSkill[]>(); for (const skill of filteredSkills) map.set(skill.collection, [...(map.get(skill.collection) ?? []), skill]); return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)) }, [filteredSkills])
  const actualGroups = useMemo(() => { const map = new Map<string, AgentEntry[]>(); const needle = query.normalize("NFKC").toLocaleLowerCase("en-US").trim(); for (const entry of agent?.entries ?? []) if (!needle || [entry.name, entry.relativePath, entry.kind, entry.targetPath ?? ""].join(" ").normalize("NFKC").toLocaleLowerCase("en-US").includes(needle)) map.set(entry.kind, [...(map.get(entry.kind) ?? []), entry]); return [...map.entries()] }, [agent, query])
  useEffect(() => {
    collapsedGroupsInitialized.current = false
  }, [vault])
  useEffect(() => {
    if (collapsedGroupsInitialized.current || !groups.length) return
    collapsedGroupsInitialized.current = true
    setCollapsedGroups(new Set(groups.slice(1).map(([collection]) => `collection:${collection}`)))
  }, [groups])
  const detail = vault?.skills.find((skill) => skill.id === selectedSkillId) ?? filteredSkills[0]
  const detailRow: ComparisonRow | undefined = comparison?.rows.find((row) => row.skillId === detail?.id)
  const detailEntry = detail && agent ? entryForSkill(agent.entries, detail) : undefined
  const actualDetailEntry = view === "actual" && agent && actualSelectedPath ? agent.entries.find((entry) => entry.relativePath === actualSelectedPath) : undefined
  const detailRecord = detail && selectedAgentId ? (config.links ?? []).find((record) => record.agentId === selectedAgentId && record.skill === detail.id) : undefined
  const validSelected = selectedIds.filter((id) => vault?.skills.some((skill) => skill.id === id && skill.validity === "valid")) ?? []

  function toggleSelected(id: string): void {
    setSelectedIds(function updateSelection(current): string[] {
      if (current.includes(id)) return current.filter(function (item): boolean { return item !== id })
      return [...current, id]
    })
  }
  function toggleCollection(skills: VaultSkill[]): void {
    const validIds = skills.filter((skill) => skill.validity === "valid").map((skill) => skill.id)
    setSelectedIds(function updateSelection(current): string[] {
      const allSelected = validIds.length > 0 && validIds.every((id) => current.includes(id))
      if (allSelected) return current.filter((id) => !validIds.includes(id))
      return [...new Set([...current, ...validIds])]
    })
  }
  async function saveConfig(next: SkillManagerConfig): Promise<void> {
    try {
      const result = await api.putConfig(next)
      setConfig(result.config)
      setNotice("配置已保存；未触碰任何真实目录")
      await load()
    } catch (saveError) {
      setError(displayError(saveError))
    }
  }
  function commitVaultPath(nextPath: string): void {
    const path = nextPath.trim()
    if (!path) { setError("Vault 路径不能为空"); return }
    if (path === config.vault.path) return
    void saveConfig({ ...config, vault: { ...config.vault, path } })
  }
  function commitVaultHost(nextHost: HostKind): void {
    if (nextHost === config.vault.host) return
    void saveConfig({ ...config, vault: { ...config.vault, host: nextHost } })
  }
  async function saveAgent(): Promise<void> {
    if (!agentModal?.name.trim() || !agentModal.path.trim() || !agentModal.id.trim()) {
      setError("Agent 的 ID、名称和路径都不能为空")
      return
    }
    const editing = config.agents.some(function (item): boolean { return item.id === agentModal.id })
    const agents = editing
      ? config.agents.map(function (item): AgentConfig { return item.id === agentModal.id ? agentModal : item })
      : [...config.agents, agentModal]
    await saveConfig({ ...config, agents, selectedAgentId: agentModal.id })
    setAgentModal(null)
  }

  async function deleteAgent(item: AgentConfig): Promise<void> {
    if (!window.confirm(`只删除配置中的 Agent「${item.name}」，不删除实际目录。继续？`)) return
    const nextAgents = config.agents.filter(function (agentValue): boolean { return agentValue.id !== item.id })
    const nextConfig: SkillManagerConfig = { ...config, agents: nextAgents }
    if (nextAgents[0]) nextConfig.selectedAgentId = nextAgents[0].id
    await saveConfig(nextConfig)
  }

  async function convertDetailCopy(): Promise<void> {
    if (!selectedAgentId || !detailEntry || detailEntry.kind !== "repo-copy") return
    if (!window.confirm(`将「${detailEntry.name}」转为链接？\n\n本地目录将被替换为指向 vault 的链接。若你在拷贝里改过文件（例如 SKILL.md），改动会丢失。`)) return
    setSyncExecuting(true)
    setError(null)
    try {
      const response = await api.convertAgentLink(selectedAgentId, detailEntry.name)
      if (response.result.success) { setNotice(`${detailEntry.name} 已转为链接`); await load() }
      else setError(response.result.error ?? response.result.message)
    } catch (convertError) { setError(displayError(convertError)) } finally { setSyncExecuting(false) }
  }

  async function deleteDetailLink(entry: { name: string }, broken: boolean): Promise<void> {
    if (!selectedAgentId) return
    if (!window.confirm(`删除 ${broken ? "断链" : "链接"}「${entry.name}」？\n\n只会删除链接，不会删除 vault 里的技能。`)) return
    setSyncExecuting(true)
    setError(null)
    try {
      const response = await api.deleteAgentLink(selectedAgentId, entry.name)
      if (response.result?.success) { setNotice(`链接「${entry.name}」已删除`); await load() }
      else setError(response.result?.error ?? response.preflight?.risks.join("；") ?? "链接未删除")
    } catch (deleteError) { setError(displayError(deleteError)) } finally { setSyncExecuting(false) }
  }

  async function openPreview(): Promise<void> {
    if (!selectedAgentId || !validSelected.length) return
    setPreviewLoading(true)
    setError(null)
    try {
      const result = await api.plan(selectedAgentId, validSelected)
      setPreview(result.plan)
    } catch (previewError) {
      setError(displayError(previewError))
    } finally {
      setPreviewLoading(false)
    }
  }
  async function executeSync(): Promise<void> {
    if (!preview || !selectedAgentId) return
    const createCount = preview.operations.filter(function (operation): boolean { return operation.action === "create-link" }).length
    if (!window.confirm(`确认真实创建 ${createCount} 个 Skill 链接？\n\n不会修改 Vault。冲突条目会保持阻止。`)) return
    setSyncExecuting(true)
    setError(null)
    try {
      const result = await api.executeSync(selectedAgentId, preview.selectedSkillIds)
      if (result.execution === "completed") {
        setNotice("Skill 链接已创建；Agent 扫描已刷新")
      } else {
        const failures = result.results.filter(function (item): boolean { return !item.success }).map(function (item): string { return `${item.skillId}: ${item.error ?? item.message}` })
        setError(failures.join("；") || "部分 Skill 链接未创建")
      }
      setPreview(null)
      await load()
    } catch (syncError) {
      setError(displayError(syncError))
    } finally {
      setSyncExecuting(false)
    }
  }
  function toggleGroup(key: string): void {
    setCollapsedGroups(function updateGroups(current): Set<string> {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  return <div className={dark ? "app dark" : "app"}>
    <header className="topbar"><div className="brand-mark">SV</div><div className="brand-copy"><strong>Skill Vault</strong><span>localhost workspace</span></div><div className="divider" /><nav className="top-tabs" aria-label="主导航"><button className={topTab === "skills" ? "top-tab active" : "top-tab"} onClick={() => setTopTab("skills")}>技能管理</button><button className={topTab === "links" ? "top-tab active" : "top-tab"} onClick={() => setTopTab("links")}>通用链接</button></nav><div className="top-spacer" /><button className="icon-button" aria-label={dark ? "切换浅色模式" : "切换深色模式"} aria-pressed={dark} onClick={() => setDark((value) => !value)}>{dark ? "☀" : "☾"}</button><span className="runtime-pill"><i /> WSL · 127.0.0.1:8787</span></header>
    {topTab === "links" ? <><div className="links-global-messages">{error && <div role="alert" className="skill-validation-banner">⚠ {error}<button onClick={() => setError(null)}>×</button></div>}{notice && <div className="notice-banner" role="status">{notice}<button onClick={() => setNotice(null)}>×</button></div>}</div><LinksWorkbench config={config} onConfigChange={setConfig} onNotice={(message) => setNotice(message)} onError={(message) => setError(message || null)} /></> : <main className="workspace">
      <section className="workspace-toolbar"><div className="vault-context"><span className="eyebrow">VAULT REPOSITORY</span><div className="vault-path-row"><input className="vault-path-input" aria-label="Vault 路径" title="直接编辑路径；回车或失焦保存，只写 data/config.json" value={vaultPathDraft} placeholder="未配置 Vault" onChange={(event) => setVaultPathDraft(event.target.value)} onBlur={(event) => commitVaultPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commitVaultPath(event.currentTarget.value) }} /><label className="host-inline">Host<select aria-label="Vault Host" value={config.vault.host} onChange={(event) => commitVaultHost(event.target.value as HostKind)}><option value="wsl">wsl</option><option value="windows">windows</option></select></label></div></div><button className="secondary-button" onClick={() => void load()} disabled={loading}>↻ 刷新</button>{vault && <span className={vault.summary.errors ? "validation-pill error" : vault.summary.warnings ? "validation-pill" : "validation-pill ok"}><b>{vault.summary.errors ? "!" : "✓"}</b> {vault.summary.errors} 错误 · {vault.summary.warnings} 警告</span>}</section>
      <section className="view-tabs" aria-label="技能视图">{([ ["repository", "Repository"], ["compare", "Compare"], ["actual", "Agent actual"]] as const).map(([key, label]) => <button key={key} className={view === key ? "view-tab active" : "view-tab"} onClick={() => { setView(key); if (key !== "actual") setActualSelectedPath(null) }}>{label}</button>)}<div className="toolbar-spacer" /><span className="shortcut-hint">按 <kbd>/</kbd> 搜索 · ↑↓ 移动 · Space 选择 · Esc 关闭</span><input ref={searchRef} aria-label="搜索技能" placeholder="搜索 skill、collection、描述…" value={query} onChange={(event) => setQuery(event.target.value)} /></section>
      {error && <div role="alert" className="skill-validation-banner">⚠ {error} <button onClick={() => void load()}>重试</button></div>}{notice && <div className="notice-banner" role="status">{notice}<button onClick={() => setNotice(null)}>×</button></div>}
      <section className="columns">
        <aside className="panel agent-panel"><div className="panel-heading"><span>AGENTS</span><button aria-label="添加 Agent" onClick={() => setAgentModal({ id: `agent-${Date.now()}`, name: "", host: "wsl", path: "" })}>＋</button></div><div className="agent-list">{loading && <div className="list-empty">正在读取 Agent…</div>}{!loading && !config.agents.length && <div className="list-empty">尚未配置 Agent</div>}{config.agents.map((item) => { const health = init?.agents.find((summary) => summary.id === item.id); return <div className={selectedAgentId === item.id ? "agent-row selected" : "agent-row"} key={item.id} role="button" tabIndex={0} onClick={() => void selectAgent(item.id)} onKeyDown={(event) => { if (event.key === "Enter") void selectAgent(item.id); if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusListItem("[data-agent-row]", event.currentTarget, event.key === "ArrowDown" ? 1 : -1) } }} data-agent-row><span className="agent-avatar">{item.name.slice(0, 1).toUpperCase() || "?"}</span><span className="agent-info"><b>{item.name}</b><small>{item.host} · {item.path}</small></span><span className="agent-state">{health?.issueCount ? `${health.issueCount} 问题` : "就绪"}</span><span className="agent-actions"><button aria-label={`编辑 ${item.name}`} onClick={(event) => { event.stopPropagation(); setAgentModal(item) }}>✎</button><button aria-label={`删除 ${item.name}`} onClick={(event) => { event.stopPropagation(); void deleteAgent(item) }}>×</button></span></div> })}</div><div className="panel-foot"><span>{config.agents.length} agents</span></div></aside>
        <SkillMatrix view={view} loading={loading} vault={vault} agent={agent} comparison={comparison} config={config} selectedAgentId={selectedAgentId} filteredSkills={filteredSkills} groups={groups} actualGroups={actualGroups} selectedSkillId={selectedSkillId} selectedIds={selectedIds} actualSelectedPath={actualSelectedPath} collapsedGroups={collapsedGroups} onToggleGroup={toggleGroup} onSelectSkill={(id) => setSelectedSkillId(id)} onSelectActual={(entry) => { setActualSelectedPath(entry.relativePath); if (entry.skillId) setSelectedSkillId(entry.skillId) }} onToggleSelected={toggleSelected} onToggleCollection={toggleCollection} />
        <aside className="panel detail-panel">{view === "actual" && actualDetailEntry && !actualDetailEntry.skillId ? <div className="detail-content"><div className="detail-title"><span className="detail-symbol">⌁</span><div><h2>{actualDetailEntry.name}</h2><p>Agent actual · {actualDetailEntry.relativePath}</p></div></div><div className="detail-section"><label>ENTRY KIND</label><code>{kindLabels[actualDetailEntry.kind] ?? actualDetailEntry.kind}</code></div><div className="detail-section"><label>PATH</label><code>{actualDetailEntry.absolutePath}</code></div><div className="detail-section"><label>TARGET</label><code>{actualDetailEntry.targetPath ?? "—"}</code></div><div className="detail-section"><label>RISKS</label><p className="risk-copy">{actualDetailEntry.issues.map((issue) => issue.message).join("；") || "无额外问题。"}</p></div>{(actualDetailEntry.kind === "external-link" || actualDetailEntry.kind === "broken-link") && <div className="detail-actions-row"><button className="secondary-button" disabled={syncExecuting} onClick={() => void deleteDetailLink(actualDetailEntry, actualDetailEntry.kind === "broken-link")}>删除链接</button></div>}</div> : detail ? <><div className="panel-heading"><span>SKILL DETAIL</span><span className={detail.validity === "valid" ? "detail-ok" : "detail-bad"}>{detail.validity}</span></div><div className="detail-content"><div className="detail-title"><span className="detail-symbol">✦</span><div><h2>{detail.id}</h2><p>{detail.collection} / {detail.relativePath}</p></div></div><div className="detail-section"><label>VAULT PATH</label><code>{detail.absolutePath}</code></div><div className="detail-section"><label>FRONTMATTER</label><pre>{detail.frontmatter.raw || "(empty)"}</pre></div><div className="detail-section"><label>VALIDATION</label>{detail.issues.length ? detail.issues.map((issue) => <div key={issue.code} className={issue.severity === "error" ? "validation-line bad" : "validation-line warn"}><span>{issue.severity === "error" ? "!" : "⚠"}</span>{issue.message}</div>) : <div className="validation-line good"><span>✓</span>目录名与 name 完全匹配</div>}</div><div className="detail-section"><label>AGENT ENTRY · {(config.agents.find((item) => item.id === selectedAgentId)?.name ?? "未选择").toUpperCase()}</label>{detailEntry ? <div className="agent-entry"><span className="entry-dot" />{kindLabels[detailEntry.kind] ?? detailEntry.kind}<code>{detailEntry.absolutePath}{detailEntry.targetPath ? ` → ${detailEntry.targetPath}` : ""}</code></div> : <div className="detail-hint">当前 Agent 没有同名实际条目；状态：{detailRow ? stateLabels[detailRow.state] : "未扫描"}</div>}{detailEntry && <div className="detail-actions-row">{detailEntry.kind === "repo-copy" && <button className="secondary-button" disabled={syncExecuting} onClick={() => void convertDetailCopy()}>转为链接</button>}{detailEntry.kind === "repo-link" && <button className="secondary-button" disabled={syncExecuting} onClick={() => void deleteDetailLink(detailEntry, false)}>删除链接</button>}{detailEntry.kind === "broken-link" && <button className="secondary-button" disabled={syncExecuting} onClick={() => void deleteDetailLink(detailEntry, true)}>删除断链</button>}</div>}{detailRecord && detailEntry && <p className="risk-copy">来源集合：{detailRecord.collection || "（Vault 顶层）"}（已记录在配置中）</p>}</div><div className="detail-section"><label>FLAT LINK PATH</label><code>{selectedAgentId && config.agents.find((item) => item.id === selectedAgentId) ? `${config.agents.find((item) => item.id === selectedAgentId)!.path}/${detail.name ?? detail.directoryName}` : "—"}</code></div><div className="detail-section"><label>RISKS</label><p className="risk-copy">{[...detail.issues.map((issue) => issue.message), ...(detailRow?.risks ?? [])].join("；") || "无阻塞风险。确认后可创建链接。"}</p></div></div></> : <div className="empty-state">选择一个条目查看详情</div>}</aside>
      </section><footer className="statusbar"><span><i className="status-dot" />{loading ? "正在连接服务…" : vault ? `扫描完成 · 全部 ${vault.summary.total} 个 Skill 已发现 · ${validSelected.length} 个已选择${vault.summary.ignoredDirs ? ` · 跳过 ${vault.summary.ignoredDirs} 个无关目录` : ""}` : "服务未连接"}</span><span>Vault 只读 · 确认后可真实创建链接</span></footer>
    </main>}
    {agentModal && <div className="modal-backdrop show" role="dialog" aria-modal="true" onClick={(event) => { if (event.target === event.currentTarget) setAgentModal(null) }}><div className="modal"><h3>{config.agents.some((item) => item.id === agentModal.id) ? "编辑 Agent" : "添加 Agent"}</h3><label>ID<input disabled={config.agents.some((item) => item.id === agentModal.id)} value={agentModal.id} onChange={(event) => setAgentModal({ ...agentModal, id: event.target.value })} /></label><label>名称<input autoFocus value={agentModal.name} onChange={(event) => setAgentModal({ ...agentModal, name: event.target.value })} /></label><label>Host<select value={agentModal.host} onChange={(event) => setAgentModal({ ...agentModal, host: event.target.value as HostKind })}><option value="wsl">wsl</option><option value="windows">windows</option></select></label><label>实际路径<input value={agentModal.path} onChange={(event) => setAgentModal({ ...agentModal, path: event.target.value })} /></label><p className="hint">此操作只写配置，不触碰 Agent 目录。</p><div className="modal-actions"><button onClick={() => setAgentModal(null)}>取消</button><button className="primary-button" onClick={() => void saveAgent()}>保存</button></div></div></div>}
    {preview && <div className="modal-backdrop show" role="dialog" aria-modal="true" aria-labelledby="preview-title" onClick={(event) => { if (event.target === event.currentTarget) setPreview(null) }}><div className="modal modal-wide preview-modal"><h3 id="preview-title">同步预览 · 确认后执行</h3><p className="preview-explainer">选择了 <b>{preview.selectedSkillIds.length}</b> 个 Skill；每项都显示目标、扁平 Link Path、策略和风险。点击确认后，后台会真实创建缺失的链接。</p><div className="preview-list">{preview.operations.map((operation) => <article className="preview-operation" key={operation.id}><div className="preview-operation-head"><b>{operation.skillId}</b><span className={operationClass(operation.action)}>{operationText(operation.action)}</span></div><div className="preview-grid"><label>target<code>{operation.targetPath ?? "—"}</code></label><label>flattened link path<code>{operation.linkPath ?? "—"}</code></label><label>link strategy<code>{operation.link?.kind ?? "blocked"}</code></label><label>typed operation<code>{typedOperation(operation)}</code></label></div><div className="preview-risk">risk: {operation.risks.join("；") || "none"}</div><div className="preview-execution">execution=<b>{operation.execution}</b></div></article>)}</div><div className="modal-actions"><button ref={previewCloseRef} onClick={() => setPreview(null)}>关闭</button><button className="primary-button" disabled={syncExecuting || !preview.operations.some((operation) => operation.action === "create-link")} onClick={() => void executeSync()}>{syncExecuting ? "执行中…" : "确认并执行"}</button></div></div></div>}
  </div>
}
