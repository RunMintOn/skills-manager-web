import { useMemo, useState } from "react"

type View = "repository" | "compare" | "actual"

type MockSkill = {
  id: string
  collection: string
  path: string
  status: string
  description: string
  valid: boolean
}

const MOCK_SKILLS: MockSkill[] = [
  { id: "code-review", collection: "engineering", path: "engineering/code-review", status: "已链接", description: "审阅代码变更并输出风险。", valid: true },
  { id: "lint-helper", collection: "engineering", path: "engineering/tools/lint-helper", status: "待链接", description: "统一项目 lint 检查。", valid: true },
  { id: "unicode-helper", collection: "Loose Skills", path: "unicode-helper", status: "本地目录", description: "处理 Unicode 与中文文本。", valid: true },
  { id: "broken-demo", collection: "operations", path: "operations/broken-demo", status: "无效", description: "目录名与 frontmatter 不一致。", valid: false },
]

export function App() {
  const [topTab, setTopTab] = useState<"skills" | "links">("skills")
  const [view, setView] = useState<View>("compare")
  const [query, setQuery] = useState("")
  const [selectedAgent, setSelectedAgent] = useState("pi")
  const [selectedSkill, setSelectedSkill] = useState("code-review")
  const [checked, setChecked] = useState<string[]>([])
  const [dark, setDark] = useState(false)

  const skills = useMemo(
    () => MOCK_SKILLS.filter((skill) => `${skill.id} ${skill.collection} ${skill.path} ${skill.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    [query],
  )
  const detail = MOCK_SKILLS.find((skill) => skill.id === selectedSkill) ?? skills[0]
  const toggle = (id: string) => setChecked((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])

  return (
    <div className={dark ? "app dark" : "app"}>
      <header className="topbar">
        <div className="brand-mark">SV</div>
        <div className="brand-copy"><strong>Skill Vault</strong><span>localhost workspace</span></div>
        <div className="divider" />
        <nav className="top-tabs" aria-label="主导航">
          <button className={topTab === "skills" ? "top-tab active" : "top-tab"} onClick={() => setTopTab("skills")}>技能管理</button>
          <button className={topTab === "links" ? "top-tab active" : "top-tab"} onClick={() => setTopTab("links")}>通用链接</button>
        </nav>
        <div className="top-spacer" />
        <button className="icon-button" aria-label="切换主题" onClick={() => setDark((value) => !value)}>{dark ? "☀" : "☾"}</button>
        <span className="runtime-pill"><i /> WSL · 127.0.0.1:8787</span>
      </header>
      {topTab === "links" ? (
        <main className="placeholder-page"><div className="empty-icon">↗</div><h1>通用链接</h1><p>通用链接工作台将在技能管理基础能力稳定后接入。</p><span className="soft-badge">Phase 2 · 占位</span></main>
      ) : (
        <main className="workspace">
          <section className="workspace-toolbar">
            <div className="vault-context"><span className="eyebrow">VAULT REPOSITORY</span><strong>/home/lee/skills-vault</strong></div>
            <button className="secondary-button">⌘ 配置</button><button className="secondary-button">↻ 刷新</button>
            <span className="validation-pill"><b>✓</b> 1 个问题</span>
          </section>
          <section className="view-tabs" aria-label="技能视图">
            {([ ["repository", "Repository"], ["compare", "Compare"], ["actual", "Agent actual"]] as const).map(([key, label]) => <button key={key} className={view === key ? "view-tab active" : "view-tab"} onClick={() => setView(key)}>{label}</button>)}
            <div className="toolbar-spacer" /><span className="shortcut-hint">按 <kbd>/</kbd> 搜索</span><input aria-label="搜索技能" placeholder="搜索 skill、collection、描述…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </section>
          <section className="columns">
            <aside className="panel agent-panel"><div className="panel-heading"><span>AGENTS</span><button aria-label="添加 Agent">＋</button></div><div className="agent-list">{[ ["pi", "Pi Coding Agent", "2 个问题"], ["claude", "Claude Code", "已同步"], ["cursor", "Cursor", "1 个问题"]].map(([id, name, issue]) => <button key={id} className={selectedAgent === id ? "agent-row selected" : "agent-row"} onClick={() => setSelectedAgent(id)}><span className="agent-avatar">{id.slice(0, 1).toUpperCase()}</span><span className="agent-info"><b>{name}</b><small>~/.agents/skills</small></span><span className={issue === "已同步" ? "agent-state ok" : "agent-state"}>{issue}</span></button>)}</div><div className="panel-foot"><span>3 agents</span><button>管理</button></div></aside>
            <section className="panel skill-panel"><div className="panel-heading"><span>{view === "repository" ? "VAULT SKILLS" : view === "actual" ? "ACTUAL ENTRIES" : "COMPARE WITH PI"}</span><span className="result-count">{skills.length} 项</span></div><div className="skill-groups">{["engineering", "Loose Skills", "operations"].map((collection) => { const group = skills.filter((skill) => skill.collection === collection); if (!group.length) return null; return <div className="skill-group" key={collection}><div className="group-heading"><span>⌄</span><b>{collection}</b><small>{group.length}</small></div>{group.map((skill) => <div role="button" tabIndex={0} className={selectedSkill === skill.id ? "skill-row selected" : "skill-row"} key={skill.id} onClick={() => setSelectedSkill(skill.id)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedSkill(skill.id); if (event.key === " ") { event.preventDefault(); toggle(skill.id) } }}><input aria-label={`选择 ${skill.id}`} type="checkbox" checked={checked.includes(skill.id)} onChange={() => toggle(skill.id)} onClick={(event) => event.stopPropagation()} /><span className="skill-name"><b>{skill.id}</b><small>{skill.path}</small></span><span className={skill.valid ? `status-tag ${skill.status === "已链接" ? "linked" : "pending"}` : "status-tag invalid"}>{skill.status}</span></div>)}</div> })}</div><div className="panel-foot"><span>{checked.length} 项已选择</span><button className="primary-button" disabled={!checked.length}>预览同步 →</button></div></section>
            <aside className="panel detail-panel">{detail ? <><div className="panel-heading"><span>SKILL DETAIL</span><button aria-label="关闭详情">×</button></div><div className="detail-content"><div className="detail-title"><span className="detail-symbol">✦</span><div><h2>{detail.id}</h2><p>{detail.collection} / {detail.id}</p></div></div><div className="detail-section"><label>VAULT PATH</label><code>/home/lee/skills-vault/{detail.path}</code></div><div className="detail-section"><label>FRONTMATTER</label><pre>{`name: ${detail.id}\ndescription: ${detail.description}\nversion: 1.0`}</pre></div><div className="detail-section"><label>VALIDATION</label><div className={detail.valid ? "validation-line good" : "validation-line bad"}><span>{detail.valid ? "✓" : "!"}</span>{detail.valid ? "目录名与 name 完全匹配" : "目录名与 frontmatter name 不匹配"}</div></div><div className="detail-section"><label>AGENT ENTRY · {selectedAgent.toUpperCase()}</label><div className="agent-entry"><span className="entry-dot" />{detail.status}<code>~/.agents/skills/{detail.id}</code></div></div><div className="detail-section"><label>RISK</label><p className="risk-copy">{detail.valid ? "无阻塞风险。同步将创建扁平化目录链接。" : "此 Skill 无法进入同步计划，请修正元数据后刷新。"}</p></div></div></> : <div className="empty-state">选择一个 Skill 查看详情</div>}</aside>
          </section>
          <footer className="statusbar"><span><i className="status-dot" />扫描完成 · 4 个 Skill · {checked.length} 个已选择</span><span>Vault 只读 · 同步仅生成预览</span></footer>
        </main>
      )}
    </div>
  )
}
