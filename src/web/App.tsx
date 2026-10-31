import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react"
import type { AgentConfig, AgentEntry, AgentScan, ComparisonResult, ComparisonRow, HostKind, SkillManagerConfig, SyncPlan, VaultScan, VaultSkill } from "../core/types.ts"
import { mirrorVaultForHost, synchronizeBaselineWithMirror } from "../core/baseline.ts"
import { api, type InitResponse } from "./api"
import { detectPathHost, isAbsolutePathForHost } from "../core/path-host.ts"
import { LinksWorkbench } from "./LinksWorkbench"
import { MirrorSyncWorkbench } from "./MirrorSyncWorkbench"
import { SkillMatrix } from "./SkillMatrix"
import { Inspector } from "./Inspector"
import { entryForSkill, pendingSkills, shortPath } from "./skill-ui"

type TopTab = "skills" | "links" | "mirror"
type View = "repository" | "compare" | "actual"
type ActualMode = "collection" | "kind"
type AgentDraft = { id: string; name: string; host: HostKind; path: string }

const emptyConfig: SkillManagerConfig = { schemaVersion: 1, autoDetectPathHost: true, vault: { path: "", host: "wsl" }, agents: [] }

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
  const [dark, setDark] = useState(() => {
    try {
      const saved = window.localStorage.getItem("skills-manager-theme")
      const initial = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches
      document.body.classList.toggle("light", !initial)
      return initial
    } catch { return true }
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
  const [vaultSettingsOpen, setVaultSettingsOpen] = useState(false)
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
    setAgent(result.agent); setComparison(result.comparison); setActualSelectedPath(null); setSelectedIds([])
    setSelectedSkillKey((current) => current && vaultValue.skills.some((skill) => skill.relativePath === current) ? current : vaultValue.skills[0]?.relativePath ?? null)
  }, [])
  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const initValue = await api.init()
      const configValue = { ...initValue.config.config, vault: { ...initValue.config.config.vault, path: initValue.vault.path }, agents: initValue.agents.map(({ issueCount: _issueCount, ...item }) => item) }
      const vaultValue = (await api.vault()).vault
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
  const actualGroups = useMemo(() => {
    const map = new Map<string, AgentEntry[]>()
    const needle = query.normalize("NFKC").toLocaleLowerCase("en-US").trim()
    for (const entry of agent?.entries ?? []) {
      const collection = entry.skillKey ? vault?.skills.find((skill) => skill.relativePath === entry.skillKey)?.collection ?? "未归类" : "未归类"
      if (needle && ![entry.name, entry.relativePath, entry.kind, entry.targetPath ?? "", collection].join(" ").normalize("NFKC").toLocaleLowerCase("en-US").includes(needle)) continue
      const key = actualMode === "kind" ? entry.kind : collection
      map.set(key, [...(map.get(key) ?? []), entry])
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [agent, vault, actualMode, query])
  useEffect(() => { collapsedGroupsInitialized.current = false }, [vault])
  useEffect(() => {
    if (collapsedGroupsInitialized.current || !groups.length) return
    collapsedGroupsInitialized.current = true
    setCollapsedGroups(new Set(groups.slice(1).map(([collection]) => `collection:${collection}`)))
  }, [groups])
  useEffect(() => { setDiffOnly(false) }, [view, selectedAgentId])
  useEffect(() => { if (query) setCollapsedGroups(new Set()) }, [query])
  const actualDetailEntry = view === "actual" ? actualGroups.flatMap(([, entries]) => entries).find((entry) => entry.relativePath === actualSelectedPath) ?? actualGroups[0]?.[1][0] : undefined
  const detail = view === "actual" ? vault?.skills.find((skill) => skill.relativePath === actualDetailEntry?.skillKey) : filteredSkills.find((skill) => skill.relativePath === selectedSkillKey) ?? filteredSkills[0]
  const detailRow: ComparisonRow | undefined = comparison?.rows.find((row) => row.skillKey === detail?.relativePath)
  const detailEntry = view === "actual" ? actualDetailEntry : detail && agent ? entryForSkill(agent.entries, detail) : undefined
  const detailRecord = detail && selectedAgentId ? (config.links ?? []).find((record) => record.agentId === selectedAgentId && record.skill === detail.relativePath) : undefined
  const validSelected = pendingSkills(vault?.skills ?? [], comparison).filter((skill) => selectedIds.includes(skill.relativePath)).map((skill) => skill.relativePath)

  function toggleSelected(id: string): void {
    setSelectedIds(function updateSelection(current): string[] {
      if (current.includes(id)) return current.filter(function (item): boolean { return item !== id })
      return [...current, id]
    })
  }
  function toggleCollection(skills: VaultSkill[]): void {
    const validIds = pendingSkills(skills, comparison).map((skill) => skill.relativePath)
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
        { label: "待链接", tone: "gray", count: sum.pending },
        { label: "本地", tone: "amber", count: sum["local-dir"] + sum["external-link"] },
        { label: "异常", tone: "red", count: sum["broken-link"] + sum["invalid"] },
        { label: "Agent 额外", tone: "gray", count: comparison.actualOnly.length },
      ]
    }
    if (view === "repository" && vault) {
      return [
        { label: "有效", tone: "green", count: vault.summary.valid },
        { label: "错误", tone: "red", count: vault.summary.errors },
        { label: "总计", tone: "gray", count: vault.summary.total },
      ]
    }
    if (view === "actual" && agent) {
      return [
        { label: "条目", tone: "gray", count: agent.entries.length },
        { label: "已链接", tone: "green", count: agent.entries.filter((e) => e.kind === "repo-link").length },
        { label: "断链", tone: "red", count: agent.entries.filter((e) => e.kind === "broken-link").length },
        { label: "未归类", tone: "gray", count: agent.entries.filter((e) => !e.skillKey).length },
      ]
    }
    return base.map((b) => ({ label: b.label, tone: b.tone, count: 0 }))
  })()
  const targetLabel = view === "repository" ? "Vault" : selectedAgent?.name ?? "未选择 Agent"
  const targetCaption = view === "repository" ? vault?.path ?? "" : agent?.path ?? ""
  const showLinks = topTab === "links"
  const showMirror = topTab === "mirror" && !isMacWorkspace
  const showSkills = !showLinks && !showMirror
  const visibleGroupKeys = view === "actual" ? actualGroups.map(([key]) => `${actualMode === "collection" ? "actual-col" : "actual"}:${key}`) : groups.map(([key]) => `collection:${key}`)
  const hasCollapsedGroups = visibleGroupKeys.some((key) => collapsedGroups.has(key))

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

    {!showSkills && error && <div className="banner banner-error" role="alert">{error}<button aria-label="关闭错误" onClick={() => setError(null)}>×</button></div>}
    {!showSkills && notice && <div className="banner banner-notice" role="status">{notice}<button aria-label="关闭提示" onClick={() => setNotice(null)}>×</button></div>}
    {showLinks && <LinksWorkbench config={config} onConfigChange={setConfig} onNotice={setNotice} onError={(message) => setError(message || null)} />}
    {showMirror && <MirrorSyncWorkbench config={config} onConfigChange={applyMirrorConfig} onNotice={setNotice} onError={(message) => setError(message || null)} />}
    {showSkills && (
      <main className="workspace">
        <aside className="left">
          <div className="pane-head"><span>Agent 目标</span><div className="head-actions"><button className="head-btn" title="添加 Agent" aria-label="添加 Agent" onClick={() => setAgentModal({ id: `agent-${Date.now()}`, name: "", host: isMacWorkspace ? "macos" : "wsl", path: "" })}><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></svg></button></div></div>
          <button className="rail-vault-toggle icon-button" aria-label="配置 Vault" aria-expanded={vaultSettingsOpen} title="配置 Vault" onClick={() => setVaultSettingsOpen((value) => !value)}><svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1-1h6v9h-11z" /></svg></button>
          <div className={`baseline-box${vaultSettingsOpen ? " open" : ""}`}>
            <div className="baseline-label"><svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1-1h6v9h-11z" /></svg>Vault 仓库</div>
            <div className="repo-field"><svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1-1h6v9h-11z" /></svg>
              <input aria-label="Vault 路径" title="直接编辑路径，回车或失焦保存（只写 data/config.json）" value={vaultPathDraft} placeholder="未配置 Vault" onChange={(event) => setVaultPathDraft(event.target.value)} onBlur={(event) => commitVaultPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur() } }} />
              <button className="repo-copy-btn" aria-label="复制 Vault 路径" title="复制 Vault 路径" onClick={() => void copyPath(config.vault.path)}>⧉</button>
            </div>
            <div className="repo-options"><label><input type="checkbox" checked={autoDetectPathHost} onChange={(event) => commitAutoDetectPathHost(event.target.checked)} />自动识别路径类型</label>{!isMacWorkspace && <label>Host<select value={config.vault.host} onChange={(event) => commitVaultHost(event.target.value as HostKind)}><option value="wsl">wsl</option><option value="windows">windows</option></select></label>}</div>
          </div>
          <div className="agent-list">
            {loading && <div className="list-empty">正在读取 Agent…</div>}
            {!loading && !config.agents.length && <div className="list-empty">尚未配置 Agent</div>}
            {config.agents.map((item) => {
              const health = init?.agents.find((summary) => summary.id === item.id)
              return <div className={selectedAgentId === item.id ? "agent-row active" : "agent-row"} key={item.id} role="button" tabIndex={0} onClick={() => void selectAgent(item.id)} onKeyDown={(event) => { if (event.key === "Enter") void selectAgent(item.id); if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusListItem("[data-agent-row]", event.currentTarget, event.key === "ArrowDown" ? 1 : -1) } }} data-agent-row title={`${item.name}\n${item.path}`}>
                <span className="agent-icon">{item.name.slice(0, 1).toUpperCase() || "?"}</span>
                <span className="agent-copy"><strong>{item.name}</strong><small title={item.path}>{shortPath(item.path)}</small></span>
                <span className="agent-issue">{health?.issueCount ? `${health.issueCount} 问题` : "就绪"}</span>
                <span className="agent-actions"><button aria-label={`复制 ${item.name} 路径`} title="复制路径" onClick={(event) => { event.stopPropagation(); void copyPath(item.path) }}>⧉</button><button aria-label={`编辑 ${item.name}`} onClick={(event) => { event.stopPropagation(); setAgentModal(item) }}>✎</button><button aria-label={`删除 ${item.name}`} onClick={(event) => { event.stopPropagation(); void deleteAgent(item) }}>×</button></span>
              </div>
            })}
          </div>
          {selectedAgent && <div className="rail-agent-tools"><button className="icon-button" aria-label="编辑当前 Agent" title="编辑当前 Agent" onClick={() => setAgentModal(selectedAgent)}>✎</button><button className="icon-button" aria-label="删除当前 Agent" title="删除当前 Agent 配置" onClick={() => void deleteAgent(selectedAgent)}>×</button></div>}
          <div className="left-foot"><span>{config.agents.length} 个 Agent · Vault 只读</span></div>
        </aside>

        <main className="center">
          <div className="center-top">
            <div className="contextbar">
              <div className="context-main"><span className="context-label">{view === "repository" ? "仓库" : view === "actual" ? "实际" : "对比"}</span><strong>{targetLabel}</strong><span className="ctx-path" title={targetCaption}>{shortPath(targetCaption) || "尚未配置路径"}</span></div>
              <div className="compare-stats">{compareStatDefs.map((stat) => <span key={stat.label} className={`stat ${stat.tone}`}><span className="dot" /><b>{stat.count}</b> {stat.label}</span>)}</div>
            </div>
            <div className="toolbar">
              <div className="segment" role="tablist" aria-label="技能视图">
                {([["repository", "仓库"], ["compare", "对比"], ["actual", "Agent 实际"]] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={view === key} className={view === key ? "active" : ""} onClick={() => setView(key)}>{label}</button>)}
              </div>
              {view === "actual" && <div className="segment secondary" role="tablist" aria-label="Agent 实际分组">
                {([["collection", "按集合"], ["kind", "按类型"]] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={actualMode === key} className={actualMode === key ? "active" : ""} onClick={() => setActualMode(key)}>{label}</button>)}
              </div>}
              <div className="search"><svg viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="4" /><path d="m10 10 3.5 3.5" /></svg><input ref={searchRef} aria-label="搜索技能" placeholder="搜索 Skill、集合、描述…" value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>/</kbd></div>
              {view === "compare" && <button className="btn ghost toggle" aria-pressed={diffOnly} onClick={() => setDiffOnly((value) => !value)}>仅看差异</button>}
              <button className="btn ghost icon" aria-label={hasCollapsedGroups ? "展开全部集合" : "折叠全部集合"} title={hasCollapsedGroups ? "展开全部集合" : "折叠全部集合"} onClick={() => setCollapsedGroups(hasCollapsedGroups ? new Set() : new Set(visibleGroupKeys))}><svg viewBox="0 0 16 16"><path d={hasCollapsedGroups ? "m4 5 4-3 4 3M4 11l4 3 4-3" : "m4 2 4 3 4-3M4 14l4-3 4 3"} /><path d="M3 8h10" /></svg></button>
              {view === "compare" && <button className="btn primary" disabled={!validSelected.length || previewLoading} onClick={() => void openPreview()}>{previewLoading ? "计算中…" : `预览同步${validSelected.length ? ` · ${validSelected.length}` : ""}`}</button>}
            </div>
          </div>
          {error && <div className="banner banner-error" role="alert">⚠ {error} <button onClick={() => void load()}>重试</button><button onClick={() => setError(null)}>×</button></div>}
          {isMacWorkspace && init && !init.config.exists && <div className="banner banner-notice" role="status">首次运行：已内置 3 个 Mac Agent 技能目录。请先配置 Vault 路径；应用不会扫描未列出的 home 目录。</div>}
          {scanStale && <div className="banner banner-notice" role="status">当前 Host 的扫描结果待刷新。点击右上角刷新。<button onClick={() => void load()}>立即刷新</button></div>}
          {notice && <div className="banner banner-notice" role="status">{notice}<button onClick={() => setNotice(null)}>×</button></div>}
          <SkillMatrix view={view} actualMode={actualMode} query={query} loading={loading} vault={vault} agent={agent} comparison={comparison} filteredSkills={filteredSkills} groups={groups} actualGroups={actualGroups} selectedSkillKey={detail?.relativePath ?? null} selectedIds={validSelected} actualSelectedPath={actualDetailEntry?.relativePath ?? null} collapsedGroups={collapsedGroups} onToggleGroup={toggleGroup} onSelectSkill={setSelectedSkillKey} onSelectActual={(entry) => setActualSelectedPath(entry.relativePath)} onToggleSelected={toggleSelected} onToggleCollection={toggleCollection} onClearSearch={() => setQuery("")} />
        </main>
        <Inspector actual={view === "actual"} skill={detail} entry={detailEntry} agent={agent} row={view === "repository" ? undefined : detailRow} record={detailRecord} busy={syncExecuting} canSelect={view === "compare" && detail?.validity === "valid" && detailRow?.state === "pending"} selected={validSelected.includes(detail?.relativePath ?? "")} onToggleSelected={() => { if (detail) toggleSelected(detail.relativePath) }} onCopy={(path) => void copyPath(path)} onConvert={() => void convertDetailCopy()} onDelete={(entry, broken) => void deleteDetailLink(entry, broken)} />
      </main>
    )}

    {agentModal && <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={(event) => { if (event.target === event.currentTarget) setAgentModal(null) }}><div className="modal"><h3>{config.agents.some((item) => item.id === agentModal.id) ? "编辑 Agent" : "添加 Agent"}</h3><label>ID<input disabled={config.agents.some((item) => item.id === agentModal.id)} value={agentModal.id} onChange={(event) => setAgentModal({ ...agentModal, id: event.target.value })} /></label><label>名称<input autoFocus value={agentModal.name} onChange={(event) => setAgentModal({ ...agentModal, name: event.target.value })} /></label><label>Host{isMacWorkspace ? <span>macos</span> : <select value={agentModal.host} onChange={(event) => setAgentModal({ ...agentModal, host: event.target.value as HostKind })}><option value="wsl">wsl</option><option value="windows">windows</option></select>}</label><label>实际路径<input value={agentModal.path} onChange={(event) => { const path = event.target.value; setAgentModal({ ...agentModal, path, host: hostForPath(path, agentModal.host) }) }} /></label><p className="hint">此操作只写配置，不触碰 Agent 目录。</p><div className="modal-actions"><button className="btn" onClick={() => setAgentModal(null)}>取消</button><button className="btn primary" onClick={() => void saveAgent()}>保存</button></div></div></div>}
    {preview && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="preview-title" onClick={(event) => { if (event.target === event.currentTarget) setPreview(null) }}><div className="modal modal-wide">
      <h3 id="preview-title">同步预览</h3><p className="preview-explainer">已选择 <b>{preview.selectedSkillIds.length}</b> 个 Skill。确认后创建链接，不修改 Vault，不覆盖已有条目。</p>
      <div className="preview-list">{preview.operations.map((operation) => <article className="preview-operation" key={operation.id}>
        <div className="preview-operation-head"><b>{operation.skillKey}</b><span className={operationClass(operation.action)}>{operationText(operation.action)}</span></div>
        <div className="preview-grid"><label>目标<code>{operation.targetPath ?? "—"}</code></label><label>链接路径<code>{operation.linkPath ?? "—"}</code></label></div>
        {operation.risks.length > 0 && <div className="preview-risk">{operation.risks.join("；")}</div>}
        <details className="technical-details"><summary>技术细节</summary><code>{typedOperation(operation)}</code></details>
      </article>)}</div>
      <div className="modal-actions"><button ref={previewCloseRef} className="btn" onClick={() => setPreview(null)}>关闭</button><button className="btn primary" disabled={syncExecuting || !preview.operations.some((operation) => operation.action === "create-link")} onClick={() => void executeSync()}>{syncExecuting ? "执行中…" : "确认并执行"}</button></div>
    </div></div>}
  </div>
}
