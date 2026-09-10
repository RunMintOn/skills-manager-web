import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, lstat, readlink, readdir, realpath, rename, rm, stat, symlink, unlink } from "node:fs/promises"
import nodePath from "node:path"
import { appendSafeChild, getHostPathAdapter, isInside, windowsPathToWsl, wslPathToWindows, type HostPathAdapter } from "./host.ts"
import { assertSafeMacosPath, assertSafeWindowsPath, assertSafeWslPath } from "./link-plan.ts"
import { scanWindowsDirectory } from "./windows-scan.ts"
import type {
  BatchLinkItem,
  BatchLinkPreflight,
  BatchLinkSpec,
  HostKind,
  LinkDeletePreflight,
  LinkEntry,
  LinkEntryKind,
  LinkExecutionResult,
  LinkOperationPlan,
  LinkPreflight,
  LinkScan,
  LinkSpec,
  LinkStrategy,
  LinkTargetKind,
} from "./types.ts"

type RuntimeStat = Awaited<ReturnType<typeof lstat>>
type RuntimePaths = { target: string; link: string }
type WindowsApi = "fs.promises.symlink" | "powershell.exe"

const MAX_SCAN_ENTRIES = 10_000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function adapterFor(host: HostKind): HostPathAdapter {
  return getHostPathAdapter(host)
}

function normalizePath(host: HostKind, value: string): string {
  if (host === "wsl") {
    assertSafeWslPath(value, "path")
  } else if (host === "macos") {
    assertSafeMacosPath(value, "path")
  } else {
    assertSafeWindowsPath(value, "path")
  }
  return adapterFor(host).normalize(value)
}

function runtimePath(host: HostKind, value: string): string {
  if (host === "macos") {
    if (process.platform !== "darwin") throw new Error("macOS paths are unavailable on this runtime")
    return value
  }
  if (host === "wsl") {
    if (process.platform === "win32") {
      throw new Error("WSL paths are unavailable from a native Windows runtime")
    }
    return value
  }
  if (process.platform === "win32") return value
  const mounted = windowsPathToWsl(value)
  if (!mounted) {
    throw new Error("Windows UNC paths are unavailable from this WSL runtime; use a drive path such as C:\\...")
  }
  return mounted
}

function commandPath(host: HostKind, value: string): string {
  if (host === "wsl") return value
  const mounted = windowsPathToWsl(value)
  if (!mounted) throw new Error("Windows path cannot be converted to a WSL path")
  return mounted
}

function resolveRuntimePaths(spec: LinkSpec): RuntimePaths {
  return {
    target: runtimePath(spec.targetHost, spec.targetPath),
    link: runtimePath(spec.linkHost, spec.linkPath),
  }
}

function targetKind(value: RuntimeStat): LinkTargetKind | undefined {
  if (value.isDirectory()) return "directory"
  if (value.isFile()) return "file"
  return undefined
}

function sameRuntimePath(left: string, right: string): boolean {
  const normalizedLeft = nodePath.resolve(left)
  const normalizedRight = nodePath.resolve(right)
  if (process.platform === "win32") {
    return normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
  }
  return normalizedLeft === normalizedRight
}

function strategyFor(targetHost: HostKind, linkHost: HostKind, kind: LinkTargetKind): LinkStrategy {
  if (targetHost === "windows" && linkHost === "windows") {
    return kind === "directory" ? "windows-junction" : "windows-symlink"
  }
  if (targetHost === "wsl" && linkHost === "wsl") return "wsl-symlink"
  if (targetHost === "macos" && linkHost === "macos") return "macos-symlink"
  if (targetHost === "wsl" && linkHost === "windows") return "wsl-to-windows-symlink"
  return "windows-to-wsl-symlink"
}

function windowsApi(): WindowsApi {
  return process.platform === "win32" ? "fs.promises.symlink" : "powershell.exe"
}

function buildOperation(spec: LinkSpec, strategy: LinkStrategy, kind: LinkTargetKind): LinkOperationPlan {
  if (strategy === "windows-junction") {
    return {
      kind: "windows-junction",
      host: "windows",
      api: windowsApi(),
      fsArgs: [spec.targetPath, spec.linkPath, "junction"],
      targetPath: spec.targetPath,
      linkPath: spec.linkPath,
      directoryOnly: true,
    }
  }
  if (strategy === "windows-symlink") {
    return {
      kind: "windows-symlink",
      host: "windows",
      api: windowsApi(),
      fsArgs: [spec.targetPath, spec.linkPath, kind === "directory" ? "dir" : "file"],
      targetPath: spec.targetPath,
      linkPath: spec.linkPath,
      directoryOnly: kind === "directory",
    }
  }
  if (strategy === "macos-symlink") {
    return {
      kind: "macos-symlink",
      host: "macos",
      api: "fs.promises.symlink",
      fsArgs: [spec.targetPath, spec.linkPath, kind === "directory" ? "dir" : "file"],
      targetPath: spec.targetPath,
      linkPath: spec.linkPath,
      directoryOnly: kind === "directory",
    }
  }
  const target = commandPath(spec.targetHost, spec.targetPath)
  const link = commandPath(spec.linkHost, spec.linkPath)
  return {
    kind: "wsl-command",
    host: "wsl",
    executable: "wsl.exe",
    args: ["--exec", "ln", "-s", "--", target, link],
    shell: false,
    targetPath: spec.targetPath,
    linkPath: spec.linkPath,
    directoryOnly: kind === "directory",
  }
}

function initialPreflight(spec: LinkSpec): LinkPreflight {
  return {
    schemaVersion: 1,
    spec,
    ready: false,
    target: { path: spec.targetPath, exists: false },
    link: { path: spec.linkPath, exists: false },
    parent: { path: "", exists: false, directory: false },
    risks: [],
  }
}

function addRisk(result: LinkPreflight, message: string): void {
  if (!result.risks.includes(message)) result.risks.push(message)
}

function normalizeSpec(input: LinkSpec): LinkSpec {
  return {
    targetHost: input.targetHost,
    targetPath: normalizePath(input.targetHost, input.targetPath),
    linkHost: input.linkHost,
    linkPath: normalizePath(input.linkHost, input.linkPath),
  }
}

function logicalParentPath(host: HostKind, path: string): string {
  return host === "windows" ? nodePath.win32.dirname(path) : nodePath.posix.dirname(path)
}

function setParentPath(result: LinkPreflight, spec: LinkSpec, runtimeParent: string): void {
  const logicalParent = logicalParentPath(spec.linkHost, spec.linkPath)
  if (spec.linkHost === "windows" && process.platform !== "win32") {
    result.parent.path = wslPathToWindows(runtimeParent) ?? logicalParent
    return
  }
  result.parent.path = logicalParent
}

async function classifyRuntimeEntry(host: HostKind, path: string, info: RuntimeStat): Promise<LinkEntryKind> {
  if (info.isSymbolicLink()) {
    const target = await realpath(path).catch(function (): undefined { return undefined })
    if (host === "windows" && target) {
      const targetInfo = await stat(target).catch(function (): undefined { return undefined })
      return targetInfo?.isDirectory() ? "windows-junction" : "windows-symlink"
    }
    if (host === "wsl") return "wsl-symlink"
    if (host === "macos") return "macos-symlink"
    return "windows-symlink"
  }
  if (info.isDirectory()) return "directory"
  if (info.isFile()) return "file"
  return "other"
}

async function resolvedDisplayPath(host: HostKind, path: string): Promise<string | undefined> {
  const resolved = await realpath(path).catch(function (): undefined { return undefined })
  if (!resolved) return undefined
  if (host === "windows" && process.platform !== "win32") return wslPathToWindows(resolved) ?? resolved
  return resolved
}

async function addParentRisks(result: LinkPreflight, parentRuntime: string): Promise<void> {
  const parentInfo = await stat(parentRuntime).catch(function (error: unknown): undefined {
    result.parent.error = errorText(error)
    return undefined
  })
  result.parent.exists = Boolean(parentInfo)
  result.parent.directory = Boolean(parentInfo?.isDirectory())
  if (!result.parent.exists) {
    addRisk(result, `链接路径的父目录不存在：${result.parent.path}`)
    return
  }
  if (!result.parent.directory) {
    addRisk(result, `链接路径的父路径不是目录：${result.parent.path}`)
    return
  }
  const writable = await access(parentRuntime, constants.W_OK).then(function (): boolean { return true }).catch(function (): boolean { return false })
  if (!writable) addRisk(result, `链接路径的父目录不可写：${result.parent.path}`)
}

function addPathRisks(result: LinkPreflight, spec: LinkSpec, paths: RuntimePaths, targetInfo: RuntimeStat | undefined): void {
  if (targetInfo && result.target.kind && sameRuntimePath(paths.target, paths.link)) {
    addRisk(result, "目标路径和链接路径不能相同")
  }
  if (!targetInfo?.isDirectory() || spec.targetHost !== spec.linkHost) return
  const adapter = adapterFor(spec.targetHost)
  if (isInside(adapter, adapter.normalize(spec.targetPath), adapter.normalize(spec.linkPath))) {
    addRisk(result, "链接路径不能位于目标目录内部")
  }
}

export async function preflightLink(input: LinkSpec): Promise<LinkPreflight> {
  let spec: LinkSpec
  try {
    spec = normalizeSpec(input)
  } catch (error) {
    const result = initialPreflight({ ...input })
    addRisk(result, errorText(error))
    return result
  }

  const result = initialPreflight(spec)
  if (spec.targetHost !== spec.linkHost) {
    addRisk(result, "连接操作暂时只支持同一环境：目标和链接必须使用相同 Host")
    return result
  }
  let paths: RuntimePaths
  try {
    paths = resolveRuntimePaths(spec)
  } catch (error) {
    addRisk(result, errorText(error))
    return result
  }

  const parentRuntime = nodePath.dirname(paths.link)
  setParentPath(result, spec, parentRuntime)

  const targetInfo = await stat(paths.target).catch(function (error: unknown): undefined {
    result.target.error = errorText(error)
    return undefined
  })
  if (!targetInfo) {
    addRisk(result, `目标路径不存在或无法读取：${spec.targetPath}`)
  } else {
    result.target.exists = true
    result.target.kind = targetKind(targetInfo)
    if (!result.target.kind) addRisk(result, `目标路径不是文件或目录：${spec.targetPath}`)
  }

  const linkInfo = await lstat(paths.link).catch(function (): undefined { return undefined })
  if (linkInfo) {
    result.link.exists = true
    result.link.kind = await classifyRuntimeEntry(spec.linkHost, paths.link, linkInfo)
    result.link.targetPath = await resolvedDisplayPath(spec.linkHost, paths.link)
    addRisk(result, `链接路径已经存在：${spec.linkPath}`)
  }

  await addParentRisks(result, parentRuntime)
  addPathRisks(result, spec, paths, targetInfo)

  if (targetInfo && result.target.kind && result.risks.length === 0) {
    result.strategy = strategyFor(spec.targetHost, spec.linkHost, result.target.kind)
    try {
      result.operation = buildOperation(spec, result.strategy, result.target.kind)
    } catch (error) {
      addRisk(result, errorText(error))
    }
  }
  result.ready = Boolean(
    result.target.exists &&
    result.target.kind &&
    !result.link.exists &&
    result.parent.exists &&
    result.parent.directory &&
    result.operation &&
    result.risks.length === 0,
  )
  return result
}

export async function preflightBatchLinks(input: BatchLinkSpec): Promise<BatchLinkPreflight> {
  const failed = (spec: BatchLinkSpec, message: string): BatchLinkPreflight => ({ schemaVersion: 1, spec, ready: false, items: [], risks: [message] })
  if (input.targetHost !== input.linkHost) return failed(input, "连接操作暂时只支持同一环境：目标和链接必须使用相同 Host")

  let spec: BatchLinkSpec
  try {
    spec = {
      ...input,
      targetPath: normalizePath(input.targetHost, input.targetPath),
      linkPath: normalizePath(input.linkHost, input.linkPath),
    }
  } catch (error) {
    return failed(input, errorText(error))
  }

  let targetRuntime: string
  let linkRuntime: string
  try {
    targetRuntime = runtimePath(spec.targetHost, spec.targetPath)
    linkRuntime = runtimePath(spec.linkHost, spec.linkPath)
  } catch (error) {
    return failed(spec, errorText(error))
  }
  if (sameRuntimePath(targetRuntime, linkRuntime)) return failed(spec, "源文件夹和目标文件夹不能相同")

  const targetInfo = await lstat(targetRuntime).catch(function (): undefined { return undefined })
  if (!targetInfo) return failed(spec, `源文件夹不存在或无法读取：${spec.targetPath}`)
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) return failed(spec, `源路径不是普通目录：${spec.targetPath}`)

  const linkInfo = await lstat(linkRuntime).catch(function (): undefined { return undefined })
  if (!linkInfo) return failed(spec, `目标文件夹不存在或无法读取：${spec.linkPath}`)
  if (!linkInfo.isDirectory() || linkInfo.isSymbolicLink()) return failed(spec, `目标路径不是普通目录：${spec.linkPath}`)

  const children = await readdir(targetRuntime, { withFileTypes: true }).catch(function (error: unknown): import("node:fs").Dirent[] {
    throw new Error(`无法读取源文件夹：${errorText(error)}`)
  })
  children.sort(function (left, right): number { return left.name.localeCompare(right.name) })
  const items: BatchLinkItem[] = []
  for (const child of children) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue
    const childRuntime = nodePath.join(targetRuntime, child.name)
    const skillInfo = await lstat(nodePath.join(childRuntime, "SKILL.md")).catch(function (): undefined { return undefined })
    if (!skillInfo?.isFile()) continue
    const item = await preflightLink({
      targetHost: spec.targetHost,
      targetPath: adapterFor(spec.targetHost).join(spec.targetPath, child.name),
      linkHost: spec.linkHost,
      linkPath: adapterFor(spec.linkHost).join(spec.linkPath, child.name),
    })
    items.push({ name: child.name, preflight: item })
  }

  const risks = items.length ? [] : ["源文件夹下没有直接包含 SKILL.md 的子目录"]
  return { schemaVersion: 1, spec, ready: items.some(function (item): boolean { return item.preflight.ready }), items, risks }
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64")
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise(function (resolve, reject): void {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr?.on("data", function (chunk: Buffer): void { stderr += chunk.toString() })
    child.once("error", reject)
    child.once("close", function (code: number | null): void {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`))
    })
  })
}

function windowsLinkType(strategy: "windows-junction" | "windows-symlink", kind: LinkTargetKind): "junction" | "dir" | "file" {
  if (strategy === "windows-junction") return "junction"
  return kind === "directory" ? "dir" : "file"
}

async function executeWindowsOperation(spec: LinkSpec, strategy: "windows-junction" | "windows-symlink", kind: LinkTargetKind): Promise<void> {
  if (process.platform === "win32") {
    const type = windowsLinkType(strategy, kind)
    await symlink(spec.targetPath, spec.linkPath, type)
    return
  }
  const itemType = strategy === "windows-junction" ? "Junction" : "SymbolicLink"
  const script = `$ErrorActionPreference = 'Stop'; New-Item -ItemType ${itemType} -Path ${quotePowerShell(spec.linkPath)} -Target ${quotePowerShell(spec.targetPath)} | Out-Null`
  await runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script)])
}

async function executeMacosOperation(spec: LinkSpec, kind: LinkTargetKind): Promise<void> {
  const paths = resolveRuntimePaths(spec)
  await symlink(paths.target, paths.link, kind === "directory" ? "dir" : "file")
}

async function executeWslOperation(spec: LinkSpec): Promise<void> {
  const paths = resolveRuntimePaths(spec)
  if (process.platform !== "win32") {
    await symlink(paths.target, paths.link)
    return
  }
  await runProcess("wsl.exe", [
    "--exec",
    "ln",
    "-s",
    "--",
    commandPath(spec.targetHost, spec.targetPath),
    commandPath(spec.linkHost, spec.linkPath),
  ])
}

export async function executeLink(input: LinkSpec): Promise<LinkExecutionResult> {
  const preflight = await preflightLink(input)
  if (!preflight.ready || !preflight.strategy || !preflight.target.kind) {
    return {
      schemaVersion: 1,
      attempted: false,
      success: false,
      spec: preflight.spec,
      ...(preflight.strategy ? { strategy: preflight.strategy } : {}),
      message: "链接未创建",
      error: preflight.risks.join("；") || "预检未通过",
    }
  }
  try {
    if (preflight.strategy === "windows-junction" || preflight.strategy === "windows-symlink") {
      await executeWindowsOperation(preflight.spec, preflight.strategy, preflight.target.kind)
    } else if (preflight.strategy === "macos-symlink") {
      await executeMacosOperation(preflight.spec, preflight.target.kind)
    } else {
      await executeWslOperation(preflight.spec)
    }
    const linkRuntime = runtimePath(preflight.spec.linkHost, preflight.spec.linkPath)
    const created = await lstat(linkRuntime).catch(function (): undefined { return undefined })
    if (!created?.isSymbolicLink()) throw new Error("系统操作已返回成功，但未检测到新链接")
    return {
      schemaVersion: 1,
      attempted: true,
      success: true,
      spec: preflight.spec,
      strategy: preflight.strategy,
      message: "链接创建成功",
    }
  } catch (error) {
    return {
      schemaVersion: 1,
      attempted: true,
      success: false,
      spec: preflight.spec,
      strategy: preflight.strategy,
      message: "链接创建失败",
      error: errorText(error),
    }
  }
}

export async function preflightDeleteLink(input: { host: HostKind; path: string }): Promise<LinkDeletePreflight> {
  let path: string
  try {
    path = normalizePath(input.host, input.path)
  } catch (error) {
    return {
      schemaVersion: 1,
      host: input.host,
      path: input.path,
      ready: false,
      targetStatus: "not-applicable",
      risks: [errorText(error)],
    }
  }

  const result: LinkDeletePreflight = {
    schemaVersion: 1,
    host: input.host,
    path,
    ready: false,
    targetStatus: "broken",
    risks: [],
  }
  let runtime: string
  try {
    runtime = runtimePath(input.host, path)
  } catch (error) {
    result.risks.push(errorText(error))
    return result
  }

  const info = await lstat(runtime).catch(function (): undefined { return undefined })
  if (!info) {
    result.risks.push(`链接条目不存在：${path}`)
    return result
  }
  if (!info.isSymbolicLink()) {
    result.kind = await classifyRuntimeEntry(input.host, runtime, info)
    result.targetStatus = "not-applicable"
    result.risks.push("只允许删除链接条目，普通文件和目录不会被删除")
    return result
  }
  result.kind = await classifyRuntimeEntry(input.host, runtime, info)
  result.targetPath = await resolvedDisplayPath(input.host, runtime)
  result.targetStatus = result.targetPath ? "exists" : "broken"
  result.ready = true
  return result
}

export async function executeDeleteLink(input: { host: HostKind; path: string }): Promise<LinkExecutionResult> {
  const preflight = await preflightDeleteLink(input)
  const spec: LinkSpec = {
    targetHost: input.host,
    targetPath: preflight.targetPath ?? "",
    linkHost: input.host,
    linkPath: preflight.path,
  }
  if (!preflight.ready) {
    return {
      schemaVersion: 1,
      attempted: false,
      success: false,
      spec,
      message: "链接未删除",
      error: preflight.risks.join("；"),
    }
  }
  try {
    const runtime = runtimePath(input.host, preflight.path)
    await unlink(runtime)
    const remains = await lstat(runtime).catch(function (): undefined { return undefined })
    if (remains) throw new Error("系统操作已返回成功，但链接条目仍然存在")
    return { schemaVersion: 1, attempted: true, success: true, spec, message: "链接删除成功" }
  } catch (error) {
    return { schemaVersion: 1, attempted: true, success: false, spec, message: "链接删除失败", error: errorText(error) }
  }
}

/**
 * 把 agent 目录下的实体拷贝转为链接（真相 convert_copy 语义）：
 * 改名备份 -> 建链接 -> 验证 -> 删备份；任何一步失败都回滚恢复原目录。
 */
export async function convertCopyToLink(input: { host: HostKind; agentPath: string; name: string; targetPath: string }): Promise<LinkExecutionResult> {
  const adapter = getHostPathAdapter(input.host)
  let linkPath: string
  let backupPath: string
  try {
    linkPath = appendSafeChild(adapter, adapter.normalize(input.agentPath), input.name)
    backupPath = adapter.join(adapter.normalize(input.agentPath), `${input.name}.__conv__`)
  } catch (error) {
    return { schemaVersion: 1, attempted: false, success: false, spec: { targetHost: input.host, targetPath: input.targetPath, linkHost: input.host, linkPath: adapter.join(adapter.normalize(input.agentPath), input.name) }, message: "转换未执行", error: errorText(error) }
  }
  const spec: LinkSpec = { targetHost: input.host, targetPath: input.targetPath, linkHost: input.host, linkPath }
  let runtimeLink: string
  let runtimeBackup: string
  try {
    runtimeLink = runtimePath(input.host, linkPath)
    runtimeBackup = runtimePath(input.host, backupPath)
  } catch (error) {
    return { schemaVersion: 1, attempted: false, success: false, spec, message: "转换未执行", error: errorText(error) }
  }
  const original = await lstat(runtimeLink).catch(function (): undefined { return undefined })
  if (!original?.isDirectory()) {
    return { schemaVersion: 1, attempted: false, success: false, spec, message: "转换未执行", error: "目标条目不是普通目录，不能转换" }
  }
  try {
    await rename(runtimeLink, runtimeBackup)
  } catch (error) {
    return { schemaVersion: 1, attempted: false, success: false, spec, message: "转换未执行", error: `备份目录失败：${errorText(error)}` }
  }
  const created = await executeLink(spec)
  if (!created.success) {
    await rename(runtimeBackup, runtimeLink).catch(function (): void { /* 尽力回滚 */ })
    return { ...created, message: "转换失败，已恢复原目录" }
  }
  const verified = await lstat(runtimeLink).catch(function (): undefined { return undefined })
  if (!verified) {
    await rm(runtimeLink, { recursive: true, force: true }).catch(function (): void {})
    await rename(runtimeBackup, runtimeLink).catch(function (): void {})
    return { schemaVersion: 1, attempted: true, success: false, spec, message: "转换失败（验证未通过，已回滚）" }
  }
  await rm(runtimeBackup, { recursive: true, force: true }).catch(function (): void {})
  return { schemaVersion: 1, attempted: true, success: true, spec, message: "转换成功（原目录已备份验证后删除）" }
}

function logicalChildPath(host: HostKind, root: string, runtimeRoot: string, runtimeChild: string): string {
  const relative = process.platform === "win32" && host === "windows"
    ? nodePath.win32.relative(runtimeRoot, runtimeChild)
    : nodePath.posix.relative(runtimeRoot, runtimeChild)
  const parts = relative.split(/[\\/]/u).filter(Boolean)
  return adapterFor(host).join(root, ...parts)
}

function displayRuntimePath(host: HostKind, value: string): string {
  if (host === "windows" && process.platform !== "win32") return wslPathToWindows(value) ?? value
  return value
}

async function scanEntry(host: HostKind, root: string, runtimeRoot: string, runtimePathValue: string, info: RuntimeStat): Promise<LinkEntry> {
  const absolutePath = logicalChildPath(host, root, runtimeRoot, runtimePathValue)
  const entry: LinkEntry = {
    name: nodePath.basename(runtimePathValue),
    relativePath: adapterFor(host).relative(root, absolutePath).replaceAll("\\", "/"),
    absolutePath,
    kind: await classifyRuntimeEntry(host, runtimePathValue, info),
    targetStatus: "not-applicable",
    canDelete: info.isSymbolicLink(),
  }
  if (info.isSymbolicLink()) {
    entry.rawTarget = await readlink(runtimePathValue).catch(function (): undefined { return undefined })
    entry.targetPath = await resolvedDisplayPath(host, runtimePathValue)
    entry.targetStatus = entry.targetPath ? "exists" : "broken"
  }
  return entry
}

async function scanNativeWindowsLinkDirectory(path: string, recursive: boolean): Promise<LinkScan> {
  const native = await scanWindowsDirectory({ path, recursive, maxEntries: MAX_SCAN_ENTRIES })
  const entries: LinkEntry[] = native.entries.map(function (item): LinkEntry {
    const kind: LinkEntryKind = item.isReparsePoint
      ? item.linkType === "junction" ? "windows-junction" : item.linkType === "symlink" ? "windows-symlink" : "unsupported-link"
      : item.isDirectory ? "directory" : "file"
    const targetStatus = item.isReparsePoint ? item.targetPath ? "exists" : "broken" : "not-applicable"
    return {
      name: item.name,
      relativePath: nodePath.win32.relative(native.rootPath, item.path).replaceAll("\\", "/"),
      absolutePath: item.path,
      kind,
      ...(item.rawTarget ? { rawTarget: item.rawTarget } : {}),
      ...(item.targetPath ? { targetPath: item.targetPath } : {}),
      targetStatus,
      canDelete: item.isReparsePoint,
    }
  })
  entries.sort(function (left, right): number { return left.relativePath.localeCompare(right.relativePath) })
  return {
    schemaVersion: 1,
    path,
    host: "windows",
    recursive,
    supported: native.supported,
    rootExists: native.rootExists,
    rootIsDirectory: native.rootIsDirectory,
    entries,
    issues: native.issues,
  }
}

export async function scanLinkDirectory(input: { host: HostKind; path: string; recursive?: boolean }): Promise<LinkScan> {
  let path: string
  try {
    path = normalizePath(input.host, input.path)
  } catch (error) {
    return {
      schemaVersion: 1,
      path: input.path,
      host: input.host,
      recursive: Boolean(input.recursive),
      supported: false,
      rootExists: false,
      rootIsDirectory: false,
      entries: [],
      issues: [errorText(error)],
    }
  }

  if (input.host === "windows" && process.platform !== "win32") return scanNativeWindowsLinkDirectory(path, Boolean(input.recursive))

  let root: string
  try {
    root = runtimePath(input.host, path)
  } catch (error) {
    return {
      schemaVersion: 1,
      path,
      host: input.host,
      recursive: Boolean(input.recursive),
      supported: false,
      rootExists: false,
      rootIsDirectory: false,
      entries: [],
      issues: [errorText(error)],
    }
  }

  const result: LinkScan = {
    schemaVersion: 1,
    path,
    host: input.host,
    recursive: Boolean(input.recursive),
    supported: true,
    rootExists: false,
    rootIsDirectory: false,
    entries: [],
    issues: [],
  }
  const rootInfo = await lstat(root).catch(function (error: unknown): undefined {
    result.issues.push(errorText(error))
    return undefined
  })
  if (!rootInfo) return result
  result.rootExists = true
  if (!rootInfo.isDirectory()) {
    result.issues.push("扫描路径不是目录")
    return result
  }
  result.rootIsDirectory = true

  const queue: string[] = [root]
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!
    const children = await readdir(current, { withFileTypes: true }).catch(function (error: unknown): import("node:fs").Dirent[] {
      result.issues.push(`无法读取 ${displayRuntimePath(input.host, current)}：${errorText(error)}`)
      return []
    })
    children.sort(function (left, right): number { return left.name.localeCompare(right.name) })
    for (const child of children) {
      const childRuntime = nodePath.join(current, child.name)
      const info = await lstat(childRuntime).catch(function (): undefined { return undefined })
      if (!info) {
        result.issues.push(`条目读取失败：${displayRuntimePath(input.host, childRuntime)}`)
        continue
      }
      result.entries.push(await scanEntry(input.host, path, root, childRuntime, info))
      if (result.entries.length > MAX_SCAN_ENTRIES) {
        result.issues.push(`扫描条目超过 ${MAX_SCAN_ENTRIES} 个，已停止继续递归`)
        return result
      }
      if (input.recursive && info.isDirectory() && !info.isSymbolicLink()) queue.push(childRuntime)
    }
  }
  result.entries.sort(function (left, right): number { return left.relativePath.localeCompare(right.relativePath) })
  return result
}
