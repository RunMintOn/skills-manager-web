import { windowsPathToWsl } from "./host.ts"
import type { HostKind, LinkOperationPlan } from "./types.ts"

type WslSymlinkInput = {
  targetPath: string
  linkPath: string
  distribution?: string
  linkKind?: "wsl-to-wsl-symlink" | "wsl-to-windows-symlink"
}

type LinkInput = { vaultHost: HostKind; agentHost: HostKind; targetPath: string; linkPath: string }

export function isSafeWslPath(value: string): boolean {
  if (!value.startsWith("/")) return false
  if (value.includes("\0") || value.includes("\\")) return false
  return !value.split("/").some(function (part): boolean { return part === "." || part === ".." })
}

export function isSafeWindowsPath(value: string): boolean {
  const absolute = /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\")
  if (!absolute || value.includes("\0")) return false
  return !value.split(/[\\/]/u).some(function (part): boolean { return part === "." || part === ".." })
}

export function assertSafeWslPath(value: string, label: string): void {
  if (!isSafeWslPath(value)) throw new Error(`${label} must be an absolute safe WSL path without traversal segments`)
}

export function assertSafeWindowsPath(value: string, label: string): void {
  if (!isSafeWindowsPath(value)) throw new Error(`${label} must be an absolute safe Windows path without traversal segments`)
}

function assertDistinctPaths(target: string, link: string): void {
  if (target === link) throw new Error("targetPath and linkPath must differ")
}

function validateDistribution(distribution: string | undefined): void {
  if (distribution && !/^[A-Za-z0-9._-]+$/u.test(distribution)) throw new Error("distribution contains unsafe characters")
}

function wslArguments(input: WslSymlinkInput): string[] {
  if (input.distribution) {
    return ["--distribution", input.distribution, "--exec", "ln", "-s", "--", input.targetPath, input.linkPath]
  }
  return ["--exec", "ln", "-s", "--", input.targetPath, input.linkPath]
}

export function createWslSymlinkCommand(input: WslSymlinkInput): LinkOperationPlan {
  assertSafeWslPath(input.targetPath, "targetPath")
  assertSafeWslPath(input.linkPath, "linkPath")
  assertDistinctPaths(input.targetPath, input.linkPath)
  validateDistribution(input.distribution)
  return {
    kind: "wsl-command",
    host: "wsl",
    executable: "wsl.exe",
    args: wslArguments(input),
    shell: false,
    targetPath: input.targetPath,
    linkPath: input.linkPath,
    directoryOnly: true,
  }
}

export function createWindowsJunctionPlan(input: { targetPath: string; linkPath: string }): LinkOperationPlan {
  assertSafeWindowsPath(input.targetPath, "targetPath")
  assertSafeWindowsPath(input.linkPath, "linkPath")
  assertDistinctPaths(input.targetPath, input.linkPath)
  return {
    kind: "windows-junction",
    host: "windows",
    api: "fs.promises.symlink",
    fsArgs: [input.targetPath, input.linkPath, "junction"],
    targetPath: input.targetPath,
    linkPath: input.linkPath,
    directoryOnly: true,
  }
}

function createWindowsToWslPlan(input: LinkInput): LinkOperationPlan {
  const target = windowsPathToWsl(input.targetPath)
  if (!target) throw new Error("Windows Vault path is not a drive path supported by the WSL adapter")
  return {
    kind: "wsl-command",
    host: "wsl",
    executable: "wsl.exe",
    args: ["--exec", "ln", "-s", "--", target, input.linkPath],
    shell: false,
    targetPath: input.targetPath,
    linkPath: input.linkPath,
    directoryOnly: true,
  }
}

export function createLinkOperation(input: LinkInput): LinkOperationPlan {
  if (input.vaultHost !== input.agentHost) throw new Error("连接操作暂时只支持同一环境：目标和链接必须使用相同 Host")
  if (input.vaultHost === "wsl" && input.agentHost === "wsl") {
    return createWslSymlinkCommand({ targetPath: input.targetPath, linkPath: input.linkPath })
  }
  if (input.vaultHost === "windows" && input.agentHost === "windows") {
    return createWindowsJunctionPlan({ targetPath: input.targetPath, linkPath: input.linkPath })
  }
  if (input.vaultHost === "wsl" && input.agentHost === "windows") {
    const linkPath = windowsPathToWsl(input.linkPath)
    if (!linkPath) throw new Error("Windows Agent path is not a drive path supported by the WSL adapter")
    return createWslSymlinkCommand({ targetPath: input.targetPath, linkPath })
  }
  if (input.vaultHost === "windows" && input.agentHost === "wsl") return createWindowsToWslPlan(input)
  throw new Error("No safe link adapter is configured")
}

function safeSegment(child: string): boolean {
  if (!child || child === "." || child === "..") return false
  if (child.includes("/") || child.includes("\\")) return false
  return !/[\u0000-\u001f]/u.test(child)
}

export function appendWslPath(root: string, child: string): string {
  assertSafeWslPath(root, "rootPath")
  if (!safeSegment(child)) throw new Error("child path segment is unsafe")
  return `${root.replace(/\/+$/u, "")}/${child}`
}

export function appendWindowsPath(root: string, child: string): string {
  assertSafeWindowsPath(root, "rootPath")
  if (!safeSegment(child)) throw new Error("child path segment is unsafe")
  return `${root.replace(/[\\/]+$/u, "")}\\${child}`
}
