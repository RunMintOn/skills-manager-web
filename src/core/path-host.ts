import type { HostKind } from "./types.ts"

/** Returns a Host only for an absolute path whose syntax is unambiguous. */
export function detectPathHost(value: string): HostKind | undefined {
  const path = value.trim()
  if (/^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\")) return "windows"
  if (path.startsWith("/")) return "wsl"
  return undefined
}

export function isAbsolutePathForHost(host: HostKind, value: string): boolean {
  return detectPathHost(value) === host
}
