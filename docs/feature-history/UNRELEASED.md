# 滚动开发记录 — 用户可见变更

> 滚动文件。每次改变了产品行为的开发工作结束后更新这里；创建公开 Release 时，把属于该版本的内容冻结成 `docs/feature-history/vX.Y.Z.md` 并清空本文件（规则见 [`README.md`](./README.md) 的「维护工作流」与 `PROJECT_MASTER_CONTROL.md`）。

---

## v3.1.1 补丁快照（2026-10-26）

本快照记录 Windows NSIS 安装器与卸载器的四格品牌图标配置，详情见 [`v3.1.1 feature history`](./v3.1.1.md)。实际发布状态、tag、CI 结果与 Windows 产物验证以 [稳定 Release 页面](https://github.com/wyzh0117/workbench/releases/tag/v3.1.1) 为准；本文件不预告 CI 结果。

## v3.1.0 版本记录（2026-10-26）

```text
Version snapshot            = v3.1.0; see v3.1.0.md
Stable release reference    = https://github.com/wyzh0117/workbench/releases/tag/v3.1.0
Source validation           = Deno 778 passed / 0 failed; Rust 304 passed / 0 failed / 2 ignored
Known unverified workflow   = live model extraction and provider-backed discovery; details in v3.1.0.md
```

v3.0.2 于 2026-10-24（+0800）发布，内容已全部冻结进 [`v3.0.2.md`](./v3.0.2.md)（唯一用户可见变化：全站 UI 整改，视觉体系统一，**无功能变更**）。

**发布后补记（2026-10-24 已回填）：**

1. ✅ tag `v3.0.2`（tag 对象 `a7fefd24f467ffa2022af35f7ea7cb9590ad5ffb`）与源码提交 `cb581044f635d7f4129ea1217cc36ad62d4223af` → 已回填三元组、[`README.md`](./README.md) 索引表与 [`v3.0.2.md`](./v3.0.2.md) 头部及「发布记录」。
2. ✅ 公开 Release [v3.0.2](https://github.com/wyzh0117/workbench/releases/tag/v3.0.2)（2026-10-24 20:34 +0800，非 draft、非 prerelease），workflow run [#40093875084](https://github.com/wyzh0117/workbench/actions/runs/40093875084) 结论 `success`。
3. ✅ 公开安装包校验**全部完成**：两个安装包均匿名下载并重算哈希，`shasum -c` 对下载到的 sidecar 均 OK；`hdiutil verify` 报 VALID；包内版本 3.0.2、架构 `x86_64 arm64`、ad-hoc 签名未公证（`spctl` rejected，与 workflow 判定一致）。详见 [`v3.0.2.md`](./v3.0.2.md)「发布记录」。
4. ✅ [`.github/release-notes/v3.0.2.md`](../../.github/release-notes/v3.0.2.md) 的 `## Release verification` 段已写入并同步到公开正文。

## v3.1.0 实现与验收

v3.1.0 的用户可见变更、已完成验证和限制见 [`v3.1.0.md`](./v3.1.0.md)，状态入口见 [`acceptance status`](../acceptance/v3.1.0/README.md)。本版包含课程文档驱动素材发现、右侧阅读区和四格品牌图标；草图文案映射记录在 [202 条审计](../research/ui-copy-audit-v3.1.0.md)。真实模型提取与 Brave/YouTube 搜索，以及 Windows/macOS 系统表面图标验收仍未完成，原因和解决方案见版本记录。

最终 Deno/Rust 全套检查归档在 [`final-validation`](../acceptance/v3.1.0/final-validation/README.md)。真实发布状态、源代码提交/tag、workflow 结果、公开资产与 SHA-256 见 [稳定发布页](https://github.com/wyzh0117/workbench/releases/tag/v3.1.0) 和最终 HTML 报告。

## 下一个开发周期

后续版本的用户可见变更继续记录在本文件；已发布版本的说明与 assets 保持冻结。

---

## 维护约定

- 只记录已经实现的用户可见行为，并连到对应的验收证据；没有证据的地方明确写明未测或无记录。
- 每次创建公开 Release 时，先将本文件中属于该版本的内容冻结到 `docs/feature-history/vX.Y.Z.md`，更新 `docs/feature-history/README.md` 与项目总控，再将本文件重置为本模板。
- 已发布的 tag、DMG 与校验 sidecar 永久冻结；后续修复使用新的版本。
