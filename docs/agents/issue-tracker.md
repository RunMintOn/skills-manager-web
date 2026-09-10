# Issue tracker: Local Markdown

规格和任务记录在 `.scratch/` 下的 Markdown 文件中。

## Conventions

- 每个功能使用一个目录：`.scratch/<feature-slug>/`。
- 规格文件为 `.scratch/<feature-slug>/spec.md`。
- 任务文件为 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`。
- 任务按依赖顺序编号，从 `01` 开始。
- 任务状态使用 `Status:` 行记录。
- 讨论追加在文件底部的 `## Comments` 下。
