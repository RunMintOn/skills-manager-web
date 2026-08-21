import { Fragment, useMemo, type ReactElement } from "react"
import type { AgentEntry, AgentScan, ComparisonResult, SkillManagerConfig, VaultScan, VaultSkill } from "../core/types.ts"

type MatrixView = "repository" | "compare" | "actual"
type ActualMode = "collection" | "kind"
type SkillGroup = [string, VaultSkill[]]
type ActualGroup = [string, AgentEntry[]]

type Props = {
  view: MatrixView
  actualMode: ActualMode
  showPaths: boolean
  loading: boolean
  vault: VaultScan | null
  agent: AgentScan | null
  comparison: ComparisonResult | null
  config: SkillManagerConfig
  selectedAgentId: string
  filteredSkills: VaultSkill[]
  groups: SkillGroup[]
  actualGroups: ActualGroup[]
  selectedSkillKey: string | null
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
  linked: "已链接",
  pending: "待链接",
  "local-dir": "本地目录",
  "external-link": "外部链接",
  "broken-link": "断链",
  invalid: "无效",
  valid: "有效",
}
const kindLabels: Record<string, string> = {
  "repo-link": "已链接",
  "repo-copy": "本地目录",
  "local-dir": "本地目录",
  "external-link": "外部链接",
  "broken-link": "断链",
  invalid: "无效",
}

function stateClass(value: string): string {
  if (value === "linked") return "cmp green"
  if (value === "pending") return "cmp amber"
  if (value === "local-dir" || value === "external-link") return "cmp amber"
  if (value === "broken-link" || value === "invalid") return "cmp red"
  return "cmp gray"
}
function dotClass(value: string): string {
  if (value === "linked" || value === "valid") return "green"
  if (value === "broken-link" || value === "invalid") return "red"
  if (value === "local-dir" || value === "external-link" || value === "pending") return "amber"
  return "gray"
}
function fmIcon(skill: VaultSkill): ReactElement {
  const hasError = skill.issues.some((issue) => issue.severity === "error")
  const hasWarn = skill.issues.some((issue) => issue.severity === "warning")
  if (hasError) return <span className="fm-icon bad">✕</span>
  if (hasWarn) return <span className="fm-icon warn">⚠</span>
  return <span className="fm-icon good">✓</span>
}

function entryForSkill(entries: AgentEntry[], skill: VaultSkill): AgentEntry | undefined {
  return entries.find((entry) => entry.skillKey === skill.relativePath || (!entry.skillKey && entry.name === skill.directoryName))
}

function focusMatrixRow(current: HTMLElement, delta: number): void {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-matrix-row]")]
  const index = rows.indexOf(current)
  if (index < 0) return
  rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.focus()
}

function selectionState(skills: VaultSkill[], selectedIds: string[]): { checked: boolean; partial: boolean; validIds: string[] } {
  const validIds = skills.filter((skill) => skill.validity === "valid").map((skill) => skill.relativePath)
  const selectedCount = validIds.filter((id) => selectedIds.includes(id)).length
  return { checked: validIds.length > 0 && selectedCount === validIds.length, partial: selectedCount > 0 && selectedCount < validIds.length, validIds }
}

const Chevron = ({ open }: { open: boolean }): ReactElement => (
  <span className="node-toggle" aria-hidden="true"><svg viewBox="0 0 16 16">{open ? <path d="m4 6 4 4 4-4" /> : <path d="m6 4 4 4-4 4" />}</svg></span>
)
const Folder = (): ReactElement => (
  <span className="folder" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1-1h6v9h-11z" /></svg></span>
)

export function SkillMatrix({ view, actualMode, showPaths, loading, vault, agent, comparison, filteredSkills, groups, actualGroups, selectedSkillKey, selectedIds, actualSelectedPath, collapsedGroups, onToggleGroup, onSelectSkill, onSelectActual, onToggleSelected, onToggleCollection }: Props): ReactElement {
  const collectionActualGroups = useMemo<ActualGroup[]>(() => {
    if (!agent) return []
    const skillCol = new Map<string, string>()
    for (const skill of vault?.skills ?? []) skillCol.set(skill.relativePath, skill.collection)
    const map = new Map<string, AgentEntry[]>()
    for (const entry of agent.entries) {
      const col = entry.skillKey ? (skillCol.get(entry.skillKey) ?? "Loose Skills") : "未归类"
      map.set(col, [...(map.get(col) ?? []), entry])
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [agent, vault])
  const visibleActual = view === "actual" ? (actualMode === "collection" ? collectionActualGroups : actualGroups) : []
  const visibleGroups = view === "actual" ? [] : groups

  const dash = (key: string): ReactElement => <td key={key} className="dash-cell">—</td>

  function collectionCheck(collection: string, skills: VaultSkill[]): ReactElement {
    if (view !== "compare") return <span className="checkbox disabled" />
    const selection = selectionState(skills, selectedIds)
    const canSelect = selection.validIds.length > 0
    return <span
      role="checkbox"
      aria-checked={selection.partial ? "mixed" : selection.checked}
      aria-label={`选择集合 ${collection}`}
      tabIndex={0}
      className={`checkbox${selection.checked ? " checked" : selection.partial ? " partial" : ""}${canSelect ? "" : " disabled"}`}
      onClick={(event) => { event.stopPropagation(); if (canSelect) onToggleCollection(skills) }}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); if (canSelect) onToggleCollection(skills) } }}
    />
  }

  function skillCheck(skill: VaultSkill): ReactElement {
    if (view !== "compare") return <span className="checkbox disabled" />
    const canSelect = skill.validity === "valid"
    const checked = selectedIds.includes(skill.relativePath)
    return <span
      role="checkbox"
      aria-checked={checked}
      aria-label={`选择 ${skill.id}`}
      tabIndex={0}
      className={`checkbox${checked ? " checked" : ""}${canSelect ? "" : " disabled"}`}
      onClick={(event) => { event.stopPropagation(); if (canSelect) onToggleSelected(skill.relativePath) }}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); if (canSelect) onToggleSelected(skill.relativePath) } }}
    />
  }

  function groupRowProps(key: string): Record<string, unknown> {
    return {
      role: "button",
      tabIndex: 0,
      "aria-expanded": !collapsedGroups.has(key),
      onClick: () => onToggleGroup(key),
      onKeyDown: (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggleGroup(key) } },
    }
  }

  return <section className="matrix-panel">
    <div className="table-wrap">
      <table className="skill-table">
        <thead>
          <tr>
            <th className="col-tree">{view === "actual" ? (actualMode === "collection" ? "Skill" : "Skill") : "Skill"}</th>
            <th className="col-cmp">状态</th>
            <th className="col-agent">Agent</th>
            <th className="col-link">链接</th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={4}><div className="list-empty">正在扫描 Vault…</div></td></tr>}
          {!loading && view !== "actual" && !groups.length && <tr><td colSpan={4}><div className="list-empty">没有匹配的 Skill</div></td></tr>}
          {!loading && view === "actual" && !visibleActual.length && <tr><td colSpan={4}><div className="list-empty">当前 Agent 没有实际条目</div></td></tr>}
          {view === "actual" ? visibleActual.map(([groupKey, entries]) => {
            const key = actualMode === "collection" ? `actual-col:${groupKey}` : `actual:${groupKey}`
            const collapsed = collapsedGroups.has(key)
            const label = actualMode === "collection" ? groupKey : (kindLabels[groupKey] ?? groupKey)
            const rel = actualMode === "collection" ? `/agent/${entries[0]?.skillKey ?? "other"}` : `/agent/${groupKey}`
            const fragmentKey = actualMode === "collection" ? `col:${groupKey}` : `kind:${groupKey}`
            return <Fragment key={fragmentKey}>
              <tr className="group-row" {...groupRowProps(key)}>
                <td><div className="tree">
                  <Chevron open={!collapsed} />
                  <span className="checkbox disabled" />
                  <Folder />
                  <span className="group-name">{label}</span>
                  <span className="count">{entries.length}</span>
                  {showPaths && <span className="group-path">{rel}</span>}
                </div></td>
                {dash("c1")}{dash("c2")}<td />
              </tr>
              {!collapsed && entries.map((entry) => (
                <tr key={entry.relativePath} role="button" tabIndex={0} data-matrix-row className={actualSelectedPath === entry.relativePath ? "skill-row selected" : "skill-row"} onClick={() => onSelectActual(entry)} onKeyDown={(event) => { if (event.key === "Enter") onSelectActual(entry); if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusMatrixRow(event.currentTarget, event.key === "ArrowDown" ? 1 : -1) } }}>
                  <td><div className="tree child-tree"><span className="branch" /><span className="checkbox disabled" /><span className={`status-dot ${dotClass(entry.kind)}`} /><span className="skill-name">{entry.name}</span>{showPaths && <span className="skill-path">/agent/{entry.relativePath}</span>}</div></td>
                  <td><span className={stateClass(entry.kind)}>{kindLabels[entry.kind] ?? entry.kind}</span></td>
                  <td><span className="presence yes">存在</span></td>
                  <td>{entry.targetPath ? <span className="fm-icon good">✓</span> : <span className="fm-icon warn">—</span>}</td>
                </tr>
              ))}
            </Fragment>
          }) : visibleGroups.map(([collection, skills]) => {
            const key = `collection:${collection}`
            const collapsed = collapsedGroups.has(key)
            return <Fragment key={collection}>
              <tr className="group-row" {...groupRowProps(key)}>
                <td><div className="tree">
                  <Chevron open={!collapsed} />
                  {collectionCheck(collection, skills)}
                  <Folder />
                  <span className="group-name">{collection === "Loose Skills" ? "Loose Skills" : collection}</span>
                  <span className="count">{skills.length}</span>
                  {showPaths && <span className="group-path">/vault/collections/{collection}</span>}
                </div></td>
                {dash("c1")}{dash("c2")}<td />
              </tr>
              {!collapsed && skills.map((skill) => {
                const row = comparison?.rows.find((item) => item.skillKey === skill.relativePath)
                const status = view === "repository" ? (skill.validity === "valid" ? "valid" : "invalid") : row?.state ?? (skill.validity === "invalid" ? "invalid" : "pending")
                const entry = agent ? entryForSkill(agent.entries, skill) : undefined
                const isSelected = selectedSkillKey === skill.relativePath
                const isChecked = selectedIds.includes(skill.relativePath)
                return <tr key={`${skill.relativePath}:${skill.id}`} role="button" tabIndex={0} data-matrix-row className={`skill-row${isSelected ? " selected" : ""}${isChecked ? " checked-row" : ""}`} onClick={() => onSelectSkill(skill.relativePath)} onKeyDown={(event) => { if (event.key === "Enter") onSelectSkill(skill.relativePath); if (event.key === " " && view === "compare") { event.preventDefault(); if (skill.validity === "valid") onToggleSelected(skill.relativePath) }; if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusMatrixRow(event.currentTarget, event.key === "ArrowDown" ? 1 : -1) } }}>
                  <td><div className="tree child-tree"><span className="branch" />{skillCheck(skill)}<span className={`status-dot ${dotClass(status)}`} /><span className="skill-name">{skill.id}</span>{showPaths && <span className="skill-path">/vault/skills/{skill.relativePath}</span>}</div></td>
                  <td><span className={`cmp ${dotClass(status) === "green" ? "green" : dotClass(status) === "red" ? "red" : "amber"}`}>{stateLabels[status] ?? status}</span></td>
                  <td>{entry ? <span className="presence yes">存在</span> : <span className="presence no">—</span>}</td>
                  <td>{entry?.kind === "repo-link" ? <span className="fm-icon good">✓</span> : <span className="fm-icon warn">—</span>}</td>
                </tr>
              })}
            </Fragment>
          })}
        </tbody>
      </table>
    </div>
    <div className="center-foot"><span>{view === "compare" ? `${selectedIds.length} 项已选择` : (view === "actual" ? `${visibleActual.reduce((sum, [, entries]) => sum + entries.length, 0)} 项` : `${filteredSkills.length} 项`)}</span><div className="spacer" />{view === "compare" ? <span>无效 Skill 不可同步</span> : null}<span>{view === "actual" ? "Agent actual · 只读" : `比较完成 · ${vault?.summary.total ?? 0} baseline`}</span></div>
  </section>
}