import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react"
import type { AgentConfig, AgentEntry, AgentScan, ComparisonResult, ComparisonRow, HostKind, SkillManagerConfig, SyncPlan, VaultScan, VaultSkill } from "../core/types.ts"
import { mirrorVaultForHost, synchronizeBaselineWithMirror } from "../core/baseline.ts"
import { api, type InitResponse } from "./api"
import { detectPathHost, isAbsolutePathForHost } from "../core/path-host.ts"
import { LinksWorkbench } from "./LinksWorkbench"
import { MirrorSyncWorkbench } from "./MirrorSyncWorkbench"
import { SkillMatrix } from "./SkillMatrix"

type TopTab = "skills" | "links" | "mirror"
type View = "repository" | "compare" | "actual"
type ActualMode = "collection" | "kind"
type AgentDraft = { id: string; name: string; host: HostKind; path: string }

const stateLabels: Record<string, string> = { linked: "已链接", pending: "待链接", "local-dir": "本地目录", "external-link": "外部链接", "broken-link": "断链", invalid: "无效", valid: "有效" }
const kindLabels: Record<string, string> = { "repo-link": "repo-link · Vault", "repo-copy": "repo-copy · 拷贝", "local-dir": "local-dir · 本地目录", "external-link": "external-link · 外部", "broken-link": "broken-link · 断链", invalid: "invalid · 无效" }
const emptyConfig: SkillManagerConfig = { schemaVersion: 1, autoDetectPathHost: true, vault: { path: "", host: "wsl" }, agents: [] }

function entryForSkill(entries: AgentEntry[], skill: VaultSkill): AgentEntry | undefined { return entries.find((entry) => entry.skillKey === skill.relativePath || (!entry.skillKey && entry.name === skill.directoryName)) }
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

function pathStyleHint(hostKind: HostKind): string {
  if (hostKind === "windows") return "Windows 主机需要 C:\\... 或 \\\\server\\share 形式的路径"
  if (hostKind === "macos") return "macOS 主机需要 /Users/... 形式的绝对路径"
  return "WSL 主机需要 / 开头的路径（Windows 盘符请写 /mnt/c/...）"
}

function posixHostFor(host: HostKind): "wsl" | "macos" { return host === "macos" ? "macos" : "wsl" }

export function App(): ReactElement {
  const [topTab, setTopTab] = useState<TopTab>("skills")
  const [view, setView] = useState<View>("compare")
  const [actualMode, setActualMode] = useState<ActualMode>("collection")
  const [showPaths, setShowPaths] = useState(false)
  const [dark, setDark] = useState(() => {
    try {
      const initial = window.localStorage.getItem("skills-manager-theme") === "dark"
      document.body.classList.toggle("light", !initial)
      return initial
    } catch { return false }
  })
  const [init, setInit] = useState<InitResponse | null>(null)
  const [config, setConfig] = useState<SkillManagerConfig>(emptyConfig)
  const isMacWorkspace = init?.runtimeHost === "macos"
  const autoDetectPathHost = config.autoDetectPathHost !== false
  const [vault, setVault] = useState<VaultScan | null>(null)
  const [agent, setAgent] = useState<AgentScan | null>(null)
  const [comparison, setComparison] = useState<ComparisonResult | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState("")
  const [selectedSkillKey, setSelectedSkillKey] = useState<string | null>(null)
  const [actualSelectedPath, setActualSelectedPath] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [diffOnly, setDiffOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [scanStale, setScanStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [agentModal, setAgentModal] = useState<AgentDraft | null>(null)
  const [vaultPathDraft, setVaultPathDraft] = useState("")
  const [preview, setPreview] = useState<SyncPlan | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [syncExecuting, setSyncExecuting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const collapsedGroupsInitialized = useRef(false)
  const previousTopTab = useRef<TopTab>("skills")
  const searchRef = useRef<HTMLInputElement>(null)
  const previewCloseRef = useRef<HTMLButtonElement>(null)

  const loadAgent = useCallback(async (id: string, vaultValue: NonNullable<typeof vault>) => {
    const result = await api.agent(id)
    setAgent(result.agent); setComparison(result.comparison); setActualSelectedPath(null)
    setSelectedSkillKey((current) => current && vaultValue.skills.some((skill) => skill.relativePath === current) ? current : vaultValue.skills[0]?.relativePath ?? null)
  }, [])
  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const initValue = await api.init(); const configValue = initValue.config.config; const vaultValue = (await api.vault()).vault
      setInit(initValue); setConfig(configValue); setVault(vaultValue); setScanStale(false)
      const id = initValue.selectedAgentId ?? configValue.selectedAgentId ?? configValue.agents[0]?.id ?? ""; setSelectedAgentId(id)
      if (id) await loadAgent(id, vaultValue); else { setAgent(null); setComparison(null); setSelectedSkillKey(vaultValue.skills[0]?.relativePath ?? null) }
    } catch (loadError) { setError(displayError(loadError)); setInit(null); setVault(null); setAgent(null); setComparison(null) } finally { setLoading(false) }
  }, [loadAgent])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const enteredSkills = previousTopTab.current !== "skills" && topTab === "skills"
    previousTopTab.current = topTab
    if (enteredSkills && scanStale) void load()
  }, [topTab, scanStale, load])
  useEffect(() => { setVaultPathDraft(config.vault.path) }, [config.vault.path])
  useEffect(() => {
    try { window.localStorage.setItem("skills-manager-theme", dark ? "dark" : "light") } catch { /* storage can be unavailable */ }
    document.body.classList.toggle("light", !dark)
  }, [dark])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key === "/" && target?.tagName !== "INPUT" && target?.tagName !== "TEXTAREA" && !preview && !agentModal) { event.preventDefault(); searchRef.current?.focus() }
      if (event.key === "Escape") { if (preview) setPreview(null); else if (agentModal) setAgentModal(null) }
    }
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown)
  }, [preview, agentModal])
  useEffect(() => { if (preview) setTimeout(() => previewCloseRef.current?.focus(), 0) }, [preview])

  const selectAgent = async (id: string) => { if (!vault) return; if (scanStale) { setNotice("当前 Host 的扫描结果待刷新，请先点击右上角刷新"); return } setSelectedAgentId(id); setError(null); try { await loadAgent(id, vault) } catch (loadError) { setError(displayError(loadError)) } }
  const filteredSkills = useMemo(() => {
    if (!vault) return []
    const needle = query.normalize("NFKC").toLocaleLowerCase("en-US").trim()
    const base = vault.skills.filter((skill) => !needle || [skill.id, skill.name ?? "", skill.collection, skill.description ?? "", skill.relativePath].join(" ").normalize("NFKC").toLocaleLowerCase("en-US").includes(needle))
    if (view === "compare" && diffOnly) return base.filter((skill) => comparison?.rows.find((row) => row.skillKey === skill.relativePath)?.state !== "linked")
    return base
  }, [vault, query, view, diffOnly, comparison])
  const groups = useMemo(() => { const map = new Map<string, VaultSkill[]>(); for (const skill of filteredSkills) map.set(skill.collection, [...(map.get(skill.collection) ?? []), skill]); return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)) }, [filteredSkills])
  const actualGroups = useMemo(() => { const map = new Map<string, AgentEntry[]>(); const needle = query.normalize("NFKC").toLocaleLowerCase("en-US").trim(); for (const entry of agent?.entries ?? []) if (!needle || [entry.name, entry.relativePath, entry.kind, entry.targetPath ?? ""].join(" ").normalize("NFKC").toLocaleLowerCase("en-US").includes(needle)) map.set(entry.kind, [...(map.get(entry.kind) ?? []), entry]); return [...map.entries()] }, [agent, query])
  useEffect(() => { collapsedGroupsInitialized.current = false }, [vault])
  useEffect(() => {
    if (collapsedGroupsInitialized.current || !groups.length) return
    collapsedGroupsInitialized.current = true
    setCollapsedGroups(new Set(groups.slice(1).map(([collection]) => `collection:${collection}`)))
  }, [groups])
  useEffect(() => { setDiffOnly(false) }, [view, selectedAgentId])
  const detail = vault?.skills.find((skill) => skill.relativePath === selectedSkillKey) ?? filteredSkills[0]
  const detailRow: ComparisonRow | undefined = comparison?.rows.find((row) => row.skillKey === detail?.relativePath)
  const detailEntry = detail && agent ? entryForSkill(agent.entries, detail) : undefined
  const actualDetailEntry = view === "actual" && agent && actualSelectedPath ? agent.entries.find((entry) => entry.relativePath === actualSelectedPath) : undefined
  const detailRecord = detail && selectedAgentId ? (config.links ?? []).find((record) => record.agentId === selectedAgentId && record.skill === detail.relativePath) : undefined
  const validSelected = selectedIds.filter((key) => vault?.skills.some((skill) => skill.relativePath === key && skill.validity === "valid"))

  function toggleSelected(id: string): void {
    setSelectedIds(function updateSelection(current): string[] {
      if (current.includes(id)) return current.filter(function (item): boolean { return item !== id })
      return [...current, id]
    })
  }
  function toggleCollection(skills: VaultSkill[]): void {
    const validIds = skills.filter((skill) => skill.validity === "valid").map((skill) => skill.relativePath)
    setSelectedIds(function updateSelection(current): string[] {
      const allSelected = validIds.length > 0 && validIds.every((id) => current.includes(id))
      if (allSelected) return current.filter((id) => !validIds.includes(id))
      return [...new Set([...current, ...validIds])]
    })
  }
  function applyMirrorConfig(next: SkillManagerConfig): void {
    const baselineChanged = next.vault.host !== config.vault.host || next.vault.path !== config.vault.path
    setConfig(next)
    if (baselineChanged) {
      setScanStale(true)
      setPreview(null)
    }
  }
  async function saveConfig(next: SkillManagerConfig, options: { reload?: boolean; notice?: string } = {}): Promise<void> {
    try {
      const result = await api.putConfig(next)
      setConfig(result.config)
      if (options.reload === false) {
        setScanStale(true)
        setPreview(null)
        setNotice(options.notice ?? "配置已保存；扫描结果待刷新")
        return
      }
      setNotice(options.notice ?? "配置已保存；未触碰任何真实目录")
      await load()
    } catch (saveError) {
      setError(displayError(saveError))
    }
  }
  function hostForPath(path: string, fallback: HostKind): HostKind {
    return autoDetectPathHost ? detectPathHost(path, posixHostFor(fallback)) ?? fallback : fallback
  }
  function commitAutoDetectPathHost(enabled: boolean): void {
    if (enabled === autoDetectPathHost) return
    void saveConfig({ ...config, autoDetectPathHost: enabled })
  }
  function commitVaultPath(nextPath: string): void {
    const path = nextPath.trim()
    const host = hostForPath(path, config.vault.host)
    if (!path) { setError("Vault 路径不能为空"); return }
    if (path === config.vault.path && host === config.vault.host) return
    if (!isAbsolutePathForHost(host, path)) { setError(`路径风格与主机不匹配：${pathStyleHint(host)}`); return }
    void saveConfig(synchronizeBaselineWithMirror(config, { path, host }), { reload: false, notice: "Baseline 已更新；扫描结果待刷新" })
  }
  function commitVaultHost(nextHost: HostKind): void {
    if (nextHost === config.vault.host) return
    const pairedVault = mirrorVaultForHost(config, nextHost)
    if (!pairedVault) {
      setError("切换 Host 前，请先在 Vault 镜像界面配置对应环境的路径")
      return
    }
    void saveConfig(synchronizeBaselineWithMirror(config, pairedVault), { reload: false, notice: "Host 已切换；扫描结果待刷新" })
  }
  async function saveAgent(): Promise<void> {
    if (!agentModal?.name.trim() || !agentModal.path.trim() || !agentModal.id.trim()) {
      setError("Agent 的 ID、名称和路径都不能为空")
      return
    }
    const path = agentModal.path.trim()
    const host = hostForPath(path, agentModal.host)
    if (!isAbsolutePathForHost(host, path)) {
      setError(`路径风格与主机不匹配：${pathStyleHint(host)}`)
      return
    }
    const savedAgent: AgentDraft = { ...agentModal, path, host }
    const editing = config.agents.some(function (item): boolean { return item.id === savedAgent.id })
    const agents = editing
      ? config.agents.map(function (item): AgentConfig { return item.id === savedAgent.id ? savedAgent : item })
      : [...config.agents, savedAgent]
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

  async function copyPath(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setNotice(`路径已复制：${text}`)
    } catch {
      setError("复制失败：剪贴板不可用")
    }
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
    if (scanStale) { setNotice("正在刷新当前 Host 的扫描结果…"); await load(); return }
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
    if (scanStale) { setNotice("正在刷新当前 Host 的扫描结果…"); await load(); return }
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
        const failures = result.results.filter(function (item): boolean { return !item.success }).map(function (item): string { return `${item.skillKey}: ${item.error ?? item.message}` })
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

  const selectedAgent = config.agents.find((item) => item.id === selectedAgentId)
  const compareStatDefs = (() => {
    const base = [
      { key: "linked", label: "已链接", tone: "green" },
      { key: "pending", label: "待链接", tone: "amber" },
    ] as const
    if (view === "compare" && comparison) {
      const sum = comparison.summary
      return [
        { label: "已链接", tone: "green", count: sum.linked },
        { label: "待链接", tone: "amber", count: sum.pending },
        { label: "断链/无效", tone: "red", count: sum["broken-link"] + sum["invalid"] },
        { label: "Agent 额外", tone: "gray", count: comparison.actualOnly.length },
      ]
    }
    if (view === "repository" && vault) {
      return [
        { label: "有效", tone: "green", count: vault.summary.valid },
        { label: "警告", tone: "amber", count: vault.summary.warnings },
        { label: "错误", tone: "red", count: vault.summary.errors },
        { label: "总计", tone: "gray", count: vault.summary.total },
      ]
    }
    if (view === "actual" && agent) {
      return [
        { label: "条目", tone: "gray", count: agent.entries.length },
        { label: "链接", tone: "green", count: agent.entries.filter((e) => e.targetPath).length },
        { label: "断链", tone: "red", count: agent.entries.filter((e) => e.kind === "broken-link").length },
      ]
    }
    return base.map((b) => ({ label: b.label, tone: b.tone, count: 0 }))
  })()
  const targetLabel = view === "actual" ? "Agent actual" : view === "repository" ? "Vault（审计）" : (selectedAgent?.name ?? "未选择 Agent")
  const targetCaption = view === "actual" ? (selectedAgent?.path ?? "") : view === "repository" ? (config.vault.path || "") : (selectedAgent?.path ?? "")
  const statusPill = detail ? (detail.validity === "valid" ? { text: "有效", tone: "good" } : { text: "无效", tone: "bad" }) : { text: "—", tone: "gray" }
  const inspectorKind = actualDetailEntry ? kindLabels[actualDetailEntry.kind] ?? actualDetailEntry.kind : undefined
  const showLinks = topTab === "links"
  const showMirror = topTab === "mirror" && !isMacWorkspace
  const showSkills = !showLinks && !showMirror

  return <div className={dark ? "app" : "app light"}>
    <header className="topbar">
      <div className="logo">SV</div>
      <div className="brand">Skill Vault<small>local workspace</small></div>
      <div className="divider" />
      <nav className="nav" aria-label="主导航">
        <button className={topTab === "skills" ? "active" : ""} onClick={() => setTopTab("skills")}>技能管理</button>
        <button className={topTab === "links" ? "active" : ""} onClick={() => setTopTab("links")}>通用链接</button>
        {!isMacWorkspace && <button className={topTab === "mirror" ? "active" : ""} onClick={() => setTopTab("mirror")}>Vault 镜像</button>}
      </nav>
      <div className="spacer" />
      <button className="icon-button" aria-label="刷新数据" title="重新加载配置与扫描结果" onClick={() => void load()}>⟳</button>
      <button className="icon-button toggle-theme" aria-label={dark ? "切换浅色模式" : "切换深色模式"} aria-pressed={dark} onClick={() => setDark((value) => !value)}>{dark ? "☀" : "☾"}</button>
    </header>

    {showLinks && <LinksWorkbench config={config} onConfigChange={setConfig} onNotice={setNotice} onError={(message) => setError(message || null)} />}
    {showMirror && <MirrorSyncWorkbench config={config} onConfigChange={applyMirrorConfig} onNotice={setNotice} onError={(message) => setError(message || null)} />}
    {showSkills && (
      <main className="workspace">
        <aside className="left">
          <div className="pane-head"><span>Agent 目标</span><div className="head-actions"><button className="head-btn" title="添加 Agent" aria-label="添加 Agent" onClick={() => setAgentModal({ id: `agent-${Date.now()}`, name: "", host: isMacWorkspace ? "macos" : "wsl", path: "" })}><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></svg></button></div></div>
          <div className="baseline-box">
            <div className="baseline-label"><svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1-1h6v9h-11z" /></svg>Baseline repository</div>
            <div className="repo-field"><svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1-1h6v9h-11z" /></svg>
              <input aria-label="Vault 路径" title="直接编辑路径，回车或失焦保存（只写 data/config.json）" value={vaultPathDraft} placeholder="未配置 Vault" onChange={(event) => setVaultPathDraft(event.target.value)} onBlur={(event) => commitVaultPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur() } }} />
              <button className="repo-copy-btn" aria-label="复制 Vault 路径" title="复制 Vault 路径" onClick={() => void copyPath(config.vault.path)}>⧉</button>
            </div>
            <div className="repo-options"><label><input type="checkbox" checked={autoDetectPathHost} onChange={(event) => commitAutoDetectPathHost(event.target.checked)} />自动识别路径类型</label><label>Host{isMacWorkspace ? <span>macos</span> : <select value={config.vault.host} onChange={(event) => commitVaultHost(event.target.value as HostKind)}><option value="wsl">wsl</option><option value="windows">windows</option></select>}</label></div>
          </div>
          <div className="agent-list">
            {loading && <div className="list-empty">正在读取 Agent…</div>}
            {!loading && !config.agents.length && <div className="list-empty">尚未配置 Agent</div>}
            {config.agents.map((item) => {
              const health = init?.agents.find((summary) => summary.id === item.id)
              return <div className={selectedAgentId === item.id ? "agent-row active" : "agent-row"} key={item.id} role="button" tabIndex={0} onClick={() => void selectAgent(item.id)} onKeyDown={(event) => { if (event.key === "Enter") void selectAgent(item.id); if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusListItem("[data-agent-row]", event.currentTarget, event.key === "ArrowDown" ? 1 : -1) } }} data-agent-row>
                <span className="agent-icon">{item.name.slice(0, 1).toUpperCase() || "?"}</span>
                <span className="agent-copy"><strong>{item.name}</strong><small>{item.host} · {item.path}</small></span>
                <span className="agent-issue">{health?.issueCount ? `${health.issueCount} 问题` : "就绪"}</span>
                <span className="agent-actions"><button aria-label={`复制 ${item.name} 路径`} title="复制路径" onClick={(event) => { event.stopPropagation(); void copyPath(item.path) }}>⧉</button><button aria-label={`编辑 ${item.name}`} onClick={(event) => { event.stopPropagation(); setAgentModal(item) }}>✎</button><button aria-label={`删除 ${item.name}`} onClick={(event) => { event.stopPropagation(); void deleteAgent(item) }}>×</button></span>
              </div>
            })}
          </div>
          <div className="left-foot"><span>{config.agents.length} agents · baseline fixed</span></div>
        </aside>

        <main className="center">
          <div className="center-top">
            <div className="breadcrumb">{targetCaption || "VAULT / 未配置"}</div>
            <div className="compare-row">
              <div className="compare-context" title="当前对比">
                <div className="compare-side"><svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1-1h6v9h-11z" /></svg><span>Baseline</span><strong>Vault repository</strong></div>
                <div className="compare-arrow">↔</div>
                <div className="compare-side"><svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5 6h6M5 9h4" /></svg><span>Target</span><strong>{targetLabel}</strong></div>
              </div>
              <div className="compare-stats">
                {compareStatDefs.map((stat) => <span key={stat.label} className={`stat ${stat.tone}`}><span className="dot" /><b>{stat.count}</b> {stat.label}</span>)}
              </div>
              {view === "compare" && <button className="btn" onClick={() => setDiffOnly((value) => !value)} style={diffOnly ? { background: "var(--selected-strong)", color: "var(--white)" } : undefined}>仅看差异</button>}
            </div>
            <div className="toolbar">
              <div className="summary" style={{ marginRight: "auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{view === "actual" ? <><span>{view === "actual" && agent ? `${agent.entries.length} 项` : ""} Agent 实际条目</span></> : <><span>{groups.length} 个集合</span> <span>· {filteredSkills.length} 个 Skill</span></>}</div>
              <div className="segment" role="tablist" aria-label="技能视图">
                {([["repository", "Repository"], ["compare", "Compare"], ["actual", "Agent actual"]] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={view === key} className={view === key ? "active" : ""} onClick={() => { setView(key); if (key !== "actual") setActualSelectedPath(null) }}>{label}</button>)}
              </div>
              {view === "actual" && <div className="segment" role="tablist" aria-label="Agent 实际视图">
                {([["collection", "按集合"], ["kind", "按类型"]] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={actualMode === key} className={actualMode === key ? "active" : ""} onClick={() => setActualMode(key)}>{label}</button>)}
              </div>}
              <button className="btn" onClick={() => setCollapsedGroups(new Set())} title="展开所有分组">全部展开</button>
              <button className={showPaths ? "btn active-path" : "btn"} onClick={() => setShowPaths((value) => !value)} title="在列表中显示路径（默认只显示在右侧详情）">路径</button>
              <input ref={searchRef} className="search" aria-label="搜索技能" placeholder="搜索 skill、collection、描述…" value={query} onChange={(event) => setQuery(event.target.value)} />
              {view !== "actual" && <button className="btn" disabled={!validSelected.length} onClick={() => void openPreview()} title="预览同步计划">{validSelected.length} 个选择</button>}
              {view !== "actual" && <button className="btn primary" disabled={!validSelected.length || previewLoading} onClick={() => void openPreview()}>{previewLoading ? "计算中…" : "预览同步 →"}</button>}
              <span className="kbd-hint">按 <kbd>/</kbd> 搜索 · <kbd>Space</kbd> 选择 · <kbd>Esc</kbd> 关闭</span>
            </div>
          </div>
          {error && <div className="banner banner-error" role="alert">⚠ {error} <button onClick={() => void load()}>重试</button><button onClick={() => setError(null)}>×</button></div>}
          {isMacWorkspace && init && !init.config.exists && <div className="banner banner-notice" role="status">首次运行：请先配置 Mac Vault 和 Agent 路径。应用不会自动扫描 home 目录。</div>}
          {scanStale && <div className="banner banner-notice" role="status">当前 Host 的扫描结果待刷新。点击右上角刷新。<button onClick={() => void load()}>立即刷新</button></div>}
          {notice && <div className="banner banner-notice" role="status">{notice}<button onClick={() => setNotice(null)}>×</button></div>}
          <SkillMatrix view={view} actualMode={actualMode} showPaths={showPaths} loading={loading} vault={vault} agent={agent} comparison={comparison} config={config} selectedAgentId={selectedAgentId} filteredSkills={filteredSkills} groups={groups} actualGroups={actualGroups} selectedSkillKey={selectedSkillKey} selectedIds={selectedIds} actualSelectedPath={actualSelectedPath} collapsedGroups={collapsedGroups} onToggleGroup={toggleGroup} onSelectSkill={(key) => setSelectedSkillKey(key)} onSelectActual={(entry) => { setActualSelectedPath(entry.relativePath); if (entry.skillKey) setSelectedSkillKey(entry.skillKey) }} onToggleSelected={toggleSelected} onToggleCollection={toggleCollection} />
        </main>

        <aside className="right">
          <div className="inspector-head">
            <div className="inspector-title"><strong>{actualDetailEntry ? actualDetailEntry.name : (detail?.id ?? "—")}</strong><span>{actualDetailEntry ? `/agent/${actualDetailEntry.relativePath}` : (detail ? `${detail.collection} / ${detail.relativePath}` : "未选择条目")}</span></div>
            <span className={`status-pill ${statusPill.tone}`}>{actualDetailEntry ? (actualDetailEntry.kind === "broken-link" ? "断链" : actualDetailEntry.kind) : statusPill.text}</span>
          </div>
          <div className="inspector-scroll">
            {actualDetailEntry && !actualDetailEntry.skillKey ? <>
              <section className="inspector-section"><div className="section-label">Entry 类型</div><div className="compare-card">
                <div className="compare-card-side"><div className="k">Agent</div><strong>{actualDetailEntry.name}</strong><code>{actualDetailEntry.relativePath}</code></div>
                <div className="compare-card-mid">↔</div>
                <div className="compare-card-side"><div className="k">Repository</div><strong>—</strong><code>不在 Vault</code></div>
              </div></section>
              <section className="inspector-section"><div className="section-label">路径</div><div className="path-box">{actualDetailEntry.absolutePath}</div></section>
              {actualDetailEntry.targetPath && <section className="inspector-section"><div className="section-label">链接目标</div><div className="path-box">{actualDetailEntry.targetPath}</div></section>}
              <section className="inspector-section"><div className="section-label">风险</div>{actualDetailEntry.issues.length ? actualDetailEntry.issues.map((issue) => <div className="risk" key={issue.code}><span className={`risk-mark ${issue.severity === "error" ? "bad" : ""}`} /><span>{issue.message}</span></div>) : <div className="desc">无额外问题。</div>}</section>
              {(actualDetailEntry.kind === "external-link" || actualDetailEntry.kind === "broken-link") && <section className="inspector-section"><div className="section-label">操作</div><div className="inspector-actions"><button className="btn" disabled={syncExecuting} onClick={() => void deleteDetailLink(actualDetailEntry, actualDetailEntry.kind === "broken-link")}>删除链接</button></div></section>}
            </> : detail ? <>
              <section className="inspector-section"><div className="section-label">对比</div><div className="compare-card">
                <div className="compare-card-side"><div className="k">Repository</div><strong>存在</strong><code>/vault/skills/{detail.relativePath}</code></div>
                <div className="compare-card-mid">↔</div>
                <div className="compare-card-side"><div className="k">{selectedAgent?.name ?? "Agent"}</div><strong>{detailEntry ? (detailEntry.kind === "repo-link" ? "已链接" : "存在（未链接）") : (detailRow?.state === "linked" ? "已链接" : "缺失")}</strong><code>{detailRow?.agentEntryPaths.join("、") || "—"}</code></div>
              </div></section>
              <section className="inspector-section"><div className="section-label">Vault 路径</div><div className="path-box">{detail.absolutePath}</div></section>
              <section className="inspector-section"><div className="section-label">Frontmatter</div><div className="code">{detail.frontmatter.raw || "(空)"}</div></section>
              <section className="inspector-section"><div className="section-label">校验</div>{detail.issues.length ? detail.issues.map((issue) => <div className="validation-row" key={issue.code}><span className={issue.severity === "error" ? "e" : "w"}>{issue.severity === "error" ? "✕" : "⚠"}</span><span>{issue.message}</span><em>{issue.severity}</em></div>) : <div className="validation-row"><span className="v">✓</span><span>目录名与 name 完全匹配</span><em>valid</em></div>}</section>
              <section className="inspector-section"><div className="section-label">Agent 条目 · {selectedAgent?.name ?? "未选择"}</div>
                {detailEntry ? <div className="link-state"><span className={`status-dot ${detailEntry.kind === "repo-link" ? "green" : detailEntry.kind === "broken-link" ? "red" : "amber"}`} />{kindLabels[detailEntry.kind] ?? detailEntry.kind}<code style={{ marginLeft: "auto", fontSize: "7.5px", color: "var(--muted-2)" }}>{detailEntry.absolutePath}{detailEntry.targetPath ? ` → ${detailEntry.targetPath}` : ""}</code></div> : <div className="desc">当前 Agent 没有同名实际条目；状态：{detailRow ? stateLabels[detailRow.state] : "未扫描"}</div>}
                {detailEntry && <div className="inspector-actions">
                  {detailEntry.kind === "repo-copy" && <button className="btn" disabled={syncExecuting} onClick={() => void convertDetailCopy()}>转为链接</button>}
                  {detailEntry.kind === "repo-link" && <button className="btn" disabled={syncExecuting} onClick={() => void deleteDetailLink(detailEntry, false)}>删除链接</button>}
                  {detailEntry.kind === "broken-link" && <button className="btn" disabled={syncExecuting} onClick={() => void deleteDetailLink(detailEntry, true)}>删除断链</button>}
                </div>}
                {detailRecord && detailEntry && <div className="risk"><span className="risk-mark" /><span>来源集合：{detailRecord.collection || "（Vault 顶层）"}（已记录在配置中）</span></div>}
              </section>
              <section className="inspector-section"><div className="section-label">扁平链接路径</div><div className="path-box">{selectedAgent ? `${selectedAgent.path}/${detail.name ?? detail.directoryName}` : "—"}</div></section>
              <section className="inspector-section"><div className="section-label">元数据</div><dl className="kv"><dt>Baseline</dt><dd>Vault repository</dd><dt>Target</dt><dd>{selectedAgent?.name ?? "—"}</dd><dt>视图</dt><dd>{view === "compare" ? "Compare" : view === "repository" ? "Repository" : "Agent actual"}</dd></dl></section>
              <section className="inspector-section"><div className="section-label">风险</div>{[...detail.issues.map((issue) => issue.message), ...(detailRow?.risks ?? [])].length ? [...detail.issues.map((issue) => issue.message), ...(detailRow?.risks ?? [])].map((risk) => <div className="risk" key={risk}><span className={`risk-mark ${risk.includes("无效") || risk.includes("不可") ? "bad" : ""}`} /><span>{risk}</span></div>) : <div className="desc">无阻塞风险。确认后可创建链接。</div>}</section>
              {inspectorKind && <section className="inspector-section"><div className="section-label">类型</div><div className="desc">{inspectorKind}</div></section>}
            </> : <div className="empty-state">选择一个条目查看详情</div>}
          </div>
        </aside>
      </main>
    )}

    {agentModal && <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={(event) => { if (event.target === event.currentTarget) setAgentModal(null) }}><div className="modal"><h3>{config.agents.some((item) => item.id === agentModal.id) ? "编辑 Agent" : "添加 Agent"}</h3><label>ID<input disabled={config.agents.some((item) => item.id === agentModal.id)} value={agentModal.id} onChange={(event) => setAgentModal({ ...agentModal, id: event.target.value })} /></label><label>名称<input autoFocus value={agentModal.name} onChange={(event) => setAgentModal({ ...agentModal, name: event.target.value })} /></label><label>Host{isMacWorkspace ? <span>macos</span> : <select value={agentModal.host} onChange={(event) => setAgentModal({ ...agentModal, host: event.target.value as HostKind })}><option value="wsl">wsl</option><option value="windows">windows</option></select>}</label><label>实际路径<input value={agentModal.path} onChange={(event) => { const path = event.target.value; setAgentModal({ ...agentModal, path, host: hostForPath(path, agentModal.host) }) }} /></label><p className="hint">此操作只写配置，不触碰 Agent 目录。</p><div className="modal-actions"><button className="btn" onClick={() => setAgentModal(null)}>取消</button><button className="btn primary" onClick={() => void saveAgent()}>保存</button></div></div></div>}
    {preview && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="preview-title" onClick={(event) => { if (event.target === event.currentTarget) setPreview(null) }}><div className="modal modal-wide"><h3 id="preview-title">同步预览 · 确认后执行</h3><p className="preview-explainer">选择了 <b>{preview.selectedSkillIds.length}</b> 个 Skill；每项都显示目标、扁平 Link Path、策略和风险。点击确认后，后台会真实创建缺失的链接。</p><div className="preview-list">{preview.operations.map((operation) => <article className="preview-operation" key={operation.id}><div className="preview-operation-head"><b>{operation.skillKey}</b><span className={operationClass(operation.action)}>{operationText(operation.action)}</span></div><div className="preview-grid"><label>target<code>{operation.targetPath ?? "—"}</code></label><label>flattened link path<code>{operation.linkPath ?? "—"}</code></label><label>link strategy<code>{operation.link?.kind ?? "blocked"}</code></label><label>typed operation<code>{typedOperation(operation)}</code></label></div><div className="preview-risk">risk: {operation.risks.join("；") || "none"}</div><div className="preview-execution">execution=<b>{operation.execution}</b></div></article>)}</div><div className="modal-actions"><button ref={previewCloseRef} className="btn" onClick={() => setPreview(null)}>关闭</button><button className="btn primary" disabled={syncExecuting || !preview.operations.some((operation) => operation.action === "create-link")} onClick={() => void executeSync()}>{syncExecuting ? "执行中…" : "确认并执行"}</button></div></div></div>}
  </div>
}
