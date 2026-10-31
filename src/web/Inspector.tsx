import type { ReactElement } from "react"
import type { AgentEntry, AgentScan, ComparisonRow, LinkRecord, VaultSkill } from "../core/types"
import { issueText, kindLabels, stateLabels, stateTone } from "./skill-ui"

type Props = {
  actual: boolean
  skill?: VaultSkill
  entry?: AgentEntry
  agent: AgentScan | null
  row?: ComparisonRow
  record?: LinkRecord
  busy: boolean
  canSelect: boolean
  selected: boolean
  onToggleSelected: () => void
  onCopy: (path: string) => void
  onConvert: () => void
  onDelete: (entry: AgentEntry, broken: boolean) => void
}

function PathBox({ path, onCopy }: { path: string; onCopy: (path: string) => void }): ReactElement {
  return <div className="path-box"><code>{path}</code><button className="repo-copy-btn" aria-label={`复制路径 ${path}`} title="复制路径" onClick={() => onCopy(path)}>⧉</button></div>
}

export function Inspector({ actual, skill, entry, agent, row, record, busy, canSelect, selected, onToggleSelected, onCopy, onConvert, onDelete }: Props): ReactElement {
  const state = actual ? entry?.kind : row?.state ?? skill?.validity
  const label = actual ? kindLabels[state ?? ""] : stateLabels[state ?? ""]
  const issues = [...(skill?.issues ?? []), ...(entry?.issues ?? [])]
  const linkPath = entry?.absolutePath ?? (agent && skill ? `${agent.path.replace(/[\\/]$/, "")}${agent.host === "windows" ? "\\" : "/"}${skill.name ?? skill.directoryName}` : "")
  return <aside className="right">
    <div className="inspector-head">
      <div className="inspector-title"><strong>{actual ? entry?.name ?? "未选择条目" : skill?.id ?? "未选择 Skill"}</strong><span>{skill?.collection ?? (entry ? "未归类" : "详情检查器")}</span></div>
      {label && <span className={`status-pill ${stateTone(state ?? "")}`}>{label}</span>}
    </div>
    <div className="inspector-scroll">
      {skill || entry ? <>
        <section className="inspector-section">
          <div className="section-label">在 {agent?.name ?? "Agent"} 中</div>
          <div className="entry-line"><span className={`cmp ${stateTone(state ?? "")}`}>{label ?? "未扫描"}</span></div>
          {linkPath && <PathBox path={linkPath} onCopy={onCopy} />}
          {entry?.targetPath && <><p className="sub">指向</p><PathBox path={entry.targetPath} onCopy={onCopy} /></>}
          {!entry && <p className="sub">此路径尚未创建。同步只创建链接，不复制 Skill 内容。</p>}
          {canSelect && <div className="inspector-actions"><button className={selected ? "btn" : "btn primary"} aria-pressed={selected} onClick={onToggleSelected}>{selected ? "移出同步队列" : "加入同步队列"}</button></div>}
          {entry && <div className="inspector-actions">
            {entry.kind === "repo-copy" && <button className="btn" disabled={busy} onClick={onConvert}>转为链接</button>}
            {["repo-link", "external-link", "broken-link"].includes(entry.kind) && <button className="btn danger" disabled={busy} onClick={() => onDelete(entry, entry.kind === "broken-link")}>{entry.kind === "broken-link" ? "删除断链" : "删除链接"}</button>}
          </div>}
          {record && <p className="sub">来源集合：{record.collection || "Vault 顶层"}</p>}
        </section>
        <section className="inspector-section">
          <div className="section-label">Vault <span className="tag-mini">只读</span></div>
          {skill ? <><PathBox path={skill.absolutePath} onCopy={onCopy} /><p className="sub">{skill.description || "暂无描述"}</p></> : <p className="desc">此条目未关联 Vault 中的 Skill。</p>}
        </section>
        <section className="inspector-section">
          <div className="section-label">校验</div>
          {issues.length ? issues.map((issue, index) => <div className={`checkline ${issue.severity}`} key={`${issue.code}:${index}`}><span className="mark">{issue.severity === "error" ? "✕" : "!"}</span><span>{issueText(issue)}</span></div>) : <div className="checkline valid"><span className="mark">✓</span><span>{skill ? "Skill 校验通过" : "未发现条目问题"}</span></div>}
          {row?.risks.includes("Multiple Agent entries point to this Skill key.") && <p className="sub">多个 Agent 条目指向同一个 Skill。</p>}
          {skill?.validity === "invalid" && <p className="issue">此 Skill 无效，不能同步。请在 Vault 中修正后刷新。</p>}
        </section>
        <details className="frontmatter"><summary>▸ frontmatter</summary><pre>{(actual ? entry?.frontmatter?.raw ?? skill?.frontmatter.raw : skill?.frontmatter.raw) || "无 frontmatter"}</pre></details>
      </> : <div className="inspector-empty">{actual ? "当前 Agent 没有可查看的条目" : "选择一个 Skill 查看详情"}</div>}
    </div>
  </aside>
}
