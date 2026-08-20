import type { Frontmatter } from "./types.ts"

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1)
  return trimmed
}

const KEY_LINE = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/u
const BLOCK_MARKERS = new Set(["|", ">", "|-", ">-", "|+", ">+"])

/**
 * 宽松 frontmatter 解析（以 wsl-symlink-manager 的 link.rs::frontmatter_name 语义为准）：
 * 有效性只由 name 字段决定（缺失 = 缺少 name）；description 仅尽力提取，供展示与搜索，
 * 任何解析问题都不产生错误。frontmatter 缺失/未闭合 = 没有 name。
 */
export function parseFrontmatter(markdown: string): Frontmatter {
  const lines = markdown.replace(/^\uFEFF/u, "").split(/\r?\n/u)
  if (lines[0]?.trim() !== "---") return { present: false, raw: "", fields: {}, errors: [] }
  const closing = lines.findIndex((line, index) => index > 0 && ["---", "..."].includes(line.trim()))
  if (closing < 0) return { present: false, raw: "", fields: {}, errors: [] }
  const block = lines.slice(1, closing)
  const fields: Record<string, string> = {}
  let name: string | undefined
  let description: string | undefined
  for (let index = 0; index < block.length; index += 1) {
    const line = block[index]!
    if (!line.trim() || line.trim().startsWith("#")) continue
    const match = KEY_LINE.exec(line)
    if (!match) continue
    const key = match[1]!
    const rawValue = match[2]!
    const collectValue = (): string => {
      if (rawValue !== "" && !BLOCK_MARKERS.has(rawValue)) return unquote(rawValue)
      const collected: string[] = []
      for (let next = index + 1; next < block.length; next += 1) {
        const rest = block[next]!
        if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/u.test(rest)) break
        if (rest.trim() === "" || /^\s/u.test(rest)) { collected.push(rest.trim().replace(/^-\s*/u, "")); continue }
        break
      }
      return unquote(collected.join(" "))
    }
    if (key === "name" && !name) {
      const value = collectValue()
      if (value) { name = value; fields[key] = value }
      continue
    }
    if (key === "description" && !description) {
      const value = collectValue()
      if (value) { description = value; fields[key] = value }
      continue
    }
    if (!Object.hasOwn(fields, key)) {
      const value = collectValue()
      if (value) fields[key] = value
    }
  }
  return { present: true, raw: block.join("\n"), fields, name, description, errors: [] }
}