# UNRELEASED — 尚未归档进任何公开版本的用户可见变更

> 滚动文件。每次改变了产品行为的开发工作结束后更新这里；创建公开 Release 时，把属于该版本的内容冻结成 `docs/feature-history/vX.Y.Z.md` 并清空本文件（规则见 [`README.md`](./README.md) 的「维护工作流」与 `PROJECT_MASTER_CONTROL.md`）。

---

## 当前状态（2026-10-06）

```text
Latest public release       = v0.2.6，已发布、匿名下载和公开资产校验通过
Release/tag/source          = [v0.2.6](https://github.com/wyzh0117/workbench/releases/tag/v0.2.6) / 223a5944e50ffdc6f4bdd09509eacf8f09c47b0e
Rolling content             = 本地 File I/O / UI 收尾改动尚未归档或发布
Previous release            = v0.2.5，tag / DMG / sidecar 保持冻结
V0 = CLOSED；V1 = ACTIVE；V1-T01–T06 保留原 VERIFIED；不创建 V1-T07，不关闭 V1
```

v0.2.6 功能与验收记录已归档到 [中文 feature history](./v0.2.6.md)。公开资产、校验和与签名状态见 [public release verification](../reports/evidence/v0.2.6/public-release-verification.md)，逐项行为和未闭合限制见 [HTML completion report](../reports/v0.2.6-ui-redesign-completion-report.html)。

## 本地未发布工作（2026-10-06）

最终合并 Deno source pin 为 `50aaea7268164b9fa066425ce4a5ac158ca87352`：`deno task check` exit 0、完整测试 716/0、bound-save focused 17/17。Native10 runtime UI pin 是 `9bbc8cf3067b6117be8de41e1bd5bef3960a671a`；Rust pin `fcefcb106c2cf4e957d54a1ee7e112e2aa83cac0` 为 258/0/1 ignored。Final10 arm64 QA ZIP 为 7,082,849 B，SHA-256 `bb3413a4f4f8d7658e69f5e523da514aca034e32f241e2bdc09fe425fadd3822`；独立审计确认签名有效，18 项嵌入资源中 17 项字节精确匹配，`index.html` 经路径/索引规范化核对。它是未发布 QA 包。Deno-only source commit 未更改 Native app/Rust payload。

Native10 真实冷重开将已保存阅读区 `scroll_top=836` 恢复，Canonical/session 字节未变；`selected_block_id=null`，不主张光标位置恢复。被正文引用的 PNG 已真实执行改名→Undo→Redo→Undo 四态，asset ID、checksum、引用计数和物理字节符合预期。Final9 的 N04 对同一 S01-01 fixture 完成 Semantic HTML、Static Web、PDF、PPTX 四种 UI 导出及物理核验；N05 同字段显式 Keep Local 和异字段无冲突自动合并均有 UI/物理证据，Keep Local 另有重开证据。保存中继续编辑时的点击时快照冻结及 A→B→A 迟到响应仍未观察，复合 N06 仍 PARTIAL。

Native recovery 有 Final5/Final6 定向闭环：Keep Disk 保持旧 Canonical；Recovery Restore 先保存与旧 Canonical 深比较一致的备份后写入恢复内容；0555 快照目录下失败保留选择，改回可写后重试成功；两条恢复结果 Domain 校验为 0，活动 `recovery.json` 不存在。Recovery Restore 的 `recovery.bak` 保留为历史写入备份，不是活动恢复日志。Final6 还验证 epoch-ms 快照时间正确显示、恢复项目重开不再弹提示，且两份 Canonical 与重开前一致。物理证据见 `runs/native-final5-history-keepdisk-physical-proof.json`、`runs/native-final5-history-restore-physical-proof.json` 与 `runs/native-final6-history-after-reopen-metadata.json`。

N01 Final6 UI 记录 62 次编辑、约 91.6 秒，保存后关闭窗口并从 Launcher 继续工作；应用进程未退出，不称冷启动。后续物理扫描确认 62 个 marker 都在 Canonical。Final6 命名快照定向子项输入名称并确认，备注留空；UI 新增版本行，物理检查确认单个 72,533 B JSON envelope 与 Canonical row 的 ID/名称/项目 ID/时间戳匹配，Domain issues 为 0。早期 AX setValue 与未完成弹窗观测已 supersede。N06 仍是复合 PARTIAL：保存进行中继续编辑时的点击时快照冻结，以及 A→B→A 迟到响应没有真实 UI 观察；Final10 的物理改名 Undo/Redo 和阅读位置冷重开已作为独立定向子项通过。


Native9 冷重开阅读区回顶是历史真实失败记录；source `9bbc8cf` 增加当前渲染 `.center` 的身份绑定捕获/恢复。Final10 冷重开以非零 `scroll_top=836` 通过；旧失败不删除。对应 Final10 session 与截图证据见 `runs/native-final10/center-scroll-*`。
Browser 16×4 默认视图 64 行与 42 个适用 1024 侧栏组合是 `b990d49` 下的历史 OBSERVED 几何记录，不是当前整体 PASS；历史 P13×1280 JPEG 实为 1024×900，Root 在 `11232c2` 另完成匹配 1280×900 的定向观察。Native Final6 106 条布局记录是历史观察。Final7 的 legacy 日期由 AX 确认、Board Cmd+Right 末列可达、Mapping 20 状态变化均为定向结果；Native7 首次脏编辑 pointer Save Version 失败与 marker 截断也保留历史记录。985 修复经 54 focused tests 和独立 review；Final8 首指针快照 proof 与 Final9 Native9 N05/N04 结果分别保留各自来源。Final9 N05 同字段 Keep Local 与 distinct-field 自动合并都有物理证据，Keep Local 重开后也另有物理证明；两路径不表示 O09 全矩阵通过。

实际门槛仍分开记录：真实应用/浏览器的 150%/200% 文字缩放未运行；§8.3 接受真实浏览器页面 zoom、应用文字缩放或 OS 设置并要求分别记录，CSS 仿真不能替代。当前 IAB 没有 PageZoom 控件，Native View 菜单仅观察到全屏项，仍需确认真实可用入口；Native 历史截图达到 1728 像素宽，逻辑/CSS viewport 未测；Native 页面矩阵仍在补录。macOS reduced-motion 当前观察为 OFF，等待用户授权后才切换并检查行为。Main process 仅有单点 RSS 29,536 KB；WebKit 总量、解码图片内存与对象 URL 留存未测。没有真实 AI 账户凭据、用户真实课程、公开 tag/Release 或覆盖安装。

最终 Deno 配对使用同一 runner/fixture，source 为 dfcb archive 与 `50aaea`；raw samples 和口径见 `runs/deno-final-50aaea7f/summary.json`（SHA-256 `3ad9be205efbacd30e4807d78291468b07b48e322d2c6c0c0c5398fa6c486a5f`）。未插桩 changed median +1.41%、nearest-rank p95 −7.70%；插桩 changed median +3.11%、p95 +21.12%，10 个样本的尾部回退尚未定位，因此性能结论为 PARTIAL/BLOCKED。no-op 两组读到 Canonical 但 Canonical/recovery/journal/backup 无写：未插桩 median/p95 −62.85%/−63.54%，插桩 −61.32%/−61.21%。插桩计数是逻辑 API 计数，不是设备级物理写放大；off 组计数为 null。RSS、物理放大和进程内峰值未测。

Native warm pair 是独立 debug backend，不与 Deno 或 GUI/IPC 横向比较：changed 3.030287→2.809134 s（−7.30%），p95 3.062217→2.825630 s；no-op 3.036862→0.859863 s（−71.69%），p95 3.322058→0.868051 s。整体验收保持 PARTIAL；公开 v0.2.6 与 V1 状态不变。

证据： [File I/O / UI 验收报告](../reports/io-ui-closure-completion-report.html)、[需求状态](../reports/evidence/io-ui-closure/requirements.json)、[页面矩阵](../reports/evidence/io-ui-closure/ui-matrix.json)、[指标](../reports/evidence/io-ui-closure/metrics.json)、[九类夹具清单](../reports/evidence/io-ui-closure/fixture-manifest.json)、[证据来源索引](../reports/evidence/io-ui-closure/artifacts.json)。本地验收仍为 PARTIAL；公开版本维持 v0.2.6，V1 ACTIVE，不创建 V1-T07，也没有发布授权。

## 下一个开发周期

本节目前为空。新的用户可见行为完成后，从这里开始记载；不要改写已发布版本的说明或 assets。

---

## 维护约定

- 只记录已经实现的用户可见行为，并连到对应的验收证据；没有证据的地方明确写明未测或无记录。
- 每次创建公开 Release 时，先将本文件中属于该版本的内容冻结到 `docs/feature-history/vX.Y.Z.md`，更新 `docs/feature-history/README.md` 与项目总控，再将本文件重置为本模板。
- 已发布的 tag、DMG 与校验 sidecar 永久冻结；后续修复使用新的版本。
