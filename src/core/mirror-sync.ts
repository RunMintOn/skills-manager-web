import { copyFile, lstat, mkdir, readdir, rename, rm, stat, unlink, utimes } from "node:fs/promises"
import nodePath from "node:path"
import { assertSafeWindowsPath, assertSafeWslPath } from "./link-plan.ts"
import { getHostPathAdapter, windowsPathToWsl } from "./host.ts"
import { scanWindowsDirectory } from "./windows-scan.ts"
import type { HostKind, MirrorSyncConfig, MirrorSyncExecution, MirrorSyncOperation, MirrorSyncPlan, VaultConfig } from "./types.ts"

export const DEFAULT_MIRROR_EXCLUDE = ["node_modules/**", ".git/**", ".DS_Store", "Thumbs.db", "*.log", "*:Zone.Identifier"]
const MAX_MIRROR_ENTRIES = 100_000

type TreeEntry = { relativePath: string; path: string; kind: "file" | "directory" | "link" | "other"; size?: number; modifiedMs?: number }
type MirrorTree = { root: "missing" | "directory" | "other"; entries: Map<string, TreeEntry>; issues: string[] }
type SourceTree = { entries: Map<string, TreeEntry>; protectedPaths: string[] }

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function hostLabel(host: HostKind): string { return host === "windows" ? "Windows" : "WSL" }

function normalRelativePath(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/").replace(/\/$/u, "")
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) || normalized.split("/").some(function (part): boolean { return !part || part === "." || part === ".." })) {
    throw new Error(`${label} must be a safe relative path`)
  }
  return normalized
}

function normalizedConfig(input: MirrorSyncConfig): MirrorSyncConfig {
  if (input.source.host === "windows") assertSafeWindowsPath(input.source.path, "mirrorSync.source.path")
  else assertSafeWslPath(input.source.path, "mirrorSync.source.path")
  if (input.mirror.host === "windows") assertSafeWindowsPath(input.mirror.path, "mirrorSync.mirror.path")
  else assertSafeWslPath(input.mirror.path, "mirrorSync.mirror.path")
  if (input.source.host === input.mirror.host) throw new Error("mirror sync requires different source and mirror hosts")
  const selectedPaths = (input.selectedPaths ?? []).map(function (path): string { return normalRelativePath(path, "mirrorSync.selectedPaths") })
  if (new Set(selectedPaths).size !== selectedPaths.length) throw new Error("mirrorSync.selectedPaths contains duplicates")
  if (input.scope === "selected" && !selectedPaths.length) throw new Error("mirrorSync.selectedPaths is required for selected scope")
  if (input.scope !== "full" && input.scope !== "selected") throw new Error("mirrorSync.scope must be full or selected")
  const exclude = input.exclude === undefined ? undefined : input.exclude.map(function (pattern): string {
    if (!pattern.trim() || pattern.includes("\0") || pattern.startsWith("!")) throw new Error("mirrorSync.exclude only accepts non-empty positive patterns")
    return pattern.replaceAll("\\", "/").replace(/^\.\//u, "")
  })
  const normalize = function (vault: VaultConfig): VaultConfig {
    return { host: vault.host, path: vault.host === "windows" ? nodePath.win32.normalize(vault.path) : nodePath.posix.normalize(vault.path) }
  }
  return {
    source: normalize(input.source),
    mirror: normalize(input.mirror),
    scope: input.scope,
    ...(selectedPaths.length ? { selectedPaths } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
  }
}

function effectiveExcludes(sync: MirrorSyncConfig): string[] { return sync.exclude ?? DEFAULT_MIRROR_EXCLUDE }

function patternMatches(relativePath: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "")
  const candidate = normalized.includes("/") ? relativePath : nodePath.posix.basename(relativePath)
  if (normalized.endsWith("/**")) {
    const directory = normalized.slice(0, -3)
    if (!directory.includes("/") && relativePath.split("/").includes(directory)) return true
    if (candidate === directory) return true
  }
  let expression = "^"
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index]!
    const next = normalized[index + 1]
    if (current === "*" && next === "*") {
      expression += ".*"; index += 1
    } else if (current === "*") expression += "[^/]*"
    else if (current === "?") expression += "[^/]"
    else expression += current.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&")
  }
  return new RegExp(`${expression}$`, "u").test(candidate)
}

function excluded(relativePath: string, patterns: string[]): boolean {
  return patterns.some(function (pattern): boolean { return patternMatches(relativePath, pattern) })
}

function skippedDirectoryNames(patterns: string[]): string[] {
  return [...new Set(patterns.flatMap(function (pattern): string[] {
    const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "")
    const directory = normalized.endsWith("/**") ? normalized.slice(0, -3) : ""
    return directory && !directory.includes("/") && !/[?*]/u.test(directory) ? [directory] : []
  }))]
}

function hostPath(vault: VaultConfig, relativePath: string): string {
  const adapter = getHostPathAdapter(vault.host)
  return relativePath ? adapter.join(vault.path, ...relativePath.split("/")) : vault.path
}

function runtimePath(vault: VaultConfig, path: string): string {
  if (vault.host === "wsl") {
    if (process.platform === "win32") throw new Error("WSL paths are unavailable from a native Windows runtime")
    return path
  }
  if (process.platform === "win32") return path
  const converted = windowsPathToWsl(path)
  if (!converted) throw new Error("Windows paths must use a drive path accessible from WSL")
  return converted
}

function relativeWindowsPath(root: string, path: string): string {
  const relative = nodePath.win32.relative(root, path).replaceAll("\\", "/")
  return normalRelativePath(relative, "Windows scan result")
}

function depth(value: string): number { return value ? value.split("/").length : 0 }
function under(root: string, path: string): boolean { return path === root || path.startsWith(`${root}/`) }
function selected(relativePath: string, sync: MirrorSyncConfig): boolean {
  return sync.scope === "full" || (sync.selectedPaths ?? []).some(function (root): boolean { return under(root, relativePath) })
}

function addOperation(operations: MirrorSyncOperation[], action: MirrorSyncOperation["action"], relativePath: string, mirrorPath: string, reason: string, sourcePath?: string): void {
  operations.push({ id: `${action}:${relativePath || "."}`, relativePath, action, mirrorPath, reason, ...(sourcePath ? { sourcePath } : {}), execution: "not-run" })
}

function summary(operations: MirrorSyncOperation[]): MirrorSyncPlan["summary"] {
  return { "create-directory": operations.filter(function (item): boolean { return item.action === "create-directory" }).length, "copy-file": operations.filter(function (item): boolean { return item.action === "copy-file" }).length, "delete-file": operations.filter(function (item): boolean { return item.action === "delete-file" }).length, "delete-directory": operations.filter(function (item): boolean { return item.action === "delete-directory" }).length, skip: operations.filter(function (item): boolean { return item.action === "skip" }).length }
}

async function scanWslTree(vault: VaultConfig, patterns: string[]): Promise<MirrorTree> {
  const rootRuntime = runtimePath(vault, vault.path)
  const rootInfo = await lstat(rootRuntime).catch(function (): undefined { return undefined })
  if (!rootInfo) return { root: "missing", entries: new Map(), issues: [] }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return { root: "other", entries: new Map(), issues: [`${hostLabel(vault.host)} Vault 根目录必须是普通目录，不能是链接或文件`] }
  const entries = new Map<string, TreeEntry>()
  const issues: string[] = []
  const queue = [""]
  while (queue.length) {
    const relativeDirectory = queue.shift()!
    const directoryRuntime = runtimePath(vault, hostPath(vault, relativeDirectory))
    let children: string[]
    try { children = await readdir(directoryRuntime) } catch (error) { issues.push(`无法读取 ${hostLabel(vault.host)} Vault 目录 ${hostPath(vault, relativeDirectory)}：${errorText(error)}`); continue }
    for (const child of children) {
      if (entries.size >= MAX_MIRROR_ENTRIES) { issues.push(`${hostLabel(vault.host)} Vault 条目超过 ${MAX_MIRROR_ENTRIES} 个，已停止扫描`); return { root: "directory", entries, issues } }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child}` : child
      if (excluded(relativePath, patterns)) continue
      const path = hostPath(vault, relativePath)
      const info = await lstat(runtimePath(vault, path)).catch(function (error: unknown): undefined { issues.push(`无法读取 ${hostLabel(vault.host)} Vault 条目 ${path}：${errorText(error)}`); return undefined })
      if (!info) continue
      const kind: TreeEntry["kind"] = info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other"
      entries.set(relativePath, { relativePath, path, kind, ...(kind === "file" ? { size: info.size, modifiedMs: Math.round(info.mtimeMs) } : {}) })
      if (kind === "directory") queue.push(relativePath)
    }
  }
  return { root: "directory", entries, issues }
}

function windowsTree(vault: VaultConfig, patterns: string[]): Promise<MirrorTree> {
  return scanWindowsDirectory({ path: vault.path, recursive: true, maxEntries: MAX_MIRROR_ENTRIES, skipDirectoryNames: skippedDirectoryNames(patterns), skipTopLevelDotDirectories: false }).then(function (scan): MirrorTree {
    const entries = new Map<string, TreeEntry>()
    const issues = [...scan.issues]
    for (const item of scan.entries) {
      let relativePath: string
      try { relativePath = relativeWindowsPath(vault.path, item.path) } catch (error) { issues.push(errorText(error)); continue }
      if (excluded(relativePath, patterns)) continue
      const kind: TreeEntry["kind"] = item.isReparsePoint ? "link" : item.isDirectory ? "directory" : "file"
      entries.set(relativePath, { relativePath, path: item.path, kind, ...(!item.isDirectory && !item.isReparsePoint ? { size: item.size, modifiedMs: item.modifiedMs } : {}) })
    }
    return { root: !scan.rootExists ? "missing" : !scan.rootIsDirectory ? "other" : "directory", entries, issues: scan.rootIsDirectory ? issues : [...issues, `${hostLabel(vault.host)} Vault 路径不是目录`] }
  })
}

async function scanHostTree(vault: VaultConfig, patterns: string[]): Promise<MirrorTree> {
  try {
    return vault.host === "windows" ? await windowsTree(vault, patterns) : await scanWslTree(vault, patterns)
  } catch (error) {
    return { root: "other", entries: new Map(), issues: [errorText(error)] }
  }
}

function sourceEntries(source: MirrorTree, sync: MirrorSyncConfig, patterns: string[], operations: MirrorSyncOperation[]): SourceTree {
  const entries = new Map<string, TreeEntry>()
  const protectedPaths: string[] = []
  for (const item of source.entries.values()) {
    const relativePath = item.relativePath
    if (!selected(relativePath, sync) || excluded(relativePath, patterns)) continue
    const mirrorPath = hostPath(sync.mirror, relativePath)
    if (item.kind === "link") {
      protectedPaths.push(relativePath)
      addOperation(operations, "skip", relativePath, mirrorPath, "源路径是链接；未跟随，也未复制")
      continue
    }
    if (item.kind === "other") {
      protectedPaths.push(relativePath)
      addOperation(operations, "skip", relativePath, mirrorPath, "源路径不是普通文件或目录；未复制")
      continue
    }
    entries.set(relativePath, item)
  }
  return { entries, protectedPaths }
}

function addRequiredParents(entries: Map<string, TreeEntry>, sync: MirrorSyncConfig): void {
  const all = [...entries.values()]
  for (const entry of all) {
    for (let index = 1; index <= depth(entry.relativePath); index += 1) {
      const relativePath = entry.relativePath.split("/").slice(0, index).join("/")
      if (!entries.has(relativePath)) entries.set(relativePath, { relativePath, path: hostPath(sync.source, relativePath), kind: "directory" })
    }
  }
}

function protectedPath(relativePath: string, paths: string[]): boolean { return paths.some(function (path): boolean { return under(path, relativePath) || under(relativePath, path) }) }

function emptyPlan(sync: MirrorSyncConfig, operations: MirrorSyncOperation[], issues: string[], note: string): MirrorSyncPlan {
  return { schemaVersion: 1, mode: "preview-only", sync, ready: false, operations, issues: [...new Set(issues)], summary: summary(operations), safety: { filesystemWrites: "disabled", source: "read-only", note } }
}

function sameRuntimePath(left: VaultConfig, right: VaultConfig): boolean {
  try {
    const leftRuntime = nodePath.resolve(runtimePath(left, left.path))
    const rightRuntime = nodePath.resolve(runtimePath(right, right.path))
    return process.platform === "win32"
      ? leftRuntime.toLocaleLowerCase("en-US") === rightRuntime.toLocaleLowerCase("en-US")
      : leftRuntime === rightRuntime
  } catch { return false }
}

/** Builds a read-only, one-way mirror plan for either Host direction. The plan never follows links. */
export async function planMirrorSync(input: MirrorSyncConfig): Promise<MirrorSyncPlan> {
  const sync = normalizedConfig(input)
  const patterns = effectiveExcludes(sync)
  const operations: MirrorSyncOperation[] = []
  const issues: string[] = []
  if (sameRuntimePath(sync.source, sync.mirror)) return emptyPlan(sync, operations, ["源 Vault 和镜像 Vault 不能指向同一实际目录"], "源和镜像路径相同；不会执行任何文件写入。")

  const source = await scanHostTree(sync.source, patterns)
  if (source.root !== "directory") {
    issues.push(...source.issues, source.root === "missing" ? `${hostLabel(sync.source.host)} 源 Vault 不存在` : `${hostLabel(sync.source.host)} 源 Vault 不是目录或不可扫描`)
    return emptyPlan(sync, operations, issues, "源 Vault 未通过读取检查；不会执行任何文件写入。")
  }
  issues.push(...source.issues)
  const mirror = await scanHostTree(sync.mirror, patterns)
  issues.push(...mirror.issues)
  if (mirror.root === "other") issues.push(`${hostLabel(sync.mirror.host)} 镜像 Vault 不是目录或不可扫描`)
  if (issues.length) return emptyPlan(sync, operations, issues, "扫描不完整；不会执行任何文件写入。")

  const sourceTree = sourceEntries(source, sync, patterns, operations)
  addRequiredParents(sourceTree.entries, sync)
  if (mirror.root === "missing") addOperation(operations, "create-directory", "", sync.mirror.path, `创建 ${hostLabel(sync.mirror.host)} 镜像 Vault 根目录`)

  for (const entry of [...sourceTree.entries.values()].sort(function (left, right): number { return depth(left.relativePath) - depth(right.relativePath) || left.relativePath.localeCompare(right.relativePath) })) {
    const destination = mirror.entries.get(entry.relativePath)
    const mirrorPath = hostPath(sync.mirror, entry.relativePath)
    if (entry.kind === "directory") {
      if (!destination) addOperation(operations, "create-directory", entry.relativePath, mirrorPath, `${hostLabel(sync.mirror.host)} 镜像中缺少目录`, entry.path)
      else if (destination.kind !== "directory") addOperation(operations, "skip", entry.relativePath, mirrorPath, "镜像目标类型冲突；不会覆盖链接或文件", entry.path)
      continue
    }
    if (!destination) addOperation(operations, "copy-file", entry.relativePath, mirrorPath, `${hostLabel(sync.mirror.host)} 镜像中缺少文件`, entry.path)
    else if (destination.kind !== "file") addOperation(operations, "skip", entry.relativePath, mirrorPath, "镜像目标类型冲突；不会覆盖链接或目录", entry.path)
    else if (destination.size !== entry.size || Math.abs((destination.modifiedMs ?? 0) - (entry.modifiedMs ?? 0)) > 1) addOperation(operations, "copy-file", entry.relativePath, mirrorPath, "文件内容或修改时间已变化", entry.path)
  }

  for (const entry of [...mirror.entries.values()].sort(function (left, right): number { return depth(right.relativePath) - depth(left.relativePath) || right.relativePath.localeCompare(left.relativePath) })) {
    if (!selected(entry.relativePath, sync) || sourceTree.entries.has(entry.relativePath) || protectedPath(entry.relativePath, sourceTree.protectedPaths)) continue
    if (entry.kind === "file") addOperation(operations, "delete-file", entry.relativePath, entry.path, `${hostLabel(sync.source.host)} 源中已删除`)
    else if (entry.kind === "directory") addOperation(operations, "delete-directory", entry.relativePath, entry.path, `${hostLabel(sync.source.host)} 源中已删除`)
    else addOperation(operations, "skip", entry.relativePath, entry.path, "镜像目标是链接或特殊文件；不会删除")
  }

  return { schemaVersion: 1, mode: "preview-only", sync, ready: true, operations, issues: [], summary: summary(operations), safety: { filesystemWrites: "disabled", source: "read-only", note: `确认前只读取 ${hostLabel(sync.source.host)} 源与 ${hostLabel(sync.mirror.host)} 镜像；执行时只写入受管镜像路径。` } }
}

function expectedMirrorPath(sync: MirrorSyncConfig, relativePath: string): string { return relativePath ? hostPath(sync.mirror, normalRelativePath(relativePath, "operation.relativePath")) : sync.mirror.path }
function expectedSourcePath(sync: MirrorSyncConfig, relativePath: string): string { return hostPath(sync.source, normalRelativePath(relativePath, "operation.relativePath")) }

function validateOperation(plan: MirrorSyncPlan, operation: MirrorSyncOperation): void {
  if (operation.mirrorPath !== expectedMirrorPath(plan.sync, operation.relativePath)) throw new Error(`同步计划包含不安全的目标路径：${operation.mirrorPath}`)
  if (operation.sourcePath && operation.sourcePath !== expectedSourcePath(plan.sync, operation.relativePath)) throw new Error(`同步计划包含不安全的源路径：${operation.sourcePath}`)
}

async function copyAtomically(source: VaultConfig, sourcePath: string, mirror: VaultConfig, mirrorPath: string, modifiedMs: number | undefined): Promise<void> {
  const sourceRuntime = runtimePath(source, sourcePath)
  const mirrorRuntime = runtimePath(mirror, mirrorPath)
  await mkdir(nodePath.dirname(mirrorRuntime), { recursive: true })
  const temporary = `${mirrorRuntime}.skills-manager-copy-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await copyFile(sourceRuntime, temporary)
    if (modifiedMs !== undefined) await utimes(temporary, modifiedMs / 1000, modifiedMs / 1000)
    await rename(temporary, mirrorRuntime)
  } finally { await unlink(temporary).catch(function (): undefined { return undefined }) }
}

function executionOrder(operations: MirrorSyncOperation[]): MirrorSyncOperation[] {
  const rank: Record<MirrorSyncOperation["action"], number> = { "create-directory": 0, "copy-file": 1, "delete-file": 2, "delete-directory": 3, skip: 4 }
  return [...operations].sort(function (left, right): number {
    const byAction = rank[left.action] - rank[right.action]
    if (byAction) return byAction
    return left.action === "delete-file" || left.action === "delete-directory" ? depth(right.relativePath) - depth(left.relativePath) : depth(left.relativePath) - depth(right.relativePath)
  })
}

/** Executes a plan produced by planMirrorSync. Source files are never changed. */
export async function executeMirrorSync(plan: MirrorSyncPlan): Promise<MirrorSyncExecution> {
  if (!plan.ready) throw new Error("mirror sync plan is not ready")
  const sync = normalizedConfig(plan.sync)
  const results: MirrorSyncExecution["results"] = []
  const status = new Map<string, MirrorSyncOperation["execution"]>()
  for (const operation of executionOrder(plan.operations)) {
    try {
      validateOperation({ ...plan, sync }, operation)
      const mirrorRuntime = runtimePath(sync.mirror, operation.mirrorPath)
      if (operation.action === "skip") {
        results.push({ id: operation.id, success: true, attempted: false, message: operation.reason }); status.set(operation.id, "skipped"); continue
      }
      if (operation.action === "create-directory") await mkdir(mirrorRuntime, { recursive: true })
      else if (operation.action === "copy-file") {
        const source = operation.sourcePath
        const sourceInfo = source ? await stat(runtimePath(sync.source, source)) : undefined
        await copyAtomically(sync.source, source ?? "", sync.mirror, operation.mirrorPath, sourceInfo ? Math.round(sourceInfo.mtimeMs) : undefined)
      } else if (operation.action === "delete-file") await rm(mirrorRuntime, { force: true })
      else if (operation.action === "delete-directory") await rm(mirrorRuntime, { recursive: false, force: true })
      results.push({ id: operation.id, success: true, attempted: true, message: "已完成" }); status.set(operation.id, "completed")
    } catch (error) {
      results.push({ id: operation.id, success: false, attempted: true, message: "失败", error: errorText(error) }); status.set(operation.id, "failed")
    }
  }
  const executed: MirrorSyncPlan = { ...plan, mode: "execution", operations: plan.operations.map(function (operation): MirrorSyncOperation { return { ...operation, execution: status.get(operation.id) ?? "not-run" } }), safety: { ...plan.safety, filesystemWrites: "enabled", note: `已执行确认的单向同步；${hostLabel(sync.source.host)} 源未修改。` } }
  return { schemaVersion: 1, plan: executed, results }
}
