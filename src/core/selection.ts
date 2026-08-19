export function normalizeSearch(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("en-US").trim() }
export function toggleSelection(selectedIds: string[], id: string): string[] { return selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id] }
export function moveIndex(current: number, delta: number, count: number): number {
  if (count === 0) return -1
  if (current < 0) return delta > 0 ? 0 : count - 1
  return Math.max(0, Math.min(count - 1, current + delta))
}
export function searchText(values: string[], query: string): boolean { const normalized = normalizeSearch(query); return !normalized || normalizeSearch(values.join(" ")).includes(normalized) }
