import type { HostKind, LinkOperationPlan } from "./types.ts"

export function isSafeWslPath(value: string): boolean {
  return value.startsWith("/") && !value.includes("\0") && !value.includes("\\") && !value.split("/").some((part) => part === "." || part === "..")
}
export function isSafeWindowsPath(value: string): boolean {
  const absolute = /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\")
  return absolute && !value.includes("\0") && !value.split(/[\\/]/u).some((part) => part === "." || part === "..")
}
export function assertSafeWslPath(value: string, label: string): void { if (!isSafeWslPath(value)) throw new Error(`${label} must be an absolute safe WSL path without traversal segments`) }
export function assertSafeWindowsPath(value: string, label: string): void { if (!isSafeWindowsPath(value)) throw new Error(`${label} must be an absolute safe Windows path without traversal segments`) }
function distinct(target: string, link: string): void { if (target === link) throw new Error("targetPath and linkPath must differ") }
export function createWslSymlinkCommand(input: { targetPath: string; linkPath: string; distribution?: string; linkKind?: "wsl-to-wsl-symlink" | "wsl-to-windows-symlink" }): LinkOperationPlan {
  assertSafeWslPath(input.targetPath, "targetPath"); assertSafeWslPath(input.linkPath, "linkPath"); distinct(input.targetPath, input.linkPath)
  if (input.distribution && !/^[A-Za-z0-9._-]+$/u.test(input.distribution)) throw new Error("distribution contains unsafe characters")
  const args = input.distribution ? ["--distribution", input.distribution, "--exec", "ln", "-s", "--", input.targetPath, input.linkPath] : ["--exec", "ln", "-s", "--", input.targetPath, input.linkPath]
  return { kind: "wsl-command", host: "wsl", executable: "wsl.exe", args, shell: false, targetPath: input.targetPath, linkPath: input.linkPath, directoryOnly: true }
}
export function createWindowsJunctionPlan(input: { targetPath: string; linkPath: string }): LinkOperationPlan {
  assertSafeWindowsPath(input.targetPath, "targetPath"); assertSafeWindowsPath(input.linkPath, "linkPath"); distinct(input.targetPath, input.linkPath)
  return { kind: "windows-junction", host: "windows", api: "fs.promises.symlink", fsArgs: [input.targetPath, input.linkPath, "junction"], targetPath: input.targetPath, linkPath: input.linkPath, directoryOnly: true }
}
export function createLinkOperation(input: { vaultHost: HostKind; agentHost: HostKind; targetPath: string; linkPath: string }): LinkOperationPlan {
  if (input.vaultHost === "wsl" && input.agentHost === "wsl") return createWslSymlinkCommand({ targetPath: input.targetPath, linkPath: input.linkPath, linkKind: "wsl-to-wsl-symlink" })
  if (input.vaultHost === "windows" && input.agentHost === "windows") return createWindowsJunctionPlan({ targetPath: input.targetPath, linkPath: input.linkPath })
  if (input.vaultHost === "wsl" && input.agentHost === "windows") {
    const mounted = windowsPathToWsl(input.linkPath)
    if (!mounted) throw new Error("Windows Agent path is not a drive path supported by the WSL adapter")
    return createWslSymlinkCommand({ targetPath: input.targetPath, linkPath: mounted, linkKind: "wsl-to-windows-symlink" })
  }
  throw new Error("Windows Vault to WSL Agent linking is blocked: no safe adapter is configured")
}
export function appendWslPath(root: string, child: string): string { assertSafeWslPath(root, "rootPath"); if (!safeSegment(child)) throw new Error("child path segment is unsafe"); return `${root.replace(/\/+$/u, "")}/${child}` }
export function appendWindowsPath(root: string, child: string): string { assertSafeWindowsPath(root, "rootPath"); if (!safeSegment(child)) throw new Error("child path segment is unsafe"); return `${root.replace(/[\\/]+$/u, "")}\\${child}` }
function safeSegment(child: string): boolean { return Boolean(child) && child !== "." && child !== ".." && !child.includes("/") && !child.includes("\\") && !/[\u0000-\u001f]/u.test(child) }
function windowsPathToWsl(value: string): string | undefined { const drive = value.match(/^([A-Za-z]):[\\/](.*)$/u); return drive ? `/mnt/${drive[1]!.toLocaleLowerCase("en-US")}/${drive[2]!.replaceAll("\\", "/")}` : undefined }
