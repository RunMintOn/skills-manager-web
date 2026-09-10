import type { HostKind } from "./types.ts"

/** Returns a Host only for an absolute path whose syntax is unambiguous. */
export function detectPathHost(value: string, posixHost: "wsl" | "macos" = "wsl"): HostKind | undefined {
  const path = value.trim()
  if (/^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\")) return "windows"
  if (path.startsWith("/")) return posixHost
  return undefined
}

export function isAbsolutePathForHost(host: HostKind, value: string): boolean {
  if (host === "windows") return detectPathHost(value) === host
  return detectPathHost(value, host) === host
}
