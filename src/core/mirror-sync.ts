import { copyFile, lstat, mkdir, readdir, rename, rm, stat, unlink, utimes } from "node:fs/promises"
import nodePath from "node:path"
import { assertSafeWindowsPath, assertSafeWslPath } from "./link-plan.ts"
import { windowsPathToWsl } from "./host.ts"
import { scanWindowsDirectory, type WindowsDirectoryEntry } from "./windows-scan.ts"
import type { MirrorSyncConfig, MirrorSyncExecution, MirrorSyncOperation, MirrorSyncPlan } from "./types.ts"

export const DEFAULT_MIRROR_EXCLUDE = ["node_modules/**", ".git/**", ".DS_Store", "Thumbs.db", "*.log", "*:Zone.Identifier"]
const MAX_MIRROR_ENTRIES = 100_000

type SourceEntry = { relativePath: string; path: string; kind: "file" | "directory"; size?: number; modifiedMs?: number }
type MirrorEntry = { relativePath: string; path: string; kind: "file" | "directory" | "link" | "other"; size?: number; modifiedMs?: number }
type MirrorTree = { root: "missing" | "directory" | "other"; entries: Map<string, MirrorEntry>; issues: string[] }

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function normalRelativePath(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/").replace(/\/$/u, "")
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) || normalized.split("/").some(function (part): boolean { return !part || part === "." || part === ".." })) {
    throw new Error(`${label} must be a safe relative path`)
  }
  return normalized
}

function normalizedConfig(input: MirrorSyncConfig): MirrorSyncConfig {
  assertSafeWindowsPath(input.source.path, "mirrorSync.source.path")
  assertSafeWslPath(input.mirror.path, "mirrorSync.mirror.path")
  if (input.source.host !== "windows" || input.mirror.host !== "wsl") throw new Error("mirror sync requires a Windows source and WSL mirror")
  const selectedPaths = (input.selectedPaths ?? []).map(function (path): string { return normalRelativePath(path, "mirrorSync.selectedPaths") })
  if (new Set(selectedPaths).size !== selectedPaths.length) throw new Error("mirrorSync.selectedPaths contains duplicates")
  if (input.scope === "selected" && !selectedPaths.length) throw new Error("mirrorSync.selectedPaths is required for selected scope")
  if (input.scope !== "full" && input.scope !== "selected") throw new Error("mirrorSync.scope must be full or selected")
  const exclude = input.exclude === undefined ? undefined : input.exclude.map(function (pattern): string {
    if (!pattern.trim() || pattern.includes("\0") || pattern.startsWith("!")) throw new Error("mirrorSync.exclude only accepts non-empty positive patterns")
    return pattern.replaceAll("\\", "/").replace(/^\.\//u, "")
  })
  return {
    source: { host: "windows", path: nodePath.win32.normalize(input.source.path) },
    mirror: { host: "wsl", path: nodePath.posix.normalize(input.mirror.path) },
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

function relativeWindowsPath(root: string, path: string): string {
  const relative = nodePath.win32.relative(root, path).replaceAll("\\", "/")
  return normalRelativePath(relative, "Windows scan result")
}

function under(root: string, path: string): boolean { return path === root || path.startsWith(`${root}/`) }
function selected(relativePath: string, sync: MirrorSyncConfig): boolean {
  return sync.scope === "full" || (sync.selectedPaths ?? []).some(function (root): boolean { return under(root, relativePath) })
}

function joinWindows(root: string, relativePath: string): string { return relativePath ? nodePath.win32.join(root, ...relativePath.split("/")) : root }
function joinWsl(root: string, relativePath: string): string { return relativePath ? nodePath.posix.join(root, ...relativePath.split("/")) : root }
function depth(value: string): number { return value ? value.split("/").length : 0 }

function addOperation(operations: MirrorSyncOperation[], action: MirrorSyncOperation["action"], relativePath: string, mirrorPath: string, reason: string, sourcePath?: string): void {
  operations.push({ id: `${action}:${relativePath || "."}`, relativePath, action, mirrorPath, reason, ...(sourcePath ? { sourcePath } : {}), execution: "not-run" })
}

function summary(operations: MirrorSyncOperation[]): MirrorSyncPlan["summary"] {
  return { "create-directory": operations.filter(function (item): boolean { return item.action === "create-directory" }).length, "copy-file": operations.filter(function (item): boolean { return item.action === "copy-file" }).length, "delete-file": operations.filter(function (item): boolean { return item.action === "delete-file" }).length, "delete-directory": operations.filter(function (item): boolean { return item.action === "delete-directory" }).length, skip: operations.filter(function (item): boolean { return item.action === "skip" }).length }
}

async function scanMirrorTree(root: string, patterns: string[]): Promise<MirrorTree> {
  const rootInfo = await lstat(root).catch(function (error: unknown): undefined { return undefined })
  if (!rootInfo) return { root: "missing", entries: new Map(), issues: [] }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return { root: "other", entries: new Map(), issues: ["WSL 镜像根目录必须是普通目录，不能是链接或文件"] }
  const entries = new Map<string, MirrorEntry>()
  const issues: string[] = []
  const queue = [""]
  while (queue.length) {
    const relativeDirectory = queue.shift()!
    const directory = joinWsl(root, relativeDirectory)
    let children: string[]
    try { children = await readdir(directory) } catch (error) { issues.push(`无法读取 WSL 镜像目录 ${directory}: ${errorText(error)}`); continue }
    for (const child of children) {
      if (entries.size >= MAX_MIRROR_ENTRIES) { issues.push(`WSL 镜像条目超过 ${MAX_MIRROR_ENTRIES} 个，已停止扫描`); return { root: "directory", entries, issues } }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child}` : child
      if (excluded(relativePath, patterns)) continue
      const path = joinWsl(root, relativePath)
      const info = await lstat(path).catch(function (error: unknown): undefined { issues.push(`无法读取 WSL 镜像条目 ${path}: ${errorText(error)}`); return undefined })
      if (!info) continue
      const kind: MirrorEntry["kind"] = info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other"
      entries.set(relativePath, { relativePath, path, kind, ...(kind === "file" ? { size: info.size, modifiedMs: Math.round(info.mtimeMs) } : {}) })
      if (kind === "directory") queue.push(relativePath)
    }
  }
  return { root: "directory", entries, issues }
}

function runtimeSourcePath(path: string): string {
  const converted = windowsPathToWsl(path)
  if (!converted) throw new Error("Windows source must use a drive path accessible from WSL")
  return converted
}

function sourceEntries(scanEntries: WindowsDirectoryEntry[], sync: MirrorSyncConfig, patterns: string[], operations: MirrorSyncOperation[]): { entries: Map<string, SourceEntry>; protectedPaths: string[] } {
  const entries = new Map<string, SourceEntry>()
  const protectedPaths: string[] = []
  for (const item of scanEntries) {
    const relativePath = relativeWindowsPath(sync.source.path, item.path)
    if (!selected(relativePath, sync) || excluded(relativePath, patterns)) continue
    const mirrorPath = joinWsl(sync.mirror.path, relativePath)
    if (item.isReparsePoint) {
      protectedPaths.push(relativePath)
      addOperation(operations, "skip", relativePath, mirrorPath, "源路径是链接或 Junction；未跟随，也未复制")
      continue
    }
    if (!item.isDirectory && item.size === undefined) {
      protectedPaths.push(relativePath)
      addOperation(operations, "skip", relativePath, mirrorPath, "源路径不是普通文件或目录；未复制")
      continue
    }
    entries.set(relativePath, { relativePath, path: item.path, kind: item.isDirectory ? "directory" : "file", ...(item.isDirectory ? {} : { size: item.size, modifiedMs: item.modifiedMs }) })
  }
  return { entries, protectedPaths }
}

function addRequiredParents(entries: Map<string, SourceEntry>, sync: MirrorSyncConfig): void {
  const all = [...entries.values()]
  for (const entry of all) {
    for (let index = 1; index <= depth(entry.relativePath); index += 1) {
      const relativePath = entry.relativePath.split("/").slice(0, index).join("/")
      if (!entries.has(relativePath)) entries.set(relativePath, { relativePath, path: joinWindows(sync.source.path, relativePath), kind: "directory" })
    }
  }
}

function protectedPath(relativePath: string, paths: string[]): boolean { return paths.some(function (path): boolean { return under(path, relativePath) || under(relativePath, path) }) }

/** Builds a read-only, Windows-to-WSL mirror plan. The plan never follows links. */
export async function planMirrorSync(input: MirrorSyncConfig): Promise<MirrorSyncPlan> {
  const sync = normalizedConfig(input)
  const patterns = effectiveExcludes(sync)
  const operations: MirrorSyncOperation[] = []
  const issues: string[] = []
  const source = await scanWindowsDirectory({ path: sync.source.path, recursive: true, maxEntries: MAX_MIRROR_ENTRIES, skipDirectoryNames: skippedDirectoryNames(patterns), skipTopLevelDotDirectories: false })
  if (!source.supported || !source.rootExists || !source.rootIsDirectory) {
    issues.push(...source.issues, !source.rootExists ? "Windows 源 Vault 不存在" : !source.rootIsDirectory ? "Windows 源 Vault 不是目录" : "Windows 源 Vault 不可扫描")
    return { schemaVersion: 1, mode: "preview-only", sync, ready: false, operations, issues: [...new Set(issues)], summary: summary(operations), safety: { filesystemWrites: "disabled", source: "read-only", note: "源 Vault 未通过读取检查；不会执行任何文件写入。" } }
  }
  if (source.issues.length) issues.push(...source.issues)
  const mirror = await scanMirrorTree(sync.mirror.path, patterns)
  if (mirror.root === "other") issues.push(...mirror.issues)
  else issues.push(...mirror.issues)
  if (issues.length) return { schemaVersion: 1, mode: "preview-only", sync, ready: false, operations, issues: [...new Set(issues)], summary: summary(operations), safety: { filesystemWrites: "disabled", source: "read-only", note: "扫描不完整；不会执行任何文件写入。" } }

  const sourceTree = sourceEntries(source.entries, sync, patterns, operations)
  addRequiredParents(sourceTree.entries, sync)
  if (mirror.root === "missing") addOperation(operations, "create-directory", "", sync.mirror.path, "创建 WSL 镜像根目录")

  for (const entry of [...sourceTree.entries.values()].sort(function (left, right): number { return depth(left.relativePath) - depth(right.relativePath) || left.relativePath.localeCompare(right.relativePath) })) {
    const destination = mirror.entries.get(entry.relativePath)
    const mirrorPath = joinWsl(sync.mirror.path, entry.relativePath)
    if (entry.kind === "directory") {
      if (!destination) addOperation(operations, "create-directory", entry.relativePath, mirrorPath, "WSL 镜像中缺少目录", entry.path)
      else if (destination.kind !== "directory") addOperation(operations, "skip", entry.relativePath, mirrorPath, "WSL 目标类型冲突；不会覆盖链接或文件", entry.path)
      continue
    }
    if (!destination) addOperation(operations, "copy-file", entry.relativePath, mirrorPath, "WSL 镜像中缺少文件", entry.path)
    else if (destination.kind !== "file") addOperation(operations, "skip", entry.relativePath, mirrorPath, "WSL 目标类型冲突；不会覆盖链接或目录", entry.path)
    else if (destination.size !== entry.size || Math.abs((destination.modifiedMs ?? 0) - (entry.modifiedMs ?? 0)) > 1) addOperation(operations, "copy-file", entry.relativePath, mirrorPath, "文件内容或修改时间已变化", entry.path)
  }

  for (const entry of [...mirror.entries.values()].sort(function (left, right): number { return depth(right.relativePath) - depth(left.relativePath) || right.relativePath.localeCompare(left.relativePath) })) {
    if (!selected(entry.relativePath, sync) || sourceTree.entries.has(entry.relativePath) || protectedPath(entry.relativePath, sourceTree.protectedPaths)) continue
    if (entry.kind === "file") addOperation(operations, "delete-file", entry.relativePath, entry.path, "Windows 源中已删除")
    else if (entry.kind === "directory") addOperation(operations, "delete-directory", entry.relativePath, entry.path, "Windows 源中已删除")
    else addOperation(operations, "skip", entry.relativePath, entry.path, "WSL 目标是链接或特殊文件；不会删除")
  }

  return { schemaVersion: 1, mode: "preview-only", sync, ready: true, operations, issues: [], summary: summary(operations), safety: { filesystemWrites: "disabled", source: "read-only", note: "确认前只读取 Windows 源与 WSL 镜像；执行时只写入受管 WSL 路径。" } }
}

function expectedMirrorPath(sync: MirrorSyncConfig, relativePath: string): string { return relativePath ? joinWsl(sync.mirror.path, normalRelativePath(relativePath, "operation.relativePath")) : sync.mirror.path }
function expectedSourcePath(sync: MirrorSyncConfig, relativePath: string): string { return joinWindows(sync.source.path, normalRelativePath(relativePath, "operation.relativePath")) }

function validateOperation(plan: MirrorSyncPlan, operation: MirrorSyncOperation): void {
  if (operation.mirrorPath !== expectedMirrorPath(plan.sync, operation.relativePath)) throw new Error(`同步计划包含不安全的目标路径：${operation.mirrorPath}`)
  if (operation.sourcePath && operation.sourcePath !== expectedSourcePath(plan.sync, operation.relativePath)) throw new Error(`同步计划包含不安全的源路径：${operation.sourcePath}`)
}

async function copyAtomically(sourcePath: string, mirrorPath: string, modifiedMs: number | undefined): Promise<void> {
  await mkdir(nodePath.posix.dirname(mirrorPath), { recursive: true })
  const temporary = `${mirrorPath}.skills-manager-copy-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await copyFile(runtimeSourcePath(sourcePath), temporary)
    if (modifiedMs !== undefined) await utimes(temporary, modifiedMs / 1000, modifiedMs / 1000)
    await rename(temporary, mirrorPath)
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
      if (operation.action === "skip") {
        results.push({ id: operation.id, success: true, attempted: false, message: operation.reason }); status.set(operation.id, "skipped"); continue
      }
      if (operation.action === "create-directory") await mkdir(operation.mirrorPath, { recursive: true })
      else if (operation.action === "copy-file") {
        const source = plan.operations.find(function (item): boolean { return item.id === operation.id })?.sourcePath
        const sourceInfo = source ? await stat(runtimeSourcePath(source)) : undefined
        await copyAtomically(source ?? "", operation.mirrorPath, sourceInfo ? Math.round(sourceInfo.mtimeMs) : undefined)
      } else if (operation.action === "delete-file") await rm(operation.mirrorPath, { force: true })
      else if (operation.action === "delete-directory") await rm(operation.mirrorPath, { recursive: false, force: true })
      results.push({ id: operation.id, success: true, attempted: true, message: "已完成" }); status.set(operation.id, "completed")
    } catch (error) {
      results.push({ id: operation.id, success: false, attempted: true, message: "失败", error: errorText(error) }); status.set(operation.id, "failed")
    }
  }
  const executed: MirrorSyncPlan = { ...plan, mode: "execution", operations: plan.operations.map(function (operation): MirrorSyncOperation { return { ...operation, execution: status.get(operation.id) ?? "not-run" } }), safety: { ...plan.safety, filesystemWrites: "enabled", note: "已执行确认的单向同步；Windows 源未修改。" } }
  return { schemaVersion: 1, plan: executed, results }
}
