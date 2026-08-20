import type { ReactElement } from "react"
import type { AgentEntry, AgentScan, ComparisonResult, SkillManagerConfig, VaultScan, VaultSkill } from "../core/types.ts"

type MatrixView = "repository" | "compare" | "actual"
type SkillGroup = [string, VaultSkill[]]
type ActualGroup = [string, AgentEntry[]]

type Props = {
  view: MatrixView
  loading: boolean
  vault: VaultScan | null
  agent: AgentScan | null
  comparison: ComparisonResult | null
  config: SkillManagerConfig
  selectedAgentId: string
  filteredSkills: VaultSkill[]
  groups: SkillGroup[]
  actualGroups: ActualGroup[]
  selectedSkillId: string | null
  selectedIds: string[]
  actualSelectedPath: string | null
  collapsedGroups: Set<string>
  onToggleGroup: (key: string) => void
  onSelectSkill: (id: string) => void
  onSelectActual: (entry: AgentEntry) => void
  onToggleSelected: (id: string) => void
  onToggleCollection: (skills: VaultSkill[]) => void
}

const stateLabels: Record<string, string> = {
  linked: "已就绪",
  pending: "待链接",
  "local-dir": "本地目录",
  "external-link": "外部链接",
  "broken-link": "断链",
  invalid: "无效",
  valid: "有效",
}
const kindLabels: Record<string, string> = {
  "repo-link": "repo-link · Vault",
  "repo-copy": "repo-copy · 拷贝",
  "local-dir": "local-dir · 本地目录",
  "external-link": "external-link · 外部",
  "broken-link": "broken-link · 断链",
  invalid: "invalid · 无效",
}

function stateClass(value: string): string {
  if (value === "linked" || value === "valid") return "status-tag linked"
  if (value === "pending") return "status-tag pending"
  if (value === "invalid" || value === "broken-link") return "status-tag invalid"
  return "status-tag"
}

function entryForSkill(entries: AgentEntry[], skill: VaultSkill): AgentEntry | undefined {
  return entries.find((entry) => entry.skillId === skill.id || (!entry.skillId && entry.name === skill.directoryName))
}

function focusMatrixRow(current: HTMLElement, delta: number): void {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-matrix-row]")]
  const index = rows.indexOf(current)
  if (index < 0) return
  rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.focus()
}

function matrixSkillPath(skill: VaultSkill): string {
  return `/vault/skills/${skill.relativePath}`
}

function matrixCollectionPath(collection: string): string {
  return `/vault/collections/${collection}`
}

function matrixActualPath(entry: AgentEntry): string {
  return `/agent/${entry.relativePath}`
}

function selectionState(skills: VaultSkill[], selectedIds: string[]): { checked: boolean; partial: boolean; validIds: string[] } {
  const validIds = skills.filter((skill) => skill.validity === "valid").map((skill) => skill.id)
  const selectedCount = validIds.filter((id) => selectedIds.includes(id)).length
  return { checked: validIds.length > 0 && selectedCount === validIds.length, partial: selectedCount > 0 && selectedCount < validIds.length, validIds }
}

function MatrixDash(): ReactElement {
  return <span className="matrix-dash">—</span>
}

export function SkillMatrix({ view, loading, vault, agent, comparison, config, selectedAgentId, filteredSkills, groups, actualGroups, selectedSkillId, selectedIds, actualSelectedPath, collapsedGroups, onToggleGroup, onSelectSkill, onSelectActual, onToggleSelected, onToggleCollection }: Props): ReactElement {
  const selectedAgent = config.agents.find((item) => item.id === selectedAgentId)
  const totalSkills = view === "actual" ? actualGroups.reduce((sum, [, entries]) => sum + entries.length, 0) : vault?.summary.total ?? filteredSkills.length
  const totalGroups = view === "actual" ? actualGroups.length : vault?.summary.collections ?? groups.length
  const visibleGroups = view === "actual" ? actualGroups : groups

  function toggleGroup(key: string): void {
    onToggleGroup(key)
  }

  return <section className="panel skill-panel matrix-panel">
    <div className="matrix-summary"><span>共 {totalGroups} 个集合 · {totalSkills} 个 Skill</span><span className="result-count">{view === "actual" ? `${totalSkills} 项` : `${filteredSkills.length} / ${vault?.summary.total ?? 0} 项`}</span></div>
    <div className="skill-table-head" aria-label="Skill 数据列"><span>Skill / 路径</span><span>Agent ({selectedAgent?.host ?? "未选择"})<small>状态</small></span><span>来源</span><span>Frontmatter</span><span>链接</span><span>操作</span></div>
    <div className="skill-groups matrix-body">
      {loading && <div className="list-empty">正在扫描 Vault…</div>}
      {!loading && !visibleGroups.length && <div className="list-empty">{view === "actual" ? "当前 Agent 没有实际条目" : "没有匹配的 Skill"}</div>}
      {view === "actual" ? actualGroups.map(([kind, entries]) => {
        const key = `actual:${kind}`
        const collapsed = collapsedGroups.has(key)
        return <div className="skill-group matrix-group" key={kind}>
          <div className="group-heading matrix-group-row" role="button" tabIndex={0} aria-expanded={!collapsed} onClick={() => toggleGroup(key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleGroup(key) } }}>
            <div className="matrix-skill-cell matrix-group-skill-cell"><span className="matrix-select-spacer" /><span className="matrix-toggle">{collapsed ? "›" : "⌄"}</span><span className="matrix-folder">▱</span><b>{kindLabels[kind] ?? kind}</b><small className="matrix-count">{entries.length}</small><small className="matrix-path">/agent/{kind}</small></div><MatrixDash /><MatrixDash /><MatrixDash /><MatrixDash /><MatrixDash />
          </div>
          {!collapsed && entries.map((entry) => <div role="button" tabIndex={0} data-matrix-row className={actualSelectedPath === entry.relativePath ? "matrix-row selected" : "matrix-row"} key={entry.relativePath} onClick={() => onSelectActual(entry)} onKeyDown={(event) => { if (event.key === "Enter") onSelectActual(entry); if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusMatrixRow(event.currentTarget, event.key === "ArrowDown" ? 1 : -1) } }}>
            <div className="matrix-skill-cell"><span className="matrix-select-spacer" /><span className="matrix-branch" /><span className="matrix-dot" /><b>{entry.name}</b><small className="matrix-path">{matrixActualPath(entry)}</small></div><span className={stateClass(entry.kind === "broken-link" ? "broken-link" : entry.kind === "invalid" ? "invalid" : "local-dir")}>{kindLabels[entry.kind] ?? entry.kind}</span><span className="matrix-cell">{entry.targetPath ? "链接" : "Agent"}</span><span className="matrix-cell">{entry.frontmatter?.present ? <span className="matrix-check">✓ 有效</span> : <span className="matrix-warn">—</span>}</span><span className="matrix-cell matrix-link">{entry.targetPath ? <span className="matrix-check">✓</span> : <MatrixDash />}</span><span className="matrix-actions" aria-hidden="true">↗　•••</span>
          </div>)}
        </div>
      }) : groups.map(([collection, skills], groupIndex) => {
        const key = `collection:${collection}`
        const collapsed = collapsedGroups.has(key)
        const selection = selectionState(skills, selectedIds)
        return <div className="skill-group matrix-group" key={collection}>
          <div className="group-heading matrix-group-row" role="button" tabIndex={0} aria-expanded={!collapsed} onClick={() => toggleGroup(key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleGroup(key) } }}>
            <div className="matrix-skill-cell matrix-group-skill-cell"><>{view === "compare" ? <input aria-label={`选择集合 ${collection}`} type="checkbox" checked={selection.checked} disabled={!selection.validIds.length} ref={(input) => { if (input) input.indeterminate = selection.partial }} onChange={(event) => { event.stopPropagation(); onToggleCollection(skills) }} onClick={(event) => event.stopPropagation()} /> : <span className="matrix-select-spacer" />}</><span className="matrix-toggle">{collapsed ? "›" : "⌄"}</span><span className="matrix-folder">▱</span><b>{collection}</b><small className="matrix-count">{skills.length}</small><small className="matrix-path">{matrixCollectionPath(collection)}</small></div><MatrixDash /><MatrixDash /><MatrixDash /><MatrixDash /><MatrixDash />
          </div>
          {!collapsed && skills.map((skill) => {
            const row = comparison?.rows.find((item) => item.skillId === skill.id)
            const status = view === "repository" ? (skill.validity === "valid" ? "valid" : "invalid") : row?.state ?? (skill.validity === "invalid" ? "invalid" : "pending")
            const canSelect = skill.validity === "valid"
            const hasError = skill.issues.some((issue) => issue.severity === "error")
            const warningCount = skill.issues.filter((issue) => issue.severity === "warning").length
            const entry = agent ? entryForSkill(agent.entries, skill) : undefined
            const source = entry ? (entry.kind === "repo-link" ? "已同步" : kindLabels[entry.kind] ?? entry.kind) : "—"
            return <div role="button" tabIndex={0} data-matrix-row className={`${selectedSkillId === skill.id ? "matrix-row selected" : "matrix-row"}${selectedIds.includes(skill.id) ? " checked-row" : ""}`} key={`${skill.relativePath}:${skill.id}`} onClick={() => onSelectSkill(skill.id)} onKeyDown={(event) => { if (event.key === "Enter") onSelectSkill(skill.id); if (event.key === " " && view === "compare") { event.preventDefault(); if (canSelect) onToggleSelected(skill.id) }; if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusMatrixRow(event.currentTarget, event.key === "ArrowDown" ? 1 : -1) } }}>
              <div className="matrix-skill-cell"><>{view === "compare" ? <input aria-label={`选择 ${skill.id}`} disabled={!canSelect} type="checkbox" checked={selectedIds.includes(skill.id)} onChange={(event) => { event.stopPropagation(); onToggleSelected(skill.id) }} onClick={(event) => event.stopPropagation()} /> : <span className="matrix-select-spacer" />}</><span className="matrix-branch" /><span className={hasError ? "matrix-dot invalid" : warningCount ? "matrix-dot warn" : "matrix-dot"} /><b>{skill.id}</b><small className="matrix-path">{matrixSkillPath(skill)}</small></div><span className={stateClass(status)}>{stateLabels[status] ?? status}</span><span className="matrix-cell matrix-source">{source}</span><span className="matrix-cell">{hasError ? <span className="matrix-error">⚠ 无效</span> : warningCount ? <span className="matrix-warn">⚠ {warningCount} 警告</span> : <span className="matrix-check">✓ 有效</span>}</span><span className="matrix-cell matrix-link">{entry?.kind === "repo-link" ? <span className="matrix-check">✓</span> : <MatrixDash />}</span><span className="matrix-actions" aria-hidden="true">↗　•••</span>
            </div>
          })}
        </div>
      })}
    </div>
    <div className="panel-foot matrix-footer"><span>{view === "compare" ? `${selectedIds.length} 项已选择` : `${filteredSkills.length} 项`}</span>{view === "compare" && <span className="matrix-footer-hint">无效 Skill 不可同步</span>}</div>
  </section>
}
