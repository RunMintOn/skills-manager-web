import nodePath from "node:path"
import { realpath } from "node:fs/promises"
import type { HostKind } from "./types.js"

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
export function getHostPathAdapter(host: HostKind): HostPathAdapter {
  const path = host === "windows" ? WINDOWS : POSIX
  return {
    host,
    supportedRuntime: host === "windows" ? process.platform === "win32" : process.platform !== "win32",
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
export function hostPathDescription(host: HostKind): string { return host === "wsl" ? "WSL/POSIX" : "Windows/NT" }
