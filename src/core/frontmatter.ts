import type { Frontmatter } from "./types.ts"

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1)
  return trimmed
}

/** Safe scalar-only frontmatter parser; it never evaluates YAML. */
export function parseFrontmatter(markdown: string): Frontmatter {
  const lines = markdown.replace(/^\uFEFF/u, "").split(/\r?\n/u)
  if (lines[0]?.trim() !== "---") return { present: false, raw: "", fields: {}, errors: ["frontmatter-missing"] }
  const closing = lines.findIndex((line, index) => index > 0 && ["---", "..."].includes(line.trim()))
  if (closing < 0) return { present: true, raw: lines.slice(1).join("\n"), fields: {}, errors: ["frontmatter-malformed"] }
  const fields: Record<string, string> = {}
  const errors: string[] = []
  let multilineKey: string | undefined
  let multiline: string[] = []
  const flush = () => { if (multilineKey) fields[multilineKey] = multiline.join(" ").trim(); multilineKey = undefined; multiline = [] }
  for (const line of lines.slice(1, closing)) {
    if (multilineKey) {
      if (/^\s/u.test(line) || line.trim() === "") { multiline.push(line.trim().replace(/^[-]\s*/u, "")); continue }
      flush()
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/u)
    if (!match) { errors.push(`malformed frontmatter line: ${trimmed}`); continue }
    const key = match[1]!
    const value = match[2] ?? ""
    if (Object.hasOwn(fields, key)) { errors.push(`duplicate frontmatter field: ${key}`); continue }
    if (value === "|" || value === ">" || value === "") { multilineKey = key; multiline = [] } else fields[key] = unquote(value)
  }
  flush()
  const name = fields.name?.trim() || undefined
  const description = fields.description?.trim() || undefined
  return { present: true, raw: lines.slice(1, closing).join("\n"), fields, name, description, errors }
}
