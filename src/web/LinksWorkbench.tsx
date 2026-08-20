import { useEffect, useState, type ReactElement } from "react"
import type { CommonPath, HostKind, LinkEntry, LinkPreflight, LinkScan, LinkSpec, SkillManagerConfig } from "../core/types.ts"
import { api } from "./api"

type Props = {
  config: SkillManagerConfig
  onConfigChange: (config: SkillManagerConfig) => void
  onNotice: (message: string) => void
  onError: (message: string) => void
}
type HostSelectProps = { value: HostKind; onChange: (value: HostKind) => void }
type PathCardProps = {
  title: string
  description: string
  host: HostKind
  path: string
  placeholder: string
  commonPaths: CommonPath[]
  onHostChange: (host: HostKind) => void
  onPathChange: (path: string) => void
  onFill: (item: CommonPath) => void
}
type ScanPanelProps = {
  host: HostKind
  path: string
  recursive: boolean
  scan: LinkScan | null
  entries: LinkEntry[]
  selectedEntry: LinkEntry | null
  busy: boolean
  onHostChange: (host: HostKind) => void
  onPathChange: (path: string) => void
  onRecursiveChange: (recursive: boolean) => void
  onScan: () => void
  onSelectEntry: (entry: LinkEntry) => void
  onDelete: () => void
}
type CommonPathsPanelProps = {
  paths: CommonPath[]
  onAdd: () => void
  onFillTarget: (item: CommonPath) => void
  onFillLink: (item: CommonPath) => void
  onScan: (item: CommonPath) => void
  onCopy: (item: CommonPath) => void
  onEdit: (item: CommonPath) => void
  onDelete: (item: CommonPath) => void
}
type PreflightPanelProps = { preflight: LinkPreflight; busy: boolean; onClose: () => void; onCreate: () => void }
type CommonPathModalProps = {
  draft: CommonPath
  editing: boolean
  onChange: (draft: CommonPath) => void
  onClose: () => void
  onSave: () => void
}

const emptySpec: LinkSpec = { targetHost: "wsl", targetPath: "", linkHost: "wsl", linkPath: "" }
const entryLabels: Record<string, string> = {
  file: "文件",
  directory: "目录",
  "wsl-symlink": "WSL 符号链接",
  "windows-symlink": "Windows 符号链接",
  "windows-junction": "Windows Junction",
  "unsupported-link": "不支持的链接",
  other: "其他",
}
const hostLabels: Record<HostKind, string> = { wsl: "WSL / POSIX", windows: "Windows" }

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function strategyLabel(value: string | undefined): string {
  switch (value) {
    case "wsl-symlink": return "WSL 符号链接"
    case "wsl-to-windows-symlink": return "WSL → Windows 符号链接"
    case "windows-to-wsl-symlink": return "Windows → WSL 符号链接"
    case "windows-junction": return "Windows Junction"
    case "windows-symlink": return "Windows 符号链接"
    default: return "未确定"
  }
}

function statusLabel(entry: LinkEntry): string {
  switch (entry.targetStatus) {
    case "exists": return "目标存在"
    case "broken": return "断链"
    default: return "—"
  }
}

function upsertCommonPath(paths: CommonPath[], value: CommonPath): CommonPath[] {
  const index = paths.findIndex(function (item): boolean { return item.id === value.id })
  if (index < 0) return [...paths, value]
  return paths.map(function (item): CommonPath { return item.id === value.id ? value : item })
}

function HostSelect({ value, onChange }: HostSelectProps): ReactElement {
  return <select value={value} onChange={(event) => onChange(event.target.value as HostKind)}><option value="wsl">{hostLabels.wsl}</option><option value="windows">{hostLabels.windows}</option></select>
}

function PathCard({ title, description, host, path, placeholder, commonPaths, onHostChange, onPathChange, onFill }: PathCardProps): ReactElement {
  return <div className="path-card">
    <div className="path-card-title"><b>{title}</b><span>{description}</span></div>
    <label>主机<HostSelect value={host} onChange={onHostChange} /></label>
    <label>路径<input value={path} placeholder={placeholder} onChange={(event) => onPathChange(event.target.value)} /></label>
    <div className="path-actions"><span className="path-picker-hint">可粘贴路径，或从常用路径填入</span>{commonPaths.map((item) => <button key={item.id} onClick={() => onFill(item)}>{item.name}</button>)}</div>
  </div>
}

function ScanPanel({ host, path, recursive, scan, entries, selectedEntry, busy, onHostChange, onPathChange, onRecursiveChange, onScan, onSelectEntry, onDelete }: ScanPanelProps): ReactElement {
  let summary = ""
  if (scan) {
    if (!scan.rootExists) summary = "路径不存在"
    else if (!scan.rootIsDirectory) summary = "不是目录"
    else summary = `${scan.entries.length} 个直接或递归条目`
  }
  return <section className="panel link-scan-panel">
    <div className="panel-heading"><span>扫描目录</span><span className="result-count">不跟随链接递归</span></div>
    <div className="scan-form">
      <label>主机<HostSelect value={host} onChange={onHostChange} /></label>
      <label className="scan-path-label">目录路径<input value={path} placeholder="输入要查看的目录" onChange={(event) => onPathChange(event.target.value)} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={recursive} onChange={(event) => onRecursiveChange(event.target.checked)} />递归</label>
      <button className="secondary-button" disabled={busy || !path.trim()} onClick={onScan}>扫描</button>
    </div>
    {scan && <div className="scan-summary"><span>{summary}</span><span>{scan.supported ? "适配器可用" : "适配器不可用"}</span></div>}
    <div className="link-entry-list">
      {!scan && <div className="list-empty">输入目录后扫描</div>}
      {scan && !entries.length && !scan.issues.length && <div className="list-empty">目录为空</div>}
      {entries.map((entry) => <button key={entry.absolutePath} className={selectedEntry?.absolutePath === entry.absolutePath ? "link-entry-row selected" : "link-entry-row"} onClick={() => onSelectEntry(entry)}>
        <span className={entry.canDelete ? "entry-type-dot link" : "entry-type-dot"} />
        <span className="entry-copy"><b>{entry.name}</b><small>{entry.relativePath}</small></span>
        <span className="entry-kind">{entryLabels[entry.kind] ?? entry.kind}<br /><small>{statusLabel(entry)}</small></span>
      </button>)}
    </div>
    {selectedEntry && <div className="selected-entry-detail">
      <b>{selectedEntry.absolutePath}</b>
      <span>{entryLabels[selectedEntry.kind] ?? selectedEntry.kind} · {statusLabel(selectedEntry)}</span>
      {selectedEntry.targetPath && <code>→ {selectedEntry.targetPath}</code>}
      <button className="danger-button" disabled={!selectedEntry.canDelete || busy} onClick={onDelete}>{selectedEntry.canDelete ? "删除此链接" : "普通文件/目录不可删除"}</button>
    </div>}
  </section>
}

function CommonPathsPanel({ paths, onAdd, onFillTarget, onFillLink, onScan, onCopy, onEdit, onDelete }: CommonPathsPanelProps): ReactElement {
  return <aside className="panel common-path-panel">
    <div className="panel-heading"><span>常用路径</span><button aria-label="添加常用路径" onClick={onAdd}>＋</button></div>
    <div className="common-path-list">
      {!paths.length && <div className="list-empty">保存经常使用的路径</div>}
      {paths.map((item) => <article className="common-path-row" key={item.id}>
        <div><b>{item.name}</b><small>{item.host} · {item.path}</small></div>
        <div className="common-path-actions">
          <button onClick={() => onFillTarget(item)}>目标</button>
          <button onClick={() => onFillLink(item)}>链接</button>
          <button onClick={() => onScan(item)}>扫描</button>
          <button onClick={() => onCopy(item)}>复制</button>
          <button aria-label={`编辑 ${item.name}`} onClick={() => onEdit(item)}>编辑</button>
          <button aria-label={`删除 ${item.name}`} onClick={() => onDelete(item)}>×</button>
        </div>
      </article>)}
    </div>
  </aside>
}

function PreflightPanel({ preflight, busy, onClose, onCreate }: PreflightPanelProps): ReactElement {
  return <section className={preflight.ready ? "panel preflight-panel ready" : "panel preflight-panel blocked"}>
    <div className="panel-heading"><span>预检结果</span><span className={preflight.ready ? "preflight-status ready" : "preflight-status blocked"}>{preflight.ready ? "可以创建" : "已阻止"}</span></div>
    <div className="preflight-body">
      <div><label>策略</label><strong>{strategyLabel(preflight.strategy)}</strong></div>
      <div><label>目标</label><code>{preflight.spec.targetPath}</code><small>{preflight.target.exists ? `已存在 · ${preflight.target.kind}` : "不存在"}</small></div>
      <div><label>链接</label><code>{preflight.spec.linkPath}</code><small>{preflight.link.exists ? "已存在" : "路径可用"}</small></div>
      <div><label>父目录</label><code>{preflight.parent.path}</code><small>{preflight.parent.directory ? "可写入位置已找到" : "不可用"}</small></div>
      {preflight.risks.length > 0 && <ul className="preflight-risks">{preflight.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>}
      <div className="preflight-actions"><button className="secondary-button" onClick={onClose}>关闭</button><button className="primary-button" disabled={!preflight.ready || busy} onClick={onCreate}>确认并真实创建</button></div>
    </div>
  </section>
}

function CommonPathModal({ draft, editing, onChange, onClose, onSave }: CommonPathModalProps): ReactElement {
  return <div className="modal-backdrop show" role="dialog" aria-modal="true" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal">
      <h3>{editing ? "编辑常用路径" : "添加常用路径"}</h3>
      <label>名称<input autoFocus value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
      <label>主机<HostSelect value={draft.host} onChange={(host) => onChange({ ...draft, host })} /></label>
      <label>路径<input value={draft.path} onChange={(event) => onChange({ ...draft, path: event.target.value })} /></label>
      <p className="hint">常用路径只保存到应用配置，不会创建、删除或修改该路径。</p>
      <div className="modal-actions"><button onClick={onClose}>取消</button><button className="primary-button" onClick={onSave}>保存</button></div>
    </div>
  </div>
}

export function LinksWorkbench({ config, onConfigChange, onNotice, onError }: Props): ReactElement {
  const [spec, setSpec] = useState<LinkSpec>(emptySpec)
  const [preflight, setPreflight] = useState<LinkPreflight | null>(null)
  const [busy, setBusy] = useState(false)
  const [scanHost, setScanHost] = useState<HostKind>("wsl")
  const [scanPath, setScanPath] = useState("")
  const [recursive, setRecursive] = useState(false)
  const [scan, setScan] = useState<LinkScan | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<LinkEntry | null>(null)
  const [commonEditor, setCommonEditor] = useState<CommonPath | null>(null)
  const commonPaths = config.commonPaths ?? []
  const scanEntries = scan?.entries ?? []

  useEffect(function restoreLastScanPath(): void {
    if (config.lastScanPath && !scanPath) setScanPath(config.lastScanPath)
  }, [config.lastScanPath])

  useEffect(function registerEscapeHandler(): () => void {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && commonEditor) setCommonEditor(null)
    }
    window.addEventListener("keydown", onKeyDown)
    return function removeEscapeHandler(): void { window.removeEventListener("keydown", onKeyDown) }
  }, [commonEditor])

  function updateSpec(patch: Partial<LinkSpec>): void {
    setSpec(function mergeSpec(current): LinkSpec { return { ...current, ...patch } })
    setPreflight(null)
  }

  async function runPreflight(): Promise<void> {
    setBusy(true)
    onError("")
    try {
      const response = await api.linkPreflight(spec)
      setPreflight(response.preflight)
    } catch (error) {
      onError(displayError(error))
    } finally {
      setBusy(false)
    }
  }

  async function runScan(host = scanHost, path = scanPath, recursiveValue = recursive): Promise<void> {
    if (!path.trim()) return
    setBusy(true)
    onError("")
    try {
      const response = await api.scanLinks(host, path, recursiveValue)
      setScan(response.scan)
      setSelectedEntry(null)
      if (response.scan.issues.length) onError(response.scan.issues.join("；"))
      // 记住上次扫描路径（真相 last_scan_path 语义）。
      if (config.lastScanPath !== path) {
        await api.putConfig({ ...config, lastScanPath: path })
        onConfigChange({ ...config, lastScanPath: path })
      }
    } catch (error) {
      onError(displayError(error))
    } finally {
      setBusy(false)
    }
  }

  async function create(): Promise<void> {
    if (!preflight?.ready) return
    const confirmation = `确认创建链接？\n\n目标：${preflight.spec.targetPath}\n链接：${preflight.spec.linkPath}\n策略：${strategyLabel(preflight.strategy)}\n\n此操作会真实修改文件系统。`
    if (!window.confirm(confirmation)) return
    setBusy(true)
    onError("")
    try {
      const response = await api.createLink(preflight.spec)
      if (!response.result.success) {
        onError(response.result.error ?? response.result.message)
        return
      }
      onNotice(`链接创建成功：${response.result.spec.linkPath}`)
      setPreflight(null)
      if (scan && scan.host === response.result.spec.linkHost) await runScan(scan.host, scan.path, scan.recursive)
    } catch (error) {
      onError(displayError(error))
    } finally {
      setBusy(false)
    }
  }

  async function deleteEntry(): Promise<void> {
    if (!selectedEntry?.canDelete || !scan) return
    const confirmation = `确认只删除这个链接条目？\n\n链接：${selectedEntry.absolutePath}\n目标：${selectedEntry.targetPath ?? "断链"}\n\n不会删除目标内容。`
    if (!window.confirm(confirmation)) return
    setBusy(true)
    onError("")
    try {
      const response = await api.deleteLink(scan.host, selectedEntry.absolutePath)
      if (!response.result?.success) {
        onError(response.result?.error ?? response.preflight.risks.join("；"))
        return
      }
      onNotice(`链接已删除：${selectedEntry.absolutePath}`)
      setSelectedEntry(null)
      await runScan()
    } catch (error) {
      onError(displayError(error))
    } finally {
      setBusy(false)
    }
  }

  async function saveCommonPath(): Promise<void> {
    if (!commonEditor) return
    if (!commonEditor.name.trim() || !commonEditor.path.trim()) {
      onError("常用路径名称和路径不能为空")
      return
    }
    const draft = commonEditor
    const duplicate = commonPaths.find(function (item): boolean {
      return item.id !== draft.id && item.host === draft.host && item.path === draft.path
    })
    if (duplicate) {
      onError("相同主机下的常用路径不能重复")
      return
    }
    const savedDraft: CommonPath = { id: draft.id, name: draft.name.trim(), host: draft.host, path: draft.path.trim() }
    const next: SkillManagerConfig = { ...config, commonPaths: upsertCommonPath(commonPaths, savedDraft) }
    setBusy(true)
    onError("")
    try {
      const response = await api.putConfig(next)
      onConfigChange(response.config)
      setCommonEditor(null)
      onNotice("常用路径已保存")
    } catch (error) {
      onError(displayError(error))
    } finally {
      setBusy(false)
    }
  }

  async function removeCommonPath(item: CommonPath): Promise<void> {
    if (!window.confirm(`删除常用路径「${item.name}」？\n只删除应用配置，不删除实际路径。`)) return
    setBusy(true)
    onError("")
    try {
      const response = await api.putConfig({ ...config, commonPaths: commonPaths.filter(function (value): boolean { return value.id !== item.id }) })
      onConfigChange(response.config)
      onNotice("常用路径已删除")
    } catch (error) {
      onError(displayError(error))
    } finally {
      setBusy(false)
    }
  }

  async function copyPath(item: CommonPath): Promise<void> {
    try {
      await navigator.clipboard.writeText(item.path)
      onNotice("路径已复制")
    } catch (error) {
      onError(`复制失败：${displayError(error)}`)
    }
  }

  function fillTarget(item: CommonPath): void { updateSpec({ targetHost: item.host, targetPath: item.path }) }
  function fillLink(item: CommonPath): void { updateSpec({ linkHost: item.host, linkPath: item.path }) }
  function prepareScan(item: CommonPath): void {
    setScanHost(item.host)
    setScanPath(item.path)
    void runScan(item.host, item.path, recursive)
  }

  return <main className="links-workspace">
    <section className="links-intro"><div><span className="eyebrow">GENERIC FILESYSTEM LINKS</span><h1>通用链接</h1><p>输入任意目标路径和链接路径。软件会先检查，再由后台执行真实链接操作。</p></div><span className="real-operation-badge">真实文件操作已启用</span></section>
    <section className="links-grid">
      <section className="panel link-create-panel">
        <div className="panel-heading"><span>创建链接</span><span className="result-count">目标与链接路径必须明确</span></div>
        <div className="link-form-content">
          <PathCard title="Link Target · 目标" description="已有文件或目录" host={spec.targetHost} path={spec.targetPath} placeholder={spec.targetHost === "wsl" ? "/home/user/source" : "C:\\Users\\user\\source"} commonPaths={commonPaths} onHostChange={(targetHost) => updateSpec({ targetHost })} onPathChange={(targetPath) => updateSpec({ targetPath })} onFill={fillTarget} />
          <PathCard title="Link Path · 链接" description="新链接条目" host={spec.linkHost} path={spec.linkPath} placeholder={spec.linkHost === "wsl" ? "/home/user/links/name" : "C:\\Users\\user\\links\\name"} commonPaths={commonPaths} onHostChange={(linkHost) => updateSpec({ linkHost })} onPathChange={(linkPath) => updateSpec({ linkPath })} onFill={fillLink} />
          <div className="link-form-actions"><button className="secondary-button" onClick={() => { setSpec(emptySpec); setPreflight(null) }}>清空</button><button className="primary-button" disabled={busy || !spec.targetPath || !spec.linkPath} onClick={() => void runPreflight()}>{busy ? "检查中…" : "预检链接"}</button></div>
          <p className="safety-note">预检会确认目标存在、链接路径不存在、父目录可用，并阻止覆盖普通文件或目录。</p>
        </div>
      </section>
      <ScanPanel host={scanHost} path={scanPath} recursive={recursive} scan={scan} entries={scanEntries} selectedEntry={selectedEntry} busy={busy} onHostChange={setScanHost} onPathChange={setScanPath} onRecursiveChange={setRecursive} onScan={() => void runScan()} onSelectEntry={setSelectedEntry} onDelete={() => void deleteEntry()} />
      <CommonPathsPanel paths={commonPaths} onAdd={() => setCommonEditor({ id: `path-${Date.now()}`, name: "", host: "wsl", path: "" })} onFillTarget={fillTarget} onFillLink={fillLink} onScan={prepareScan} onCopy={(item) => void copyPath(item)} onEdit={setCommonEditor} onDelete={(item) => void removeCommonPath(item)} />
    </section>
    {preflight && <PreflightPanel preflight={preflight} busy={busy} onClose={() => setPreflight(null)} onCreate={() => void create()} />}
    {commonEditor && <CommonPathModal draft={commonEditor} editing={commonPaths.some((item) => item.id === commonEditor.id)} onChange={setCommonEditor} onClose={() => setCommonEditor(null)} onSave={() => void saveCommonPath()} />}
  </main>
}
