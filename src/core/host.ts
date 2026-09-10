import nodePath from "node:path"
import { homedir } from "node:os"
import { realpath } from "node:fs/promises"
import type { HostKind } from "./types.ts"

export interface HostPathAdapter {
  host: HostKind
  supportedRuntime: boolean
  separator: string
  isAbsolute(value: string): boolean
  normalize(value: string): string
  resolve(...parts: string[]): string
  join(...parts: string[]): string
  relative(from: string, to: string): string
  basename(value: string): string
}

const POSIX = nodePath.posix
const WINDOWS = nodePath.win32
const HOME_PREFIX = "$HOME"

export function expandHomePath(value: string): string {
  const path = value.trim()
  if (path === HOME_PREFIX) return homedir()
  if (path.startsWith(`${HOME_PREFIX}/`)) return nodePath.join(homedir(), path.slice(HOME_PREFIX.length + 1))
  return path
}

export function runtimeHost(platform: NodeJS.Platform = process.platform): HostKind {
  if (platform === "darwin") return "macos"
  if (platform === "win32") return "windows"
  return "wsl"
}

function supportsRuntime(host: HostKind): boolean {
  if (host === "windows") return process.platform === "win32"
  if (host === "macos") return process.platform === "darwin"
  return process.platform !== "win32"
}

export function getHostPathAdapter(host: HostKind): HostPathAdapter {
  const path = host === "windows" ? WINDOWS : POSIX
  return {
    host,
    supportedRuntime: supportsRuntime(host),
    separator: path.sep,
    isAbsolute: path.isAbsolute,
    normalize: path.normalize,
    resolve: path.resolve,
    join: path.join,
    relative: path.relative,
    basename: path.basename,
  }
}
export function toStableRelative(adapter: HostPathAdapter, value: string): string {
  const stable = value.split(adapter.separator).join("/")
  return stable === "" ? "." : stable
}
export function isInside(adapter: HostPathAdapter, root: string, candidate: string): boolean {
  const lower = (value: string) => adapter.host === "windows" ? value.toLocaleLowerCase("en-US") : value
  const relative = adapter.relative(lower(root), lower(candidate))
  return relative === "" || (!relative.startsWith(`..${adapter.separator}`) && relative !== ".." && !adapter.isAbsolute(relative))
}
export function appendSafeChild(adapter: HostPathAdapter, root: string, child: string): string {
  if (!child || child === "." || child === ".." || child.includes("\0") || child.includes("/") || child.includes("\\") || /[\u0000-\u001f]/u.test(child)) {
    throw new Error("skill name cannot be used as a single path segment")
  }
  return adapter.join(root, child)
}
export async function safeRealpath(value: string): Promise<string | undefined> {
  try { return await realpath(value) } catch { return undefined }
}
export function windowsPathToWsl(value: string): string | undefined {
  const match = value.match(/^([A-Za-z]):[\\/](.*)$/u)
  if (!match) return undefined
  return `/mnt/${match[1]!.toLocaleLowerCase("en-US")}/${match[2]!.replaceAll("\\", "/")}`
}
export function wslPathToWindows(value: string): string | undefined {
  const match = value.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/u)
  if (!match) return undefined
  return `${match[1]!.toLocaleUpperCase("en-US")}:\\${(match[2] ?? "").replaceAll("/", "\\")}`
}
export function hostPathDescription(host: HostKind): string {
  if (host === "wsl") return "WSL/POSIX"
  if (host === "macos") return "macOS/POSIX"
  return "Windows/NT"
}
