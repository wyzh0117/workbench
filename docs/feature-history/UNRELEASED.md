# UNRELEASED — 尚未归档进任何公开版本的用户可见变更

> 滚动文件。每次改变了产品行为的开发工作结束后更新这里；创建公开 Release 时，把属于该版本的内容冻结成 `docs/feature-history/vX.Y.Z.md` 并清空本文件（规则见 [`README.md`](./README.md) 的「维护工作流」与 `PROJECT_MASTER_CONTROL.md`）。

---

## 当前状态（2026-10-24）

```text
Latest public release       = [v3.0.2](https://github.com/wyzh0117/workbench/releases/tag/v3.0.2)，已发布并冻结
Release/tag/source          = v3.0.2 / a7fefd24f467ffa2022af35f7ea7cb9590ad5ffb / cb581044f635d7f4129ea1217cc36ad62d4223af
Rolling content             = 无；v3.0.2 用户可见变更已冻结到 v3.0.2.md
Previous release            = [v3.0.1](https://github.com/wyzh0117/workbench/releases/tag/v3.0.1)，tag / 资产保持冻结
V0 = CLOSED；V1 = ACTIVE；V1-T01–T06 保留原 VERIFIED；不创建 V1-T07，不关闭 V1
```

v3.0.2 于 2026-10-24（+0800）发布，内容已全部冻结进 [`v3.0.2.md`](./v3.0.2.md)（唯一用户可见变化：全站 UI 整改，视觉体系统一，**无功能变更**）。

**发布后补记（2026-10-24 已回填）：**

1. ✅ tag `v3.0.2`（tag 对象 `a7fefd24f467ffa2022af35f7ea7cb9590ad5ffb`）与源码提交 `cb581044f635d7f4129ea1217cc36ad62d4223af` → 已回填三元组、[`README.md`](./README.md) 索引表与 [`v3.0.2.md`](./v3.0.2.md) 头部及「发布记录」。
2. ✅ 公开 Release [v3.0.2](https://github.com/wyzh0117/workbench/releases/tag/v3.0.2)（2026-10-24 20:34 +0800，非 draft、非 prerelease），workflow run [#40093875084](https://github.com/wyzh0117/workbench/actions/runs/40093875084) 结论 `success`。
3. ✅ 公开安装包校验**全部完成**：两个安装包均匿名下载并重算哈希，`shasum -c` 对下载到的 sidecar 均 OK；`hdiutil verify` 报 VALID；包内版本 3.0.2、架构 `x86_64 arm64`、ad-hoc 签名未公证（`spctl` rejected，与 workflow 判定一致）。详见 [`v3.0.2.md`](./v3.0.2.md)「发布记录」。
4. ✅ [`.github/release-notes/v3.0.2.md`](../../.github/release-notes/v3.0.2.md) 的 `## Release verification` 段已写入并同步到公开正文。

## 下一个开发周期

当前没有未归档的用户可见变更。下一项用户可见变更完成后，从这里开始记载；不要改写已发布版本的说明或 assets。

---

## 维护约定

- 只记录已经实现的用户可见行为，并连到对应的验收证据；没有证据的地方明确写明未测或无记录。
- 每次创建公开 Release 时，先将本文件中属于该版本的内容冻结到 `docs/feature-history/vX.Y.Z.md`，更新 `docs/feature-history/README.md` 与项目总控，再将本文件重置为本模板。
- 已发布的 tag、DMG 与校验 sidecar 永久冻结；后续修复使用新的版本。
