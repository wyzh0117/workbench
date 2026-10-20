# UNRELEASED — 尚未归档进任何公开版本的用户可见变更

> 滚动文件。每次改变了产品行为的开发工作结束后更新这里；创建公开 Release 时，把属于该版本的内容冻结成 `docs/feature-history/vX.Y.Z.md` 并清空本文件（规则见 [`README.md`](./README.md) 的「维护工作流」与 `PROJECT_MASTER_CONTROL.md`）。

---

## 当前状态（2026-10-21）

```text
Latest public release       = v0.2.7，已发布并冻结
Release/tag/source          = [v0.2.7](https://github.com/wyzh0117/workbench/releases/tag/v0.2.7) / fb050b121c2014ac3226e90d3683b7c6c26391b0
Rolling content             = v3.0.0 候选已实现；验收含 PARTIAL / UNVERIFIED，尚无 tag 或 Release
Previous release            = v0.2.7，tag / DMG / sidecar 保持冻结
V0 = CLOSED；V1 = ACTIVE；V1-T01–T06 保留原 VERIFIED；不创建 V1-T07，不关闭 V1
```

已发布版本仍以 [v0.2.7 feature history](./v0.2.7.md) 为准；v3.0.0 候选代码已实现，见 [v3.0.0 草稿](./v3.0.0.md)。32 项验收矩阵仍有 PARTIAL / UNVERIFIED，CI build-only 与发布授权也未完成；该草稿不是发布记录。

## 当前循环

v3.0.0 候选包含统一课程工作区、与布局状态分离的课程完成状态、按用户所选课程资料规划并审阅案例/视频来源、显式采纳/引用/同事件来源合并、人工确认视频片段时间，以及 PowerPoint 风格提取、AI/手动单页草稿和副本导出。搜索密钥与 AI 凭据分离。

第一次本地 `.app` build 未显式指定签名身份，`codesign --verify --deep --strict` 因资源封印错误失败。按 release workflow 的 `APPLE_SIGNING_IDENTITY='-'` 重建后 strict verification 通过；这是无 Team ID 的 ad-hoc 签名，不是 Developer ID 签名或公证。对应 ARM64 DMG 的 `hdiutil verify` 通过；第一次 sandbox DMG 尝试因 `hdiutil: Device not configured` 失败，受控重跑未改打包选项并通过。release workflow 已要求资产整理前 strict app verification；Universal macOS 和 Windows build-only CI 结果仍待完成。真实 PowerPoint 无 Repair/编辑/保存重开、第二份真实课件、真实搜索与 AI 推理、150%/200% 文字缩放仍未验证；性能验收为 PARTIAL。具体状态与证据见 [v3.0.0 草稿](./v3.0.0.md)、[32 项验收记录](../v3.0.0-acceptance.md) 和 [UI/性能证据](../acceptance/v3.0.0/README.md)。

## 下一个开发周期

本节目前为空。新的用户可见行为完成后，从这里开始记载；不要改写已发布版本的说明或 assets。

---

## 维护约定

- 只记录已经实现的用户可见行为，并连到对应的验收证据；没有证据的地方明确写明未测或无记录。
- 每次创建公开 Release 时，先将本文件中属于该版本的内容冻结到 `docs/feature-history/vX.Y.Z.md`，更新 `docs/feature-history/README.md` 与项目总控，再将本文件重置为本模板。
- 已发布的 tag、DMG 与校验 sidecar 永久冻结；后续修复使用新的版本。
