# Skill Vault — Neutral Graphite UI Reference

This is a **visual/structural reference implementation**, not a finished product specification. A development agent should reuse the layout system, density, hierarchy, and design tokens while wiring the real application data and actions.

## Hard constraints

1. The default desktop shell is three columns:
   - left: Agent / comparison target navigation
   - center: primary Skill tree-table workspace
   - right: selected Skill inspector / comparison details
2. The center tree-table is the visual priority. It should resemble a desktop developer tool, not a SaaS dashboard.
3. The Skill hierarchy lives inside the first table column. Child checkboxes must indent with the tree branch; they are **not** a separate fixed checkbox column.
4. Collections use a folder icon. Do not use decorative diamonds, sparkles, hexagons, or unexplained brand-like glyphs for tree items.
5. Checkboxes are intentionally small (~9px visual box); status dots are ~5px. Row height is ~23px.
6. Compare mode is semantically **Repository baseline vs selected Agent**. The UI must distinguish:
   - matched / present in both
   - missing from Agent
   - extra in Agent only
   - present in both but changed
7. No bottom detail drawer. Details live in the right inspector.

## Color language

Use neutral graphite / charcoal gray. Do **not** tint the surfaces blue.

- app background: `#161616`
- chrome: `#1b1b1b`
- panels: `#1e1e1e`, `#222222`, `#262626`
- hover: `#272727`
- selected row: `#303030`
- borders: `#2d2d2d` to `#383838`
- main text: `#d6d6d6`
- muted text: `#858585`

Semantic colors only:
- green = matched/valid
- amber = extra/warning
- red = missing/error

Do not use blue for panel backgrounds, selected rows, nav tabs, focus rings, or primary buttons in the default theme.

## Center tree-table anatomy

Parent collection row:

`chevron → small checkbox → folder icon → collection name → count badge → path`

Child skill row:

`tree branch → indented small checkbox → semantic status dot → skill name → path`

The entire first cell must read as one continuous hierarchy. The checkbox follows the indentation.

Recommended columns:

`Skill / path | Compare | Repository | Agent | Frontmatter | Link | Actions`

The Compare column should use short labels such as:

- `一致`
- `Agent 缺失`
- `Agent 额外`
- `有差异`

## Compare context

Above the table, make the active comparison explicit:

`Baseline: Vault repository  ↔  Target: WSL Agent`

Show a compact summary nearby, for example:

`29 shared · 4 missing · 2 extra · 3 changed`

This is more important than generic dashboard statistics because it explains what the current table actually means.

## UX character

Think:

- VS Code / desktop developer tooling
- compact, low-chrome, high information density
- thin borders and subtle gray value changes
- small radii (2–4px)
- almost no shadow
- no giant cards
- no gradients
- no glassmorphism
- no decorative hero treatment

The center workspace should feel like a serious file/skill management tool, not a marketing or admin dashboard.
