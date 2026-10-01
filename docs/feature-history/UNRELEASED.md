# UNRELEASED — 尚未归档进任何公开版本的用户可见变更

> 滚动文件。每次改变了产品行为的开发工作结束后更新这里；创建公开 Release 时，把属于该版本的内容冻结成 `docs/feature-history/vX.Y.Z.md` 并清空本文件（规则见 [`README.md`](./README.md) 的「维护工作流」与 `PROJECT_MASTER_CONTROL.md`）。

---

## 当前状态（2026-10-02）

```text
Latest public release       = v0.2.4
Rolling content             = 空 —— 上一个周期（Post-v0.2.3 的 15 项实际使用反馈收口）
                              已整体冻结进 docs/feature-history/v0.2.4.md
Still open from v0.2.4      = 两条验收通道没有由自动化环境闭合：原生窗口的指针 / 面板手势、
                              真实在线 AI 调用（原因见 v0.2.4.md 的「已知限制」）
V0 = CLOSED；V1 = ACTIVE；不创建 V1-T07，不关闭 V1
```

用户在上述两处给出的结论，以及任何新的行为改动，从下一条记录开始写进本文件。

---

## 这个版本用户能做什么新事情？

- 暂无。

## 哪些操作方式发生了变化？

- 暂无。

## 哪些旧问题被修复？

- 暂无。

## 兼容性或迁移变化

- 暂无。

## 已知限制

- 暂无。（分发层面的长期事实不在这里重复，见 [`README.md`](./README.md) 的「分发状态的长期事实」。）

---

## 发版时需要做的事

1. 需要发布时**使用新的版本与 tag**（下一个预期版本 `v0.2.5`）；`v0.2.4` 及更早的 tags / 资产保持冻结。发布只在推送新的 `v*` tag 且版本与 `src-tauri/tauri.conf.json` 一致时发生；`workflow_dispatch` 只构建、不发布。发布需要用户单独授权。
2. 发布前补做：release 配置的 Universal 构建 + DMG + `hdiutil verify`，以及本机真实指针 smoke。完整步骤见 [`../release-playbook.md`](../release-playbook.md)。
3. 发布后核对公开 Release 资产与 `.sha256` sidecar，并把事实回写 Release Notes、本目录索引与 `PROJECT_MASTER_CONTROL.md`。
4. 把本文件中属于该版本的内容冻结成 `docs/feature-history/vX.Y.Z.md`，在 `docs/feature-history/README.md` 的索引表加一行，然后**把本文件重置为下一个周期的空模板**。
5. 同步更新 `PROJECT_MASTER_CONTROL.md`、`README.md` 与该轮的 Completion Report。
