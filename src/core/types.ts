export type HostKind = "wsl" | "windows"
export type ScanSeverity = "warning" | "error"
export type VaultSkillValidity = "valid" | "invalid"

export type AgentEntryKind =
  | "repo-link"
  | "repo-copy"
  | "local-dir"
  | "external-link"
  | "broken-link"
  | "invalid"

export type ComparisonState =
  | "linked"
  | "pending"
  | "local-dir"
  | "external-link"
  | "broken-link"
  | "invalid"

export interface VaultConfig { path: string; host: HostKind }
export interface AgentConfig { id: string; name: string; host: HostKind; path: string }
export interface CommonPath { id: string; name: string; host: HostKind; path: string }
/** 链接记录：skill -> agent（按 agentId 关联）。来源集合只存在应用配置里，文件系统上不可见（真相语义）。 */
export interface LinkRecord { skill: string; collection: string; agentId: string }

/** Windows 真相源到 WSL 镜像的单向同步配置。选择路径始终相对于 source 根目录。 */
export type MirrorSyncScope = "full" | "selected"
export interface MirrorSyncConfig {
  source: VaultConfig
  mirror: VaultConfig
  scope: MirrorSyncScope
  selectedPaths?: string[]
  exclude?: string[]
}
export interface SkillManagerConfig {
  schemaVersion: 1
  vault: VaultConfig
  agents: AgentConfig[]
  commonPaths?: CommonPath[]
  links?: LinkRecord[]
  mirrorSync?: MirrorSyncConfig
  lastScanPath?: string
  selectedAgentId?: string
}
export interface LoadedConfig extends SkillManagerConfig { configPath: string; exists: boolean }

export interface Frontmatter {
  present: boolean
  raw: string
  fields: Record<string, string>
  name?: string
  description?: string
  errors: string[]
}

export type SkillIssueCode =
  | "frontmatter-missing"
  | "frontmatter-malformed"
  | "name-missing"
  | "name-mismatch"
  | "duplicate-id"
  | "skill-read-error"

export interface SkillIssue { code: SkillIssueCode; severity: ScanSeverity; message: string }
export interface VaultSkill {
  id: string
  relativePath: string
  absolutePath: string
  canonicalPath?: string
  collection: string
  directoryName: string
  frontmatter: Frontmatter
  name?: string
  description?: string
  validity: VaultSkillValidity
  issues: SkillIssue[]
}
export interface VaultValidationIssue {
  code: SkillIssueCode | "vault-missing" | "vault-unreadable"
  severity: ScanSeverity
  relativePath?: string
  skillId?: string
  message: string
}
export interface VaultCollection {
  id: string
  label: string
  skillIds: string[]
  validCount: number
  invalidCount: number
}
export interface VaultScanSummary {
  total: number
  valid: number
  invalid: number
  collections: number
  duplicateIds: number
  errors: number
  warnings: number
  ignoredDirs: number
  issueCount: number
}
export interface VaultScan {
  path: string
  host: HostKind
  supported: boolean
  rootExists: boolean
  canonicalPath?: string
  skills: VaultSkill[]
  collections: VaultCollection[]
  duplicateIds: string[]
  issues: VaultValidationIssue[]
  summary: VaultScanSummary
}

export type AgentEntryIssueCode =
  | "agent-root-missing"
  | "agent-root-unreadable"
  | "local-directory"
  | "external-link"
  | "broken-link"
  | "invalid-entry"
  | "cross-host-link"
  | "duplicate-skill-entry"
  | "invalid-skill-metadata"
export interface AgentEntryIssue { code: AgentEntryIssueCode; severity: ScanSeverity; message: string }
export interface AgentEntry {
  name: string
  relativePath: string
  absolutePath: string
  kind: AgentEntryKind
  targetPath?: string
  targetVaultRelativePath?: string
  /** 对应 Vault Skill 的身份键（skill.relativePath，全局唯一；同名 skill 可分别指向）。 */
  skillKey?: string
  frontmatter?: Frontmatter
  issues: AgentEntryIssue[]
}
export interface AgentScanSummary {
  total: number
  repoLinks: number
  repoCopies: number
  localDirs: number
  externalLinks: number
  brokenLinks: number
  invalid: number
  issueCount: number
}
export interface AgentScan {
  id: string
  name: string
  path: string
  host: HostKind
  supported: boolean
  rootExists: boolean
  canonicalPath?: string
  entries: AgentEntry[]
  issues: AgentEntryIssue[]
  summary: AgentScanSummary
}

export interface ComparisonRow {
  skillKey: string
  skillPath: string
  collection: string
  state: ComparisonState
  agentEntryPaths: string[]
  risks: string[]
}
export interface ComparisonResult {
  agentId: string
  rows: ComparisonRow[]
  actualOnly: AgentEntry[]
  summary: Record<ComparisonState, number>
  actualSummary: { "local-dir": number; "external-link": number; "broken-link": number; invalid: number }
  issueCount: number
}

export interface WslCommandOperation {
  kind: "wsl-command"
  host: "wsl"
  executable: "wsl.exe"
  args: string[]
  shell: false
  targetPath: string
  linkPath: string
  directoryOnly: boolean
}
export interface WindowsJunctionOperation {
  kind: "windows-junction"
  host: "windows"
  api: "fs.promises.symlink" | "powershell.exe"
  fsArgs: [targetPath: string, linkPath: string, type: "junction"]
  targetPath: string
  linkPath: string
  directoryOnly: true
}
export interface WindowsSymlinkOperation {
  kind: "windows-symlink"
  host: "windows"
  api: "fs.promises.symlink" | "powershell.exe"
  fsArgs: [targetPath: string, linkPath: string, type: "file" | "dir"]
  targetPath: string
  linkPath: string
  directoryOnly: boolean
}
export type LinkOperationPlan = WslCommandOperation | WindowsJunctionOperation | WindowsSymlinkOperation

export type LinkTargetKind = "file" | "directory"
export type LinkEntryKind = "file" | "directory" | "wsl-symlink" | "windows-symlink" | "windows-junction" | "unsupported-link" | "other"
export type LinkTargetStatus = "not-applicable" | "exists" | "broken"
export type LinkStrategy = "wsl-symlink" | "wsl-to-windows-symlink" | "windows-to-wsl-symlink" | "windows-junction" | "windows-symlink"

export interface LinkSpec {
  targetHost: HostKind
  targetPath: string
  linkHost: HostKind
  linkPath: string
}

export interface BatchLinkSpec {
  targetHost: HostKind
  targetPath: string
  linkHost: HostKind
  linkPath: string
}

export interface LinkPreflight {
  schemaVersion: 1
  spec: LinkSpec
  ready: boolean
  strategy?: LinkStrategy
  target: { path: string; exists: boolean; kind?: LinkTargetKind; error?: string }
  link: { path: string; exists: boolean; kind?: LinkEntryKind; targetPath?: string; error?: string }
  parent: { path: string; exists: boolean; directory: boolean; error?: string }
  operation?: LinkOperationPlan
  risks: string[]
}

export interface LinkExecutionResult {
  schemaVersion: 1
  attempted: boolean
  success: boolean
  spec: LinkSpec
  strategy?: LinkStrategy
  message: string
  error?: string
}

export interface BatchLinkItem {
  name: string
  preflight: LinkPreflight
}

export interface BatchLinkPreflight {
  schemaVersion: 1
  spec: BatchLinkSpec
  ready: boolean
  items: BatchLinkItem[]
  risks: string[]
}

export interface BatchLinkExecutionItem {
  name: string
  targetPath: string
  linkPath: string
  action: "created" | "blocked" | "failed"
  success: boolean
  attempted: boolean
  message: string
  error?: string
}

export interface BatchLinkExecution {
  schemaVersion: 1
  execution: "completed" | "failed"
  preflight: BatchLinkPreflight
  results: BatchLinkExecutionItem[]
}

export interface LinkDeletePreflight {
  schemaVersion: 1
  host: HostKind
  path: string
  ready: boolean
  kind?: LinkEntryKind
  targetPath?: string
  targetStatus: "exists" | "broken" | "not-applicable"
  risks: string[]
}

export interface LinkEntry {
  name: string
  relativePath: string
  absolutePath: string
  kind: LinkEntryKind
  targetPath?: string
  rawTarget?: string
  targetStatus: LinkTargetStatus
  canDelete: boolean
}

export type MirrorSyncAction = "create-directory" | "copy-file" | "delete-file" | "delete-directory" | "skip"
export interface MirrorSyncOperation {
  id: string
  relativePath: string
  action: MirrorSyncAction
  sourcePath?: string
  mirrorPath: string
  reason: string
  execution: "not-run" | "completed" | "failed" | "skipped"
}
export interface MirrorSyncPlan {
  schemaVersion: 1
  mode: "preview-only" | "execution"
  sync: MirrorSyncConfig
  ready: boolean
  operations: MirrorSyncOperation[]
  issues: string[]
  summary: Record<MirrorSyncAction, number>
  safety: { filesystemWrites: "disabled" | "enabled"; source: "read-only"; note: string }
}
export interface MirrorSyncExecution {
  schemaVersion: 1
  plan: MirrorSyncPlan
  results: Array<{ id: string; success: boolean; attempted: boolean; message: string; error?: string }>
}

export interface LinkScan {
  schemaVersion: 1
  path: string
  host: HostKind
  recursive: boolean
  supported: boolean
  rootExists: boolean
  rootIsDirectory: boolean
  entries: LinkEntry[]
  issues: string[]
}

export type PlanAction = "create-link" | "already-linked" | "blocked"
export interface SyncPlanOperation {
  id: string
  /** 身份键 = Vault Skill 的 relativePath（唯一）。 */
  skillKey: string
  skillPath?: string
  agentId: string
  action: PlanAction
  targetPath?: string
  linkPath?: string
  link?: LinkOperationPlan
  risks: string[]
  execution: "not-run" | "completed" | "failed" | "skipped"
}
export interface SyncPlan {
  schemaVersion: 1
  mode: "preview-only" | "execution"
  agentId: string
  selectedSkillIds: string[]
  unknownSkillIds: string[]
  operations: SyncPlanOperation[]
  safety: {
    filesystemWrites: "disabled" | "enabled"
    shell: "never"
    windowsExecution: "manual-only" | "automatic"
    note: string
  }
}

export interface WorkspaceSnapshot { config: LoadedConfig; vault: VaultScan; agents: AgentScan[] }
export interface StatusSnapshot {
  schemaVersion: 1
  tool: "skill-manager-web"
  execution: "preview-only"
  config: { path: string; exists: boolean; selectedAgentId?: string; agentCount: number }
  vault: VaultScan
  agents: AgentScan[]
  selectedAgentId?: string
  comparison?: ComparisonResult
  safety: { vault: "read-only"; agents: "read-only-scan"; sync: "preview-only" }
}
