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

**限定**：原来的“恢复路径只在 technical message / 私有诊断日志中”对这类恢复失败不再成立。owner 将双故障明确转换为 `ServiceError(import_rollback_incomplete)`，而 `asErrorObject()` 保留其 details；普通未知 `Error` 的通用兜底映射仍然没有恢复路径字段。UI 没有自动恢复这个 transaction 的操作，本次只核实了安全保留与调用者可见提示，没有恢复隐藏 staging 的 UI。

**独立 CommandBus envelope 复核**：`runs/deno-review-import-command-envelope-green.log` 通过真实 `DesktopService.commands.execute("import.confirm")` 注入同一类双 `Deno.rename` 故障。外层返回 `import_rollback_incomplete`，details 保留 `stage=restore_current_backup`、`commit_state=outcome_uncertain`、`retryable=false`、`backup_preserved=true` 与项目相对 `recovery_path`；user message 提示先检查恢复目录并不要直接重试。`backup-1` 的 `[4,5,6]` 在 `desktop.close()` 前后相同，SHA-256 `787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472`。这验证的是真实 CommandBus failure envelope 与 close 后保留；不代表 UI 已实现人工恢复。

## OPEN → FIXED：服务关闭与尚未登记的预览预约竞态

**实际复现**：import.preview 先等待 `reserveImportPreview()`；reservation 在 `src/service/desktop.ts:3337-3381` 先 await prune，再登记 slot。旧版 `close()` 只 drain 已登记 slot，且没有关闭状态检查，故 close 可在 reservation 等 prune 时返回，reservation 随后仍创建临时来源目录并返回 preview。

复现脚本用 barrier 暂停 prune，等待调用已进入 reserve 后先运行 close()，再释放 barrier。runs/deno-review-preview-close-race-red.log 的结果为 reproduced:true：close 已先完成，preview 仍成功，close 后 map 中仍有 slot，owned acw-import-preview-* 目录仍存在。脚本在退出前主动释放该 slot 和临时目录。

**修复位置**：`src/service/desktop.ts:3337-3381` 的 `reserveImportPreview()` 在 `await pruneImportPreviews()` 后再次调用 `assertServiceOpen()`；`close()` (`:3533-3557`) 先设置 `closing = true`、关闭 command bus，再 drain 已登记 slot。因此等待 prune 的 reservation 在 close 后恢复时拒绝，尚未 materialize inline bytes 或登记 slot。

**独立绿证据**：`runs/deno-review-preview-close-race-green.log`。重放同一 barrier 顺序（preview 等待 prune → close 完成 → 放行 prune）后，`preview_rejected_after_close:true`、slot 保留为 false；独立包裹 `Deno.makeTempDir` 计数确认 `acw-import-preview-*` 来源目录创建数为 0、残留目录数为 0。owner focused test 也通过：`runs/deno-import-preview-close-race-green.log`。原红证据仍为 `runs/deno-review-preview-close-race-red.log`。

旧的已登记 preview 关闭、TTL、显式 release、失败清理由原生命周期测试继续覆盖；本 finding 的独立检查具体覆盖了此前缺失的等待 prune 预约交错和 owned inline-source 创建边界。

## 其余 T7/T8 核对

- asset.preview_batch 在一个 batch 内只读/解析一次 Canonical、校验 project id/fingerprint；至多 8 个 id、每项最多 8 MiB、decoded raw 总预算 16 MiB；预算外返回 deferred，单项错误隔离。打开文件在每项 finally 关闭；打开前后检查 file identity，并按实际字节核 SHA-256。tests/asset_preview_batch_test.ts 覆盖同一项目下可用项、缺失项、校验失败、越界路径、预算 deferred 和 stale fingerprint。
- Import preview 对象上限为 8、TTL 15 分钟。显式 release 会 abort active operation 并等待完成后清理归属的 inline-source 临时目录；超时清理、service close 和失败路径走同一 disposeImportPreview()。readSourceSnapshot() 在 finally 关闭文件；临时来源写入也在 finally 关闭句柄。尚未登记预约的 close 竞态已由上面的 red/green 关闭。
- Export 媒体文件用 1 MiB chunk 和全局 2 个 active stream 槽；取消/释放在 finally 释放槽，读源句柄也在 finally 关闭。descriptor 下载使用完/取消/close 都经 finish 关闭已打开文件并释放槽；资源目录只由 export slot 自己删除。
- 多文件导出提交失败会按 installed/backedUp 清单反向回滚。回滚不完整时 writeOutput() 返回 export_commit_uncertain、commit_state 为 outcome_uncertain、retryable:false、backup_preserved:true，并故意跳过删除 staging，故 .acw-export-*.tmp/backups 留给核查；正常完成或完全回滚才删 transaction。现有 late export promotion failure restores every preexisting target 覆盖后段提升失败时完整恢复旧多文件结果。
- 未发现 import preview release、TTL、export slot close 或 T8 streaming rollback 会清理 Canonical 备份目录的调用路径；它们各自只清理自己的临时目录。

## T5 相邻资产改名 uncertain envelope 独立复核

`runs/deno-review-rename-uncertain-green.log` 由本人再次运行 `tests/io_failure_recovery_test.ts` 中的真实 `DesktopService.commands.execute("asset.rename", boundArgs)` 故障用例（1 passed）。测试在 Canonical 原子提升已发生后丢失 rename acknowledgement，并让随后 Canonical verification read 失败；CommandBus error envelope 保留 `commit_state=outcome_uncertain`、`retryable=false`。读取真实 Canonical 后确认 asset 指向 `assets/<asset-id>-after.png`，新目标仍是原 payload `payload`，旧文件不存在，故不会把已被 Canonical 引用的 bytes 盲目回滚。该核验不覆盖前端状态；Front 对后续 flush pause 的集成回归仍是单独验收项。

## 最终 bound-save 与配对采样（source 50aaea7）

`src/service/storage.ts` 的 bound save 现在直接解析本次 `serializeProject(data)` 生成的 `canonicalText`。该 serializer 已做 secret、schema、domain/default 校验；磁盘/外部 payload 和其他 writer caller 仍走原验证。`tests/project_save_protocol_test.ts` 的规范化序列化幂等、secret/非法输入无写入和精确写入字节断言继续通过。

source commit `50aaea7268164b9fa066425ce4a5ac158ca87352`：focused `17/17`，`deno task check` exit 0，`deno task test` `716/0`。证据在 `runs/deno-final-direct-parse/`：`focused-17.log` SHA-256 `efbcc766dbd55255f737ec53b3bafb0b27ecfd2cfb26494dc65e0140f8fa2318`；`check.log` `fc4dcbfccf13b1c71c6fb5c3f14485d7c00ce823ce7003ac20a949ae6d28257b`；`test.log` `eb2130b14c07238cbd67796cfb08b67f9b485c0c5c5b0eb3f49057f58043038c`。

同一 runner SHA-256 `38529c5ffc60507d02005b736f05ffff30a8ea2f6bc399b727c57826f534ff11` 和同一 7,469,246-byte fixture SHA-256 `14991258eb33336582280c093d97cc3fc61ba6dab166c1a8970ce542f05509a4`，按 baseline→candidate 顺序分别跑了 unprobed 与 instrumented 两组；每次排除 3 个 warmup，每个 case 10 个样本，四个进程 exit 0。Baseline runner 从 dfcb23e archive 自身导入，实际模块路径与 hashes 记录在 summary；candidate 是 50aaea7。采用常规偶数样本中位数、nearest-rank p95（n=10 时为最大样本）和 Tukey median-of-halves IQR：

| 采样组 | changed 中位数 | changed p95 | no-op 中位数 | no-op p95 |
| --- | ---: | ---: | ---: | ---: |
| unprobed baseline → candidate | 401.143 → 406.783 ms (+1.41%) | 451.094 → 416.349 ms (−7.70%) | 425.333 → 158.031 ms (−62.85%) | 509.098 → 185.614 ms (−63.54%) |
| instrumented baseline → candidate | 406.852 → 419.491 ms (+3.11%) | 490.279 → 593.814 ms (+21.12%) | 403.040 → 155.905 ms (−61.32%) | 449.382 → 174.332 ms (−61.21%) |

四份原始 JSON、对应 stdout logs、逐样本范围/IQR、源模块 hashes 和完整计数见 `runs/deno-final-50aaea7f/summary.json`（SHA-256 `3ad9be205efbacd30e4807d78291468b07b48e322d2c6c0c0c5398fa6c486a5f`）。原始 JSON SHA-256：off baseline `c3bac9cf617303449fa5bcd82ff9570c4d25a3c2fbdafd755a38d430c72798c0`；off candidate `46a56f8367779ec9ff1a94dc5cfe67c8dfa0cdd634fbf607b420853ff28d83fe`；on baseline `21e5b2a32ba297f5db78423250a54ae79a1fed909726b44d6f7b7de655007454`；on candidate `edeb531cb73ef4b26be57ed6045088ec3a875b61d85bb96698bccc22fde18ba6`。

Candidate service-level logical counts per 10 changed saves: 20 full reads/hash passes over 149,384,920 bytes; 10 Canonical temp writes (74,692,460 bytes); 10 backup copies (74,692,460 bytes read and written); 20 project file syncs, 10 project-directory syncs; 10 recovery-journal temp writes (69,030,460 bytes) and file syncs; 20 recovery-directory syncs; 10 promotions and removals. Per 10 no-op saves: 10 full reads/hash passes over 74,692,460 bytes, with zero Canonical/recovery/journal/backup writes, copies, syncs, promotions, or removals. The lower-level Deno file probe is a separate instrumented view; do not add its operations to service logical counters. Unprobed counter fields are null. RSS, device-level physical write amplification, and in-process buffer peak were not measured.

**性能结论：PARTIAL / BLOCKED。** No-op save 的中位数和 p95 都明显下降，unprobed changed 中位数接近 baseline 且 p95 更低；但 instrumented changed p95 比 baseline 高 21.12%，其 n=10 nearest-rank p95 等于 candidate 最大样本。该 tail 回退没有被定位，不能用 no-op 收益抵消，也不据此声称性能完全通过。早先 7a3 source 的 off changed `+8.17%` 是较旧实现的历史测量；当前结论只引用 50aaea 这组。意外默认参数运行的输出保留在 `runs/deno-final-7a3fb7f/invalid_unplanned_default_output.json` 并标记 prior output state unknown；不纳入正式配对结果。
