# docs 目录

- [`feature-history/`](./feature-history/README.md)：**Feature Update Manual** —— 本产品的自然语言产品历史（每个公开版本一个文件 + `UNRELEASED.md` 滚动文件）。查「某个功能从哪个版本开始能用 / 当时到底验过没有」，从这里开始。
- [`release-playbook.md`](./release-playbook.md)：**发布手册** —— 这个仓库怎么发一个版本（版本字段三处联动、Release Notes 规则、gate 命令、tag 与 workflow、发布后验证与回写、只有用户能做的部分、历史坑）。发版前照着走，不用重新爬记录。
- 本目录其余文件是单次任务的验收报告与交接报告（历史快照，不是产品历史）。
- 项目纪律与当前状态的唯一真相是仓库根目录的 `PROJECT_MASTER_CONTROL.md`。
- 每次改变用户可见行为的开发结束后必须更新 `feature-history/UNRELEASED.md`；创建公开 Release 时冻结成 `feature-history/vX.Y.Z.md` 并更新索引。
