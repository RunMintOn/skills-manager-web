import { useEffect, useMemo, useState, type ReactElement } from "react"
import type { MirrorSyncConfig, MirrorSyncPlan, SkillManagerConfig, VaultScan } from "../core/types.ts"
import { synchronizeBaselineWithMirror } from "../core/baseline.ts"

const DEFAULT_MIRROR_EXCLUDE = ["node_modules/**", ".git/**", ".DS_Store", "Thumbs.db", "*.log", "*:Zone.Identifier"]
import { api } from "./api"

type Props = {
  config: SkillManagerConfig
  onConfigChange: (config: SkillManagerConfig) => void
  onNotice: (message: string) => void
  onError: (message: string) => void
}

function displayError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function hostLabel(host: MirrorSyncConfig["source"]["host"]): string { return host === "windows" ? "Windows" : "WSL" }
function pathPlaceholder(host: MirrorSyncConfig["source"]["host"], label: string): string { return host === "windows" ? `C:\\...\\${label}-VAULT` : `/home/.../${label}-VAULT` }
function initialSync(config: SkillManagerConfig): MirrorSyncConfig {
  if (config.mirrorSync) return config.mirrorSync
  return {
    source: { host: "windows", path: config.commonPaths?.find(function (item): boolean { return item.host === "windows" })?.path ?? "" },
    mirror: { host: "wsl", path: config.vault.host === "wsl" ? config.vault.path : "" },
    scope: "full",
    exclude: [...DEFAULT_MIRROR_EXCLUDE],
  }
}
function count(plan: MirrorSyncPlan, action: string): number { return plan.summary[action as keyof MirrorSyncPlan["summary"]] ?? 0 }

export function MirrorSyncWorkbench({ config, onConfigChange, onNotice, onError: onAppError }: Props): ReactElement {
  const [draft, setDraft] = useState<MirrorSyncConfig>(() => initialSync(config))
  const [error, setError] = useState("")
  function reportError(message: string): void { setError(message); onAppError(message) }
  function clearError(): void { setError(""); onAppError("") }
  const [source, setSource] = useState<VaultScan | null>(null)
  const [plan, setPlan] = useState<MirrorSyncPlan | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(function restoreConfig(): void { setDraft(initialSync(config)); setSource(null); setPlan(null) }, [config])
  const selected = new Set(draft.selectedPaths ?? [])
  const validSkills = useMemo(() => source?.skills.filter(function (skill): boolean { return skill.validity === "valid" }) ?? [], [source])

  async function persistDraft(value: MirrorSyncConfig): Promise<boolean> {
    if (!value.source.path.trim() || !value.mirror.path.trim()) { reportError("源 Vault 与镜像 Vault 路径都不能为空"); return false }
    if (value.source.host === value.mirror.host) { reportError("源 Vault 与镜像 Vault 必须使用不同 Host"); return false }
    setBusy(true)
    try {
      const mirrorSync: MirrorSyncConfig = { ...value, source: { ...value.source, path: value.source.path.trim() }, mirror: { ...value.mirror, path: value.mirror.path.trim() } }
      const activeVault = [mirrorSync.source, mirrorSync.mirror].find(function (side): boolean { return side.host === config.vault.host })
      if (!activeVault) { reportError(`镜像配置中没有 ${hostLabel(config.vault.host)} Vault`); return false }
      const nextConfig = synchronizeBaselineWithMirror({ ...config, mirrorSync }, activeVault)
      const result = await api.putConfig(nextConfig)
      onConfigChange(result.config)
      return true
    } catch (error) { reportError(displayError(error)); return false } finally { setBusy(false) }
  }

  async function saveDraft(): Promise<boolean> { return persistDraft(draft) }

  async function scanSource(): Promise<void> {
    if (!await saveDraft()) return
    setBusy(true); clearError()
    try {
      const response = await api.mirrorSource()
      setSource(response.vault)
      if (response.vault.issues.length) reportError(response.vault.issues.map(function (issue): string { return issue.message }).join("；"))
    } catch (error) { reportError(displayError(error)) } finally { setBusy(false) }
  }

  async function swapVaults(): Promise<void> {
    const nextDraft: MirrorSyncConfig = { ...draft, source: draft.mirror, mirror: draft.source }
    setDraft(nextDraft)
    setSource(null)
    setPlan(null)
    clearError()
    if (await persistDraft(nextDraft)) onNotice("源 Vault 与镜像 Vault 已互换；未执行文件复制")
  }

  function toggle(path: string): void {
    setDraft(function (current): MirrorSyncConfig {
      const paths = new Set(current.selectedPaths ?? [])
      if (paths.has(path)) paths.delete(path)
      else paths.add(path)
      return { ...current, selectedPaths: [...paths] }
    })
    setPlan(null)
  }

  async function preview(): Promise<void> {
    if (draft.scope === "selected" && !selected.size) { reportError("选择同步至少需要选择一个 Skill"); return }
    if (!await saveDraft()) return
    setBusy(true); clearError()
    try {
      const response = await api.mirrorPlan()
      setPlan(response.plan)
      if (response.plan.issues.length) reportError(response.plan.issues.join("；"))
    } catch (error) { reportError(displayError(error)) } finally { setBusy(false) }
  }

  async function execute(): Promise<void> {
    if (!plan?.ready) return
    const changes = count(plan, "create-directory") + count(plan, "copy-file") + count(plan, "delete-file") + count(plan, "delete-directory")
    const direction = `${hostLabel(plan.sync.source.host)} → ${hostLabel(plan.sync.mirror.host)}`
    if (!window.confirm(`确认执行 ${changes} 项 ${direction} 同步？\n\n${hostLabel(plan.sync.source.host)} 源不会修改。${hostLabel(plan.sync.mirror.host)} 受管路径会被创建、更新或删除。`)) return
    setBusy(true); clearError()
    try {
      const result = await api.executeMirrorSync()
      setPlan(result.plan)
      if (result.execution === "completed") onNotice(`${hostLabel(result.plan.sync.source.host)} → ${hostLabel(result.plan.sync.mirror.host)} 镜像同步完成`)
      else reportError(result.results.filter(function (item): boolean { return !item.success }).map(function (item): string { return item.error ?? item.message }).join("；") || result.plan.issues.join("；") || "同步未完成")
    } catch (error) { reportError(displayError(error)) } finally { setBusy(false) }
  }

  return <main className="mirror-workbench">
    {error && <div className="banner banner-error" role="alert">⚠ {error}<button onClick={clearError}>×</button></div>}
    <section className="panel mirror-settings">
      <div className="panel-heading"><span>{hostLabel(draft.source.host)} → {hostLabel(draft.mirror.host)} 镜像同步</span><span className="result-count">源只读</span></div>
      <div className="mirror-form">
        <label>{hostLabel(draft.source.host)} 源 Vault<input value={draft.source.path} placeholder={pathPlaceholder(draft.source.host, "SOURCE")} onChange={(event) => { setDraft({ ...draft, source: { ...draft.source, path: event.target.value } }); setPlan(null) }} /></label>
        <label>{hostLabel(draft.mirror.host)} 镜像 Vault<input value={draft.mirror.path} placeholder={pathPlaceholder(draft.mirror.host, "MIRROR")} onChange={(event) => { setDraft({ ...draft, mirror: { ...draft.mirror, path: event.target.value } }); setPlan(null) }} /></label>
        <fieldset className="mirror-scope"><legend>同步范围</legend><label><input type="radio" checked={draft.scope === "full"} onChange={() => { setDraft({ ...draft, scope: "full" }); setPlan(null) }} />全量：整个仓库和目录层级</label><label><input type="radio" checked={draft.scope === "selected"} onChange={() => { setDraft({ ...draft, scope: "selected" }); setPlan(null) }} />选择：仅勾选的 Skill，但保持原相对路径</label></fieldset>
        <label>排除规则（每行一项；不支持 <code>!</code> 反选）<textarea rows={5} value={(draft.exclude ?? DEFAULT_MIRROR_EXCLUDE).join("\n")} onChange={(event) => { setDraft({ ...draft, exclude: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) }); setPlan(null) }} /></label>
        <div className="mirror-actions"><button className="secondary-button" disabled={busy} onClick={() => void swapVaults()}>互换源 / 镜像</button><button className="secondary-button" disabled={busy} onClick={() => void saveDraft()}>保存设置</button><button className="primary-button" disabled={busy} onClick={() => void scanSource()}>{busy ? "处理中…" : `扫描 ${hostLabel(draft.source.host)} 源 Vault`}</button></div>
      </div>
    </section>

    {draft.scope === "selected" && <section className="panel mirror-selection">
      <div className="panel-heading"><span>选择要镜像的 Skill</span><span className="result-count">{selected.size} 项已选择</span></div>
      {!source && <div className="list-empty">先扫描 {hostLabel(draft.source.host)} 源 Vault</div>}
      {source && <div className="mirror-skill-list">{validSkills.map((skill) => <label key={skill.relativePath} className="mirror-skill-row"><input type="checkbox" checked={selected.has(skill.relativePath)} onChange={() => toggle(skill.relativePath)} /><span><b>{skill.name ?? skill.directoryName}</b><small>{skill.relativePath}</small></span></label>)}</div>}
    </section>}

    <section className="panel mirror-preview">
      <div className="panel-heading"><span>同步预览</span><span className="result-count">只读，确认前不写文件</span></div>
      {!plan && <div className="mirror-empty"><p>保存设置后计算预览。当前方向为 {hostLabel(draft.source.host)} → {hostLabel(draft.mirror.host)}。全量模式会镜像整个 Vault。选择模式只管理勾选路径。</p><button className="primary-button" disabled={busy} onClick={() => void preview()}>{busy ? "计算中…" : "计算同步预览"}</button></div>}
      {plan && <div className="mirror-plan-body">
        <div className="mirror-summary"><span>创建目录 <b>{count(plan, "create-directory")}</b></span><span>复制/更新 <b>{count(plan, "copy-file")}</b></span><span>删除文件 <b>{count(plan, "delete-file")}</b></span><span>删除目录 <b>{count(plan, "delete-directory")}</b></span><span>跳过 <b>{count(plan, "skip")}</b></span></div>
        {plan.issues.length > 0 && <ul className="preflight-risks">{plan.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
        <div className="mirror-operation-list">{plan.operations.map((operation) => <article key={operation.id} className={`mirror-operation ${operation.action === "skip" ? "skipped" : ""}`}><b>{operation.action}</b><code>{operation.relativePath || "."}</code><small>{operation.reason}</small></article>)}</div>
        <div className="mirror-actions"><button className="secondary-button" disabled={busy} onClick={() => void preview()}>刷新预览</button><button className="primary-button" disabled={!plan.ready || busy} onClick={() => void execute()}>{busy ? "同步中…" : "确认并同步"}</button></div>
      </div>}
    </section>
  </main>
}
