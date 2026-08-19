import { useCallback, useEffect, useMemo, useState } from "react"
import type { AgentConfig, AgentEntry, AgentScan, ComparisonRow, HostKind, SkillManagerConfig, VaultSkill, VaultScan } from "../core/types.ts"
import { api, type InitResponse } from "./api"

type TopTab = "skills" | "links"
type View = "repository" | "compare" | "actual"
type AgentDraft = { id: string; name: string; host: HostKind; path: string }

const stateLabels: Record<string, string> = { linked: "已链接", pending: "待链接", "local-dir": "本地目录", "external-link": "外部链接", "broken-link": "断链", invalid: "无效" }
const kindLabels: Record<string, string> = { "repo-link": "repo-link", "repo-copy": "repo-copy", "local-dir": "local-dir", "external-link": "external-link", "broken-link": "broken-link", invalid: "invalid" }
const emptyConfig: SkillManagerConfig = { schemaVersion: 1, vault: { path: "", host: "wsl" }, agents: [] }

function stateClass(value: string): string { return value === "linked" ? "status-tag linked" : value === "pending" ? "status-tag pending" : value === "invalid" || value === "broken-link" ? "status-tag invalid" : "status-tag" }
function entryForSkill(entries: AgentEntry[], skill: VaultSkill): AgentEntry | undefined { return entries.find((entry) => entry.skillId === skill.id || (!entry.skillId && entry.name === skill.directoryName)) }
function displayError(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export function App() {
  const [topTab, setTopTab] = useState<TopTab>("skills")
  const [view, setView] = useState<View>("compare")
  const [dark, setDark] = useState(false)
  const [init, setInit] = useState<InitResponse | null>(null)
  const [config, setConfig] = useState<SkillManagerConfig>(emptyConfig)
  const [vault, setVault] = useState<VaultScan | null>(null)
  const [agent, setAgent] = useState<AgentScan | null>(null)
  const [comparison, setComparison] = useState<InitResponse["vault"] extends never ? never : import("../core/types.ts").ComparisonResult | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState("")
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [agentModal, setAgentModal] = useState<AgentDraft | null>(null)
  const [configModal, setConfigModal] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const loadAgent = useCallback(async (id: string, vaultValue: VaultScan) => {
    const result = await api.agent(id)
    setAgent(result.agent); setComparison(result.comparison)
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

  const selectAgent = async (id: string) => {
    if (!vault) return
    setSelectedAgentId(id); setError(null)
    try { await loadAgent(id, vault) } catch (loadError) { setError(displayError(loadError)) }
  }
  const filteredSkills = useMemo(() => {
    if (!vault) return []
    const needle = query.normalize("NFKC").toLocaleLowerCase("en-US").trim()
    return vault.skills.filter((skill) => !needle || [skill.id, skill.name ?? "", skill.collection, skill.description ?? "", skill.relativePath].join(" ").normalize("NFKC").toLocaleLowerCase("en-US").includes(needle))
  }, [vault, query])
  const groups = useMemo(() => {
    const map = new Map<string, VaultSkill[]>()
    for (const skill of filteredSkills) map.set(skill.collection, [...(map.get(skill.collection) ?? []), skill])
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filteredSkills])
  const detail = vault?.skills.find((skill) => skill.id === selectedSkillId) ?? filteredSkills[0]
  const detailRow: ComparisonRow | undefined = comparison?.rows.find((row) => row.skillId === detail?.id)
  const detailEntry = detail && agent ? entryForSkill(agent.entries, detail) : undefined
  const validSelected = selectedIds.filter((id) => vault?.skills.some((skill) => skill.id === id && skill.validity === "valid")) ?? []

  const toggleSelected = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const saveConfig = async (next: SkillManagerConfig) => { try { const result = await api.putConfig(next); setConfig(result.config); setNotice("配置已保存；未触碰任何真实目录"); setConfigModal(false); await load() } catch (saveError) { setError(displayError(saveError)) } }
  const saveAgent = async () => {
    if (!agentModal?.name.trim() || !agentModal.path.trim() || !agentModal.id.trim()) { setError("Agent 的 ID、名称和路径都不能为空"); return }
    const next = { ...config, agents: config.agents.some((item) => item.id === agentModal.id) ? config.agents.map((item) => item.id === agentModal.id ? agentModal : item) : [...config.agents, agentModal], selectedAgentId: agentModal.id }
    await saveConfig(next); setAgentModal(null)
  }
  const deleteAgent = async (item: AgentConfig) => { if (!window.confirm(`只删除配置中的 Agent「${item.name}」，不删除实际目录。继续？`)) return; const nextAgents = config.agents.filter((agentValue) => agentValue.id !== item.id); await saveConfig({ ...config, agents: nextAgents, ...(nextAgents[0] ? { selectedAgentId: nextAgents[0].id } : {}) }) }

  return <div className={dark ? "app dark" : "app"}>
    <header className="topbar">
      <div className="brand-mark">SV</div><div className="brand-copy"><strong>Skill Vault</strong><span>localhost workspace</span></div><div className="divider" />
      <nav className="top-tabs" aria-label="主导航"><button className={topTab === "skills" ? "top-tab active" : "top-tab"} onClick={() => setTopTab("skills")}>技能管理</button><button className={topTab === "links" ? "top-tab active" : "top-tab"} onClick={() => setTopTab("links")}>通用链接</button></nav>
      <div className="top-spacer" /><button className="icon-button" aria-label="切换主题" onClick={() => setDark((value) => !value)}>{dark ? "☀" : "☾"}</button><span className="runtime-pill"><i /> WSL · 127.0.0.1:8787</span>
    </header>
    {topTab === "links" ? <main className="placeholder-page"><div className="empty-icon">↗</div><h1>通用链接</h1><p>通用链接工作台是后续阶段；当前导航不会触碰文件系统。</p><span className="soft-badge">Phase 2 · 占位</span></main> : <main className="workspace">
      <section className="workspace-toolbar"><div className="vault-context"><span className="eyebrow">VAULT REPOSITORY</span><strong>{config.vault.path || "未配置 Vault"}</strong></div><button className="secondary-button" onClick={() => setConfigModal(true)}>⚙ 配置</button><button className="secondary-button" onClick={() => void load()} disabled={loading}>↻ 刷新</button>{vault && <span className="validation-pill"><b>{vault.summary.issueCount ? "!" : "✓"}</b> {vault.summary.issueCount} 个问题</span>}</section>
      <section className="view-tabs" aria-label="技能视图"><button className="view-tab active">Compare</button><div className="toolbar-spacer" /><span className="shortcut-hint">按 <kbd>/</kbd> 搜索</span><input aria-label="搜索技能" placeholder="搜索 skill、collection、描述…" value={query} onChange={(event) => setQuery(event.target.value)} /></section>
      {error && <div role="alert" className="skill-validation-banner">⚠ {error} <button onClick={() => void load()}>重试</button></div>}
      {notice && <div className="notice-banner" role="status">{notice}<button onClick={() => setNotice(null)}>×</button></div>}
      <section className="columns">
        <aside className="panel agent-panel"><div className="panel-heading"><span>AGENTS</span><button aria-label="添加 Agent" onClick={() => setAgentModal({ id: `agent-${Date.now()}`, name: "", host: "wsl", path: "" })}>＋</button></div><div className="agent-list">{loading && <div className="list-empty">正在读取 Agent…</div>}{!loading && !config.agents.length && <div className="list-empty">尚未配置 Agent</div>}{config.agents.map((item) => { const health = init?.agents.find((summary) => summary.id === item.id); return <div className={selectedAgentId === item.id ? "agent-row selected" : "agent-row"} key={item.id} role="button" tabIndex={0} onClick={() => void selectAgent(item.id)} onKeyDown={(event) => { if (event.key === "Enter") void selectAgent(item.id) }}><span className="agent-avatar">{item.name.slice(0, 1).toUpperCase() || "?"}</span><span className="agent-info"><b>{item.name}</b><small>{item.host} · {item.path}</small></span><span className="agent-state">{health?.issueCount ? `${health.issueCount} 问题` : "就绪"}</span><span className="agent-actions"><button aria-label={`编辑 ${item.name}`} onClick={(event) => { event.stopPropagation(); setAgentModal(item) }}>✎</button><button aria-label={`删除 ${item.name}`} onClick={(event) => { event.stopPropagation(); void deleteAgent(item) }}>×</button></span></div> })}</div><div className="panel-foot"><span>{config.agents.length} agents</span><button onClick={() => setConfigModal(true)}>管理</button></div></aside>
        <section className="panel skill-panel"><div className="panel-heading"><span>VAULT SKILLS · COMPARE</span><span className="result-count">{filteredSkills.length} / {vault?.summary.total ?? 0} 项</span></div><div className="skill-groups">{loading && <div className="list-empty">正在扫描 Vault…</div>}{!loading && !groups.length && <div className="list-empty">没有匹配的 Skill</div>}{groups.map(([collection, skills]) => <div className="skill-group" key={collection}><div className="group-heading"><span>⌄</span><b>{collection}</b><small>{skills.length}</small></div>{skills.map((skill) => { const row = comparison?.rows.find((item) => item.skillId === skill.id); const status = row?.state ?? (skill.validity === "invalid" ? "invalid" : "pending"); const canSelect = skill.validity === "valid"; return <div role="button" tabIndex={0} className={selectedSkillId === skill.id ? "skill-row selected" : "skill-row"} key={`${skill.relativePath}:${skill.id}`} onClick={() => setSelectedSkillId(skill.id)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedSkillId(skill.id); if (event.key === " ") { event.preventDefault(); if (canSelect) toggleSelected(skill.id) } }}><input aria-label={`选择 ${skill.id}`} disabled={!canSelect} type="checkbox" checked={selectedIds.includes(skill.id)} onChange={() => toggleSelected(skill.id)} onClick={(event) => event.stopPropagation()} /><span className="skill-name"><b>{skill.id}</b><small>{skill.relativePath}</small></span><span className={stateClass(status)}>{stateLabels[status] ?? status}</span></div> })}</div>)}</div><div className="panel-foot"><span>{validSelected.length} 项已选择</span><button className="primary-button" disabled={!validSelected.length} onClick={() => setNotice("T5 将在此处打开只读同步预览")}>预览同步 →</button></div></section>
        <aside className="panel detail-panel">{detail ? <><div className="panel-heading"><span>SKILL DETAIL</span><span className={detail.validity === "valid" ? "detail-ok" : "detail-bad"}>{detail.validity}</span></div><div className="detail-content"><div className="detail-title"><span className="detail-symbol">✦</span><div><h2>{detail.id}</h2><p>{detail.collection} / {detail.relativePath}</p></div></div><div className="detail-section"><label>VAULT PATH</label><code>{detail.absolutePath}</code></div><div className="detail-section"><label>FRONTMATTER</label><pre>{detail.frontmatter.raw || "(empty)"}</pre></div><div className="detail-section"><label>VALIDATION</label><div className={detail.validity === "valid" ? "validation-line good" : "validation-line bad"}><span>{detail.validity === "valid" ? "✓" : "!"}</span>{detail.validity === "valid" ? "目录名与 name 完全匹配" : detail.issues.map((issue) => issue.message).join("；")}</div></div><div className="detail-section"><label>AGENT ENTRY · {(config.agents.find((item) => item.id === selectedAgentId)?.name ?? "未选择").toUpperCase()}</label>{detailEntry ? <div className="agent-entry"><span className="entry-dot" />{kindLabels[detailEntry.kind] ?? detailEntry.kind}<code>{detailEntry.absolutePath}{detailEntry.targetPath ? ` → ${detailEntry.targetPath}` : ""}</code></div> : <div className="detail-hint">当前 Agent 没有同名实际条目；状态：{detailRow ? stateLabels[detailRow.state] : "未扫描"}</div>}</div><div className="detail-section"><label>FLAT LINK PATH</label><code>{selectedAgentId && config.agents.find((item) => item.id === selectedAgentId) ? `${config.agents.find((item) => item.id === selectedAgentId)!.path}/${detail.name ?? detail.directoryName}` : "—"}</code></div><div className="detail-section"><label>RISKS</label><p className="risk-copy">{[...detail.issues.map((issue) => issue.message), ...(detailRow?.risks ?? [])].join("；") || "无阻塞风险。同步仅生成预览，不执行文件操作。"}</p></div></div></> : <div className="empty-state">选择一个 Skill 查看详情</div>}</aside>
      </section>
      <footer className="statusbar"><span><i className="status-dot" />{loading ? "正在连接服务…" : vault ? `扫描完成 · ${vault.summary.total} 个 Skill · ${validSelected.length} 个已选择` : "服务未连接"}</span><span>Vault 只读 · 同步仅生成预览</span></footer>
    </main>}
    {configModal && <div className="modal-backdrop show" role="dialog" aria-modal="true"><div className="modal"><h3>配置</h3><label>Vault 路径<input value={config.vault.path} onChange={(event) => setConfig((current) => ({ ...current, vault: { ...current.vault, path: event.target.value } }))} /></label><label>Vault Host<select value={config.vault.host} onChange={(event) => setConfig((current) => ({ ...current, vault: { ...current.vault, host: event.target.value as HostKind } }))}><option value="wsl">wsl</option><option value="windows">windows</option></select></label><p className="hint">保存只修改 data/config.json；不会创建、删除或修改 Vault / Agent 实际路径。</p><div className="modal-actions"><button onClick={() => setConfigModal(false)}>取消</button><button className="primary-button" onClick={() => void saveConfig(config)}>保存</button></div></div></div>}
    {agentModal && <div className="modal-backdrop show" role="dialog" aria-modal="true"><div className="modal"><h3>{config.agents.some((item) => item.id === agentModal.id) ? "编辑 Agent" : "添加 Agent"}</h3><label>ID<input value={agentModal.id} onChange={(event) => setAgentModal({ ...agentModal, id: event.target.value })} /></label><label>名称<input value={agentModal.name} onChange={(event) => setAgentModal({ ...agentModal, name: event.target.value })} /></label><label>Host<select value={agentModal.host} onChange={(event) => setAgentModal({ ...agentModal, host: event.target.value as HostKind })}><option value="wsl">wsl</option><option value="windows">windows</option></select></label><label>实际路径<input value={agentModal.path} onChange={(event) => setAgentModal({ ...agentModal, path: event.target.value })} /></label><p className="hint">此操作只写配置，不触碰 Agent 目录。</p><div className="modal-actions"><button onClick={() => setAgentModal(null)}>取消</button><button className="primary-button" onClick={() => void saveAgent()}>保存</button></div></div></div>}
  </div>
}
