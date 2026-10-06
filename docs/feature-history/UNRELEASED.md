# UNRELEASED — 尚未归档进任何公开版本的用户可见变更

> 滚动文件。每次改变了产品行为的开发工作结束后更新这里；创建公开 Release 时，把属于该版本的内容冻结成 `docs/feature-history/vX.Y.Z.md` 并清空本文件（规则见 [`README.md`](./README.md) 的「维护工作流」与 `PROJECT_MASTER_CONTROL.md`）。

---

## 当前状态（2026-10-07）

```text
Latest public release       = v0.2.7，已发布并冻结
Release/tag/source          = [v0.2.7](https://github.com/wyzh0117/workbench/releases/tag/v0.2.7) / fb050b121c2014ac3226e90d3683b7c6c26391b0
Rolling content             = 空；v0.2.7 已归档到 [feature history](./v0.2.7.md)
Previous release            = v0.2.6，tag / DMG / sidecar 保持冻结
V0 = CLOSED；V1 = ACTIVE；V1-T01–T06 保留原 VERIFIED；不创建 V1-T07，不关闭 V1
```

本周期的用户可见变化、公开资产与验收限制已归档到 [v0.2.7 feature history](./v0.2.7.md)。尚未完成的验收与性能限制仍保持 PARTIAL，归档不表示它们已闭合。

## 当前循环

目前没有超出 v0.2.7 归档的新用户可见变更。File I/O / UI 收尾的剩余实测和性能尾部限制见 [v0.2.7](./v0.2.7.md)、总控 §48 与 [HTML completion report](../reports/io-ui-closure-completion-report.html)。后续修复使用新版本，不改写已发布 tag 或资产。

## 下一个开发周期

本节目前为空。新的用户可见行为完成后，从这里开始记载；不要改写已发布版本的说明或 assets。

---

## 维护约定

- 只记录已经实现的用户可见行为，并连到对应的验收证据；没有证据的地方明确写明未测或无记录。
- 每次创建公开 Release 时，先将本文件中属于该版本的内容冻结到 `docs/feature-history/vX.Y.Z.md`，更新 `docs/feature-history/README.md` 与项目总控，再将本文件重置为本模板。
- 已发布的 tag、DMG 与校验 sidecar 永久冻结；后续修复使用新的版本。
