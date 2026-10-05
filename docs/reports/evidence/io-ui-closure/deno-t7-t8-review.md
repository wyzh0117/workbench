# 独立 Deno T7/T8 复核

审查对象：codex/io-ui-closure-20261006 工作树 HEAD 955ec91 与当前未提交 Deno 实现。复核日期：2026-10-06。这里只记录本人检查和故障注入，不把其他执行者的 UI 或完整 gate 结果记作自己的验证。

## OPEN → FIXED：导入失败回滚不得删除唯一恢复备份

**原问题（OPEN，已实际复现）**：confirmImport 捕获错误后调用 removeImportStaging；先前该清理会删掉 commitImportAssets 已标记为“保留恢复文件”的 transaction 目录。另一个窗口是当前素材已移到 backup-N 后新文件提升失败，当前备份恢复也失败；由于该 asset 尚未加入 promoted 列表，旧备份不会进入统一 rollback 清单。

**原始红证据**：runs/deno-review-import-rollback-red.log。双故障（后续素材提升失败、先前已提升目标的回滚删除失败）后，首个目标保留新字节 [7,8,9]，原字节 [1,2,3] 的 backup 不存在，transaction staging entries 为 []，但错误仍声称恢复文件保留。

**修复位置**：src/service/import_export.ts 的 ImportAssetTransaction.preserve_recovery_files、removeImportStaging()、commitImportAssets()。当前素材备份恢复失败和 promoted rollback error 都置 preserve_recovery_files；外层确认失败仍会调用清理 helper，但 helper 尊重该标志并保留整个唯一恢复目录。

**独立绿证据**：runs/deno-review-import-rollback-green.log。直接对当前 service 运行了两个故障注入场景：

- 后续提升失败 + 已提升目标删除失败：目标仍为 [7,8,9]，backup-0 仍是 [1,2,3]，SHA-256 为 039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81，Canonical asset 列表未变，未创建 project.json。
- 当前素材提升失败 + 当前备份恢复失败：目标暂时不存在，backup-0 仍是 [1,2,3] 且 SHA 相同；Canonical asset 列表未变，未创建 project.json。

两条错误均向调用者抛出，唯一恢复副本实际保留。测试临时目录在断言后清理，未留下用户项目内容。Deno owner 的 focused log 为 runs/deno-import-rollback-preserve-green.log，本报告采用上面的独立日志作为验收证据。

**限定**：CommandBus.execute() 对普通 Error 的默认映射仍是 command_failed、空 details 和通用 user message；恢复路径只在 technical message / 私有诊断日志中。备份保留修复已关闭数据丢失 finding，但这次没有验证 UI 是否提供人工恢复该隐藏 transaction 的操作。

## OPEN → FIXED：服务关闭与尚未登记的预览预约竞态

**实际复现**：import.preview 先等待 reserveImportPreview()；reserve 在 desktop.ts:3270-3311 先 await pruneImportPreviews()，之后才把 slot 放进 map。DesktopService.close() 在 desktop.ts:3464-3473 只取消并 drain map 中已有的 slots，没有 closed 标记。故 close 可以在 reservation 等 prune 时完整返回，reservation 随后继续创建临时来源目录并成功返回 preview。

复现脚本用 barrier 暂停 prune，等待调用已进入 reserve 后先运行 close()，再释放 barrier。runs/deno-review-preview-close-race-red.log 的结果为 reproduced:true：close 已先完成，preview 仍成功，close 后 map 中仍有 slot，owned acw-import-preview-* 目录仍存在。脚本在退出前主动释放该 slot 和临时目录。

**修复位置**：`src/service/desktop.ts` 的 `reserveImportPreview()` 在 `await pruneImportPreviews()` 后再次调用 `assertServiceOpen()`；`close()` 先设置 `closing = true`、关闭 command bus，再 drain 已登记 slot。因此等待 prune 的 reservation 在 close 后恢复时拒绝，尚未 materialize inline bytes 或登记 slot。

**独立绿证据**：`runs/deno-review-preview-close-race-green.log`。重放同一 barrier 顺序（preview 等待 prune → close 完成 → 放行 prune）后，`preview_rejected_after_close:true`、slot 保留为 false；独立包裹 `Deno.makeTempDir` 计数确认 `acw-import-preview-*` 来源目录创建数为 0、残留目录数为 0。owner focused test 也通过：`runs/deno-import-preview-close-race-green.log`。原红证据仍为 `runs/deno-review-preview-close-race-red.log`。

旧的已登记 preview 关闭、TTL、显式 release、失败清理由原生命周期测试继续覆盖；本 finding 的独立检查具体覆盖了此前缺失的等待 prune 预约交错和 owned inline-source 创建边界。

## 其余 T7/T8 核对

- asset.preview_batch 在一个 batch 内只读/解析一次 Canonical、校验 project id/fingerprint；至多 8 个 id、每项最多 8 MiB、decoded raw 总预算 16 MiB；预算外返回 deferred，单项错误隔离。打开文件在每项 finally 关闭；打开前后检查 file identity，并按实际字节核 SHA-256。tests/asset_preview_batch_test.ts 覆盖同一项目下可用项、缺失项、校验失败、越界路径、预算 deferred 和 stale fingerprint。
- Import preview 对象上限为 8、TTL 15 分钟。显式 release 会 abort active operation 并等待完成后清理归属的 inline-source 临时目录；超时清理、service close 和失败路径走同一 disposeImportPreview()。readSourceSnapshot() 在 finally 关闭文件；临时来源写入也在 finally 关闭句柄。上节指出 close 和尚未登记预约的竞态是剩余例外。
- Export 媒体文件用 1 MiB chunk 和全局 2 个 active stream 槽；取消/释放在 finally 释放槽，读源句柄也在 finally 关闭。descriptor 下载使用完/取消/close 都经 finish 关闭已打开文件并释放槽；资源目录只由 export slot 自己删除。
- 多文件导出提交失败会按 installed/backedUp 清单反向回滚。回滚不完整时 writeOutput() 返回 export_commit_uncertain、commit_state 为 outcome_uncertain、retryable:false、backup_preserved:true，并故意跳过删除 staging，故 .acw-export-*.tmp/backups 留给核查；正常完成或完全回滚才删 transaction。现有 late export promotion failure restores every preexisting target 覆盖后段提升失败时完整恢复旧多文件结果。
- 未发现 import preview release、TTL、export slot close 或 T8 streaming rollback 会清理 Canonical 备份目录的调用路径；它们各自只清理自己的临时目录。
