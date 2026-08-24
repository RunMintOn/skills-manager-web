import { spawn } from "node:child_process"
import nodePath from "node:path"
import { assertSafeWindowsPath } from "./link-plan.ts"

export interface WindowsDirectoryEntry {
  path: string
  name: string
  isDirectory: boolean
  isReparsePoint: boolean
  linkType?: "junction" | "symlink" | "other"
  rawTarget?: string
  targetPath?: string
  size?: number
  modifiedMs?: number
  content?: string
  childFiles: Record<string, string>
}

export interface WindowsDirectoryScan {
  supported: boolean
  rootExists: boolean
  rootIsDirectory: boolean
  rootPath: string
  canonicalPath?: string
  entries: WindowsDirectoryEntry[]
  ignoredDirectories: number
  issues: string[]
}

type ScanInput = {
  path: string
  recursive: boolean
  maxEntries?: number
  skipDirectoryNames?: string[]
  skipTopLevelDotDirectories?: boolean
  readFileNames?: string[]
  readChildFileNames?: string[]
}

type RawRecord = Record<string, unknown>

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64")
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((item): item is [string, string] => typeof item[1] === "string"))
}

function recordEntry(value: RawRecord): WindowsDirectoryEntry | undefined {
  const path = text(value.path)
  const name = text(value.name)
  if (!path || !name || typeof value.isDirectory !== "boolean" || typeof value.isReparsePoint !== "boolean") return undefined
  const linkType = text(value.linkType)
  return {
    path,
    name,
    isDirectory: value.isDirectory,
    isReparsePoint: value.isReparsePoint,
    ...(linkType === "junction" || linkType === "symlink" || linkType === "other" ? { linkType } : {}),
    ...(text(value.rawTarget) ? { rawTarget: text(value.rawTarget) } : {}),
    ...(text(value.targetPath) ? { targetPath: text(value.targetPath) } : {}),
    ...(typeof value.size === "number" && Number.isFinite(value.size) ? { size: value.size } : {}),
    ...(typeof value.modifiedMs === "number" && Number.isFinite(value.modifiedMs) ? { modifiedMs: value.modifiedMs } : {}),
    ...(text(value.content) !== undefined ? { content: text(value.content) } : {}),
    childFiles: stringMap(value.childFiles),
  }
}

function scriptFor(input: Required<Pick<ScanInput, "path" | "recursive" | "maxEntries" | "skipDirectoryNames" | "skipTopLevelDotDirectories" | "readFileNames" | "readChildFileNames">>): string {
  const skipNames = input.skipDirectoryNames.map(quotePowerShell).join(", ")
  const readNames = input.readFileNames.map(quotePowerShell).join(", ")
  const childNames = input.readChildFileNames.map(quotePowerShell).join(", ")
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = ${quotePowerShell(input.path)}
$skipNames = @(${skipNames})
$readNames = @(${readNames})
$childNames = @(${childNames})
$maxEntries = ${input.maxEntries}
$recursive = $${input.recursive}
$skipTopLevelDotDirectories = $${input.skipTopLevelDotDirectories}
function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 5)) }
try { $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop } catch { Emit @{ type = 'root'; exists = $false; isDirectory = $false; path = $root }; Emit @{ type = 'issue'; message = $_.Exception.Message }; exit 0 }
if (-not $rootItem.PSIsContainer) { Emit @{ type = 'root'; exists = $true; isDirectory = $false; path = $rootItem.FullName }; exit 0 }
Emit @{ type = 'root'; exists = $true; isDirectory = $true; path = $rootItem.FullName; canonicalPath = $rootItem.FullName }
try { $children = if ($recursive) { Get-ChildItem -LiteralPath $rootItem.FullName -Force -Recurse -ErrorAction Stop } else { Get-ChildItem -LiteralPath $rootItem.FullName -Force -ErrorAction Stop } } catch { Emit @{ type = 'issue'; message = ('Cannot read ' + $rootItem.FullName + ': ' + $_.Exception.Message) }; Emit @{ type = 'done'; ignoredDirectories = 0 }; exit 0 }
$rootPrefix = $rootItem.FullName.TrimEnd('\\') + '\\'
$records = [System.Collections.Generic.List[object]]::new()
$count = 0
$ignored = 0
foreach ($child in $children) {
  $relative = if ($child.FullName.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { $child.FullName.Substring($rootPrefix.Length) } else { $child.Name }
  $segments = $relative -split '[\\\\/]'
  $isDirectory = [bool]$child.PSIsContainer
  $skipIndex = -1
  for ($index = 0; $index -lt $segments.Length; $index += 1) {
    if (($skipNames -contains $segments[$index]) -or ($index -eq 0 -and $skipTopLevelDotDirectories -and $segments[$index].StartsWith('.'))) { $skipIndex = $index; break }
  }
  if ($skipIndex -ge 0) {
    if ($isDirectory -and $skipIndex -eq ($segments.Length - 1)) { $ignored += 1 }
    continue
  }
  $isReparsePoint = (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  $rawTarget = $null
  $targetPath = $null
  $linkType = $null
  if ($isReparsePoint) {
    $rawTarget = @($child.Target | Select-Object -First 1)[0]
    if ($rawTarget) {
      try { $targetPath = if ([System.IO.Path]::IsPathRooted([string]$rawTarget)) { [System.IO.Path]::GetFullPath([string]$rawTarget) } else { [System.IO.Path]::GetFullPath((Join-Path -Path $child.DirectoryName -ChildPath ([string]$rawTarget))) } } catch { }
    }
    if ($child.LinkType -eq 'Junction') { $linkType = 'junction' } elseif ($child.LinkType -eq 'SymbolicLink') { $linkType = 'symlink' } else { $linkType = 'other' }
  }
  $content = $null
  if (-not $isDirectory -and -not $isReparsePoint -and $readNames -contains $child.Name) {
    try { $content = [string](Get-Content -LiteralPath $child.FullName -Raw -ErrorAction Stop) } catch { Emit @{ type = 'issue'; message = ('Cannot read ' + $child.FullName + ': ' + $_.Exception.Message) } }
  }
  $childFiles = @{}
  if ($isDirectory -and -not $isReparsePoint) {
    foreach ($childName in $childNames) {
      $candidate = Join-Path -Path $child.FullName -ChildPath $childName
      try { $candidateItem = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop; if (-not $candidateItem.PSIsContainer -and (($candidateItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) { $childFiles[$childName] = [string](Get-Content -LiteralPath $candidate -Raw -ErrorAction Stop) } } catch { }
    }
  }
  $size = if ($isDirectory) { $null } else { [int64]$child.Length }
  $modifiedMs = [math]::Round(($child.LastWriteTimeUtc - [datetime]'1970-01-01').TotalMilliseconds)
  $records.Add([pscustomobject]@{ path = $child.FullName; name = $child.Name; isDirectory = $isDirectory; isReparsePoint = $isReparsePoint; linkType = $linkType; rawTarget = $rawTarget; targetPath = $targetPath; size = $size; modifiedMs = $modifiedMs; content = $content; childFiles = $childFiles })
  $count += 1
  if ($count -ge $maxEntries) { Emit @{ type = 'issue'; message = ('扫描条目超过 ' + $maxEntries + ' 个，已停止继续递归') }; break }
}
Emit @{ type = 'entries'; items = $records }
Emit @{ type = 'done'; ignoredDirectories = $ignored }`
}

async function runPowerShell(script: string): Promise<{ stdout: string; error?: string }> {
  return new Promise(function (resolve): void {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script)], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", function (chunk: Buffer): void { stdout += chunk.toString() })
    child.stderr.on("data", function (chunk: Buffer): void { stderr += chunk.toString() })
    child.once("error", function (error): void { resolve({ stdout, error: error.message }) })
    child.once("close", function (code): void { resolve({ stdout, ...(code === 0 ? {} : { error: stderr.trim() || `powershell.exe exited with code ${code ?? "unknown"}` }) }) })
  })
}

/** Native Windows enumeration for a WSL runtime. It never follows reparse-point directories. */
export async function scanWindowsDirectory(input: ScanInput): Promise<WindowsDirectoryScan> {
  assertSafeWindowsPath(input.path, "path")
  const path = nodePath.win32.normalize(input.path)
  const result: WindowsDirectoryScan = { supported: true, rootExists: false, rootIsDirectory: false, rootPath: path, entries: [], ignoredDirectories: 0, issues: [] }
  const response = await runPowerShell(scriptFor({
    path,
    recursive: input.recursive,
    maxEntries: input.maxEntries ?? 10_000,
    skipDirectoryNames: input.skipDirectoryNames ?? [],
    skipTopLevelDotDirectories: input.skipTopLevelDotDirectories ?? false,
    readFileNames: input.readFileNames ?? [],
    readChildFileNames: input.readChildFileNames ?? [],
  }))
  if (response.error) {
    result.supported = false
    result.issues.push(response.error)
  }
  for (const line of response.stdout.split(/\r?\n/u).filter(Boolean)) {
    let record: RawRecord
    try { record = JSON.parse(line) as RawRecord } catch { result.issues.push("Windows 扫描返回了无效数据"); continue }
    if (record.type === "root") {
      result.rootExists = record.exists === true
      result.rootIsDirectory = record.isDirectory === true
      result.rootPath = text(record.path) ?? path
      const canonicalPath = text(record.canonicalPath)
      if (canonicalPath) result.canonicalPath = canonicalPath
      continue
    }
    if (record.type === "issue") { result.issues.push(text(record.message) ?? "Windows 扫描失败"); continue }
    if (record.type === "done") { result.ignoredDirectories = typeof record.ignoredDirectories === "number" ? record.ignoredDirectories : result.ignoredDirectories; continue }
    if (record.type === "entry") {
      const entry = recordEntry(record)
      if (entry) result.entries.push(entry)
      else result.issues.push("Windows 扫描返回了不完整条目")
      continue
    }
    if (record.type === "entries" && Array.isArray(record.items)) {
      for (const item of record.items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) { result.issues.push("Windows 扫描返回了不完整条目"); continue }
        const entry = recordEntry(item as RawRecord)
        if (entry) result.entries.push(entry)
        else result.issues.push("Windows 扫描返回了不完整条目")
      }
    }
  }
  return result
}
