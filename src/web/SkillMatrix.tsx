import { Fragment, type ReactElement } from "react"
import type { AgentEntry, AgentScan, ComparisonResult, VaultScan, VaultSkill } from "../core/types"
import { entryForSkill, kindLabels, pendingSkills, skillState, stateLabels, stateTone, validationLabel } from "./skill-ui"

type Props = {
  view: "repository" | "compare" | "actual"
  actualMode: "collection" | "kind"
  loading: boolean
  query: string
  vault: VaultScan | null
  agent: AgentScan | null
  comparison: ComparisonResult | null
  filteredSkills: VaultSkill[]
  groups: [string, VaultSkill[]][]
  actualGroups: [string, AgentEntry[]][]
  selectedSkillKey: string | null
  selectedIds: string[]
  actualSelectedPath: string | null
  collapsedGroups: Set<string>
  onToggleGroup: (key: string) => void
  onSelectSkill: (id: string) => void
  onSelectActual: (entry: AgentEntry) => void
  onToggleSelected: (id: string) => void
  onToggleCollection: (skills: VaultSkill[]) => void
  onClearSearch: () => void
}

function focusMatrixRow(current: HTMLElement, delta: number): void {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-matrix-row]")]
  const index = rows.indexOf(current)
  rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.focus()
}
const Chevron = ({ open }: { open: boolean }): ReactElement => <span className="node-toggle" aria-hidden="true"><svg viewBox="0 0 16 16">{open ? <path d="m4 6 4 4 4-4" /> : <path d="m6 4 4 4-4 4" />}</svg></span>
const Folder = (): ReactElement => <span className="folder" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1-1h6v9h-11z" /></svg></span>

export function SkillMatrix({ view, actualMode, loading, query, vault, agent, comparison, filteredSkills, groups, actualGroups, selectedSkillKey, selectedIds, actualSelectedPath, collapsedGroups, onToggleGroup, onSelectSkill, onSelectActual, onToggleSelected, onToggleCollection, onClearSearch }: Props): ReactElement {
  const selectable = pendingSkills(filteredSkills, comparison)
  const selectedCount = selectable.filter((skill) => selectedIds.includes(skill.relativePath)).length
  const actualCount = actualGroups.reduce((sum, [, entries]) => sum + entries.length, 0)
  const empty = view === "actual" ? !actualCount : !filteredSkills.length
  function groupProps(key: string) {
    return {
      tabIndex: 0,
      "aria-expanded": !collapsedGroups.has(key),
      onClick: () => onToggleGroup(key),
      onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggleGroup(key) } },
    }
  }
  return <section className="matrix-panel">
    <div className="table-wrap">
      <table className={`skill-table ${view}`}>
        <colgroup><col className="col-tree" /><col className={view === "repository" ? "col-description" : "col-state"} /><col className={view === "repository" ? "col-validation" : "col-path"} /></colgroup>
        <thead><tr>
          <th><span className="th-check">{view === "compare" && <input type="checkbox" className="cb" aria-label="选择当前列表所有待链接 Skill" disabled={!selectable.length} checked={selectable.length > 0 && selectedCount === selectable.length} ref={(input) => { if (input) input.indeterminate = selectedCount > 0 && selectedCount < selectable.length }} onChange={() => onToggleCollection(filteredSkills)} />}Skill</span></th>
          <th>{view === "repository" ? "说明" : view === "actual" ? "类型" : "状态"}</th>
          <th>{view === "repository" ? "校验" : view === "actual" ? "指向" : "Agent 条目"}</th>
        </tr></thead>
        <tbody>
          {loading ? <tr><td colSpan={3}><div className="list-empty">正在扫描…</div></td></tr> : empty && <tr><td colSpan={3} className="empty-cell"><div className="empty-state"><b>{query ? "没有匹配的条目" : view === "actual" ? "当前 Agent 没有实际条目" : "没有可显示的 Skill"}</b><span>{query ? "试试其他名称、集合或描述" : view === "actual" ? "可以在对比视图中选择 Skill，预览后创建链接" : vault?.path ? "可以关闭筛选或刷新 Vault" : "先在左侧配置 Vault 路径"}</span>{query && <button className="btn" onClick={onClearSearch}>清除搜索</button>}</div></td></tr>}
          {!loading && (view === "actual" ? actualGroups.map(([group, entries]) => {
            const key = `${actualMode === "collection" ? "actual-col" : "actual"}:${group}`
            return <Fragment key={key}>
              <tr className="group-row" {...groupProps(key)}><td colSpan={3}><div className="tree"><Chevron open={!collapsedGroups.has(key)} /><Folder /><span className="group-name">{actualMode === "kind" ? kindLabels[group] : group}</span><span className="count">{entries.length}</span></div></td></tr>
              {!collapsedGroups.has(key) && entries.map((entry) => <tr key={entry.relativePath} tabIndex={0} data-matrix-row aria-selected={actualSelectedPath === entry.relativePath} className={`skill-row${actualSelectedPath === entry.relativePath ? " selected" : ""}`} onClick={() => onSelectActual(entry)} onKeyDown={(event) => { if (event.key === "Enter") onSelectActual(entry); if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusMatrixRow(event.currentTarget, event.key === "ArrowDown" ? 1 : -1) } }}>
                <td><div className="tree child-tree"><span className="branch" /><span className={`status-dot ${stateTone(entry.kind)}`} /><span className="skill-name" title={entry.absolutePath}>{entry.name}</span></div></td>
                <td><span className={`cmp ${stateTone(entry.kind)}`}>{kindLabels[entry.kind]}</span></td>
                <td><span className="path-text" title={entry.targetPath ?? entry.absolutePath}>{entry.targetPath ?? (entry.kind === "local-dir" || entry.kind === "repo-copy" ? "本地目录" : "—")}</span></td>
              </tr>)}
            </Fragment>
          }) : groups.map(([collection, skills]) => {
            const key = `collection:${collection}`
            const pending = pendingSkills(skills, comparison)
            const checked = pending.filter((skill) => selectedIds.includes(skill.relativePath)).length
            const linked = skills.filter((skill) => skillState(skill, comparison) === "linked").length
            const abnormal = skills.filter((skill) => !["linked", "pending"].includes(skillState(skill, comparison))).length
            return <Fragment key={key}>
              <tr className="group-row" {...groupProps(key)}>
                <td><div className="tree"><Chevron open={!collapsedGroups.has(key)} /><Folder /><span className="group-name" title={collection}>{collection === "Loose Skills" ? "未分组" : collection}</span><span className="count">{skills.length}</span></div></td>
                <td colSpan={2}><div className="group-summary">{view === "compare" ? <><span className="mini"><b>{linked}</b> 已链接</span><span className="mini"><b>{pending.length}</b> 待链接</span>{abnormal > 0 && <span className="mini amber"><b>{abnormal}</b> 异常 / 本地</span>}{pending.length > 0 && <button className="group-action" onClick={(event) => { event.stopPropagation(); onToggleCollection(skills) }} onKeyDown={(event) => event.stopPropagation()}>{checked === pending.length ? `已选中 ${checked} 个` : `选中 ${pending.length} 个待链接`}</button>}</> : <span className="mini">{skills.filter((skill) => skill.validity === "valid").length} 有效 · {skills.filter((skill) => skill.validity === "invalid").length} 无效</span>}</div></td>
              </tr>
              {!collapsedGroups.has(key) && skills.map((skill) => {
                const state = view === "repository" ? skill.validity : skillState(skill, comparison)
                const entry = agent ? entryForSkill(agent.entries, skill) : undefined
                const canSelect = view === "compare" && pending.some((item) => item.relativePath === skill.relativePath)
                const checked = selectedIds.includes(skill.relativePath)
                return <tr key={skill.relativePath} tabIndex={0} data-matrix-row aria-selected={selectedSkillKey === skill.relativePath} className={`skill-row${selectedSkillKey === skill.relativePath ? " selected" : ""}${checked ? " checked-row" : ""}`} onClick={() => onSelectSkill(skill.relativePath)} onKeyDown={(event) => { if (event.key === "Enter") onSelectSkill(skill.relativePath); if (event.key === " " && canSelect) { event.preventDefault(); onToggleSelected(skill.relativePath) } if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusMatrixRow(event.currentTarget, event.key === "ArrowDown" ? 1 : -1) } }}>
                  <td><div className="tree child-tree"><span className="branch" />{view === "compare" && (canSelect ? <input type="checkbox" className="cb" aria-label={`选择 ${skill.id}`} checked={checked} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onChange={() => onToggleSelected(skill.relativePath)} /> : <span className="cb-spacer" />)}<span className="skill-name" title={skill.relativePath}>{skill.id}</span></div></td>
                  {view === "repository" ? <><td className="desc-cell" title={skill.description}>{skill.description || "暂无描述"}</td><td><span className={`cmp ${state === "invalid" ? "red" : skill.issues.length ? "amber" : "green"}`}>{validationLabel(skill.issues)}</span></td></> : <><td><span className={`cmp ${stateTone(state)}`}>{stateLabels[state]}</span></td><td><span className={`path-text${entry ? "" : " none"}`} title={entry?.absolutePath}>{entry?.absolutePath ?? "未创建"}</span></td></>}
                </tr>
              })}
            </Fragment>
          }))}
        </tbody>
      </table>
    </div>
    <div className="center-foot"><span>{view === "actual" ? `${actualCount} 个条目` : `${groups.length} 个集合 · ${filteredSkills.length} 个 Skill`}</span><span className="spacer" />{view === "compare" ? <span>仅待链接 Skill 可选择 · Space 勾选</span> : <span>{view === "actual" ? "Agent 实际" : "Vault"} · 只读</span>}</div>
  </section>
}
