# Release playbook — 这个仓库怎么发一个版本

> 目的：把「每次发版都要重新查一遍」的事实固化在仓库里，不用再从对话记录里爬。
> 适用于 AI Course Workbench（`github.com/wyzh0117/workbench`，macOS Universal DMG）。
> 规则冲突时以 `PROJECT_MASTER_CONTROL.md` §0.4（tag 不可变）与 `.github/workflows/release.yml` 为准；本文件只汇总操作路径。
> 首次整理：2026-10-02，随 `v0.2.4`。事实来源是本仓库的 workflow、git 历史与 `PROJECT_MASTER_CONTROL.md`，未从外部对话记录引入任何未经核实的说法。

## 0. 什么时候才允许发

- **必须有用户单独授权**（提交、推送、打 tag、公开 Release 四件事都在授权范围内才做）。任务文档里写「不发布」时就不发布。
- 已发布的 tag **永远不可变**：不移动、不删除、不用新代码重建、不覆盖它的 DMG 或 `.sha256`。发现问题走「修代码 → 新 commit → 新 tag → 新 Release」。
- 只有推送新的 `v*` tag 才会发布。`workflow_dispatch` 手动触发**只构建、不发布**（workflow 里 `Publish release assets` 步骤带 `if: github.event_name == 'push' && github.ref_type == 'tag'`）。

## 1. 版本号：三处必须一起改

workflow 会用 `src-tauri/tauri.conf.json` 的 `version` 反推 tag，不一致直接失败，所以：

```text
src-tauri/tauri.conf.json   "version": "0.2.4"
src-tauri/Cargo.toml        version = "0.2.4"     （第 3 行，package 段）
src-tauri/Cargo.lock        name = "ai-course-workbench" 下面那一行
```

改完自检（应输出期望 tag）：

```bash
python3 -c 'import json;print(json.load(open("src-tauri/tauri.conf.json"))["version"])'
grep -n '^version' src-tauri/Cargo.toml
grep -n -A1 'name = "ai-course-workbench"' src-tauri/Cargo.lock | head -3
```

`deno.json` / `package.json` **没有**版本字段，不用改。历史小版本递增：`v0.2.3 → v0.2.4`。

## 2. Release Notes（决定 GitHub 上用户看到什么）

- 文件：`.github/release-notes/v<X.Y.Z>.md`，**必须和 tag 同名**（workflow 拼的就是这个路径）。文件不存在时 Release 正文只有 `Universal macOS update.` 一行，所以别忘。
- 只写 `## What's new` 与 `## Notes`。`System / Install / 首次打开 / Distribution status / Verify / Links` 由 workflow 自动拼接，**不要重复手写**。
- 语言用英文（v0.2.x 全部如此）；中文的用户视角长文放在 `docs/feature-history/`（见第 4 步）。
- workflow 会 `codesign -dv` 检测产物：日志里出现 `Developer ID Application` 才写「已签名并公证」，否则自动写「未签名/未公证」并给出两种 macOS 的 Gatekeeper 放行路径。**不要**在 Notes 里宣称签名状态，交给脚本判断。
- 发布前无法知道 DMG 的 SHA-256，所以 **`## Release verification` 段属于发布之后的第二个提交**（先例：`v0.2.3` 由 `0ce229a` 发布、由 `4ab8e5d` 补验证事实，随后 `gh release edit --notes-file` 把同一段补进公开正文）。

## 3. 工具链与自动化 gate

```bash
export PATH="$HOME/.cargo/bin:$PATH"     # cargo / rustc 不在默认 PATH 上
deno task check
deno task test
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
```

本地想先验一次打包（不发布）：

```bash
cargo tauri build --debug --bundles app \
  --config '{"identifier":"io.github.wyzh0117.ai-course-workbench.smoke-<日期>"}'
```

**必须换 identifier**：用默认 identifier 构建/启动会写进已安装公开版的
`~/Library/Application Support/io.github.wyzh0117.ai-course-workbench/`，污染用户真实状态。

发布用的是 CI 上的 Universal 构建，本机等价命令：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo tauri build --target universal-apple-darwin --bundles app,dmg
# 产物在 src-tauri/target/universal-apple-darwin/release/bundle/
```

## 4. 提交内容：显式列路径，禁止 `git add -A`

`.gitignore` 已经把 `src-tauri/target/`、`.release/`、`dist/`、`*.dmg*`、`.workspace/`、`.workbench-project/`、`graft/`、`.env*` 挡住了，但**暂存前仍要逐个确认**：

```bash
git status --short
git add <明确路径…>
git diff --cached --stat          # 复核规模
git diff --cached --name-only     # 复核清单
```

一次 release 提交通常包含：源码与测试、三处版本字段、`.github/release-notes/vX.Y.Z.md`、
`docs/feature-history/`（版本文件 + `UNRELEASED.md` 重置 + 索引表）、`README.md`、`PROJECT_MASTER_CONTROL.md`。

**提交前必查**（这个仓库是 public）：

```bash
git diff --cached | grep -inE "sk-[a-z0-9]{12,}|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]{20,}"
git diff --cached --name-only | grep -iE "project\.json$|\.workspace/|\.dmg|\.p8|\.p12|keychain|\.env"
```

命中就停下排查，别抱侥幸。密钥只允许存在于 macOS 钥匙串与 GitHub Secrets。

提交信息沿用仓库既有风格（动宾短句，不带 conventional 前缀也可以）：
`Implement v0.2.4 actual-use feedback closure` / `Document v0.2.4 release verification`。
**不使用** `--no-verify`、`--no-gpg-sign`，不 `commit --amend` 已推送的提交。

## 5. 推送与打 tag

```bash
git push origin main                    # 普通 push，绝不 --force
git tag -a v0.2.4 -m "Release v0.2.4"   # 历史 tag 都是附注 tag，消息就是这一行
git push origin v0.2.4                  # 这一步才真正触发公开
```

## 6. 盯 workflow 并验证公开产物

```bash
gh run list --workflow "Release macOS DMG" --limit 3
gh run watch <run-id> --exit-status
```

发布后逐项核对（`v0.2.3` 的先例就是这套）：

```bash
gh release view v0.2.4 --json isDraft,assets,body            # isDraft 必须 false，两个资产齐全
curl -sIL -o /dev/null -w '%{http_code}\n' \
  https://github.com/wyzh0117/workbench/releases/download/v0.2.4/AI-Course-Workbench-macOS.dmg   # 匿名 200
curl -sL .../AI-Course-Workbench-macOS.dmg.sha256 -o /tmp/sidecar.txt
shasum -a 256 ~/Downloads/AI-Course-Workbench-macOS.dmg       # 与 sidecar 一致
hdiutil verify <dmg>                                          # CRC 通过
hdiutil attach -nobrowse -readonly <dmg>                      # 挂载后：
lipo -archs "/Volumes/AI Course Workbench*/Applications/AI Course Workbench.app/Contents/MacOS/ai-course-workbench"
codesign -dv --verbose=4 <app> | grep -E "Identifier|TeamIdentifier|Authority"   # ad-hoc 时无 TeamIdentifier
spctl --assess --type execute -v <app>                        # 无 Developer ID 时 rejected —— 如实记录
gh release view --json tagName -q .tagName -R wyzh0117/workbench releases/latest # latest 指向本版
```

固定直链必须仍然可用（文件名**永远**是 `AI-Course-Workbench-macOS.dmg`，用户手里的书签依赖它）：

```text
https://github.com/wyzh0117/workbench/releases/latest/download/AI-Course-Workbench-macOS.dmg
```

## 7. 发布后回写（第二个提交）

1. `.github/release-notes/vX.Y.Z.md` 追加 `## Release verification`：tag → commit 全 sha、run 链接与结论、DMG 与 sidecar 的匿名下载结果、SHA-256、`hdiutil verify`、架构切片、签名/公证真实状态。
2. `docs/feature-history/vX.Y.Z.md` 顶部补发布日期与源码提交；`docs/feature-history/README.md` 索引表填 sha（短写）。
3. `PROJECT_MASTER_CONTROL.md`：Change Log 追加一行（`YYYY-MM-DD | 任务 | From → To | 摘要`）、§29/§30 的 CURRENT STATUS / NEXT ACTION / Latest public release 切换、追加新的收口/发布章节（**不改写历史 VERIFIED 记录**）。
4. `README.md`：Download 段（固定直链不用改）、系统要求、分发状态、当前开发位置里的公开版本行。
5. `git push origin main`，然后 `gh release edit vX.Y.Z --notes-file dist/release-notes-full.md` 把验证段同步进公开正文（改正文不动资产，不违反 §0.4）。
6. `graft build` 刷新代码图。

## 8. 永远只能由用户在本机完成的事

- **Developer ID 签名与 Apple 公证**：需要 Apple Developer Program 凭据。本机 `security find-identity -v -p codesigning` 至今返回 `0 valid identities`。配好
  `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`（或 `APPLE_API_KEY_P8` + `APPLE_API_KEY` + `APPLE_API_ISSUER`）之后，同一条 workflow 直接产出签名公证版，不需要改代码。
- **Gatekeeper 放行后的首次启动**：agent 环境投递不了右键菜单 / 「系统设置」交互，也没人实测过放行之后的那一屏。
- **原生窗口指针 smoke**（§15.4）：本环境 AppleScript 系统事件超时 `-1712`、`screencapture` 报 `could not create image from display`。Grid 真实拖放、原生打开面板多选、放大后 GIF 播放、真实输入法，都要用户在真实窗口点一遍。
- **真实在线 AI**：`api.openai.com` 在该环境 60 秒超时，真实订阅登录 / token 刷新 / 推理只能用户自己验。

## 9. 已知历史坑（别再踩）

- `v0.2.0` 是**失败且未发布**的 tag：workflow 在导入空 `APPLE_CERTIFICATE` 时失败，没有 Release、没有资产。该 tag 按 §0.4 保持不动；功能随 `v0.2.1` 才第一次到用户手里。因此 workflow 现在会在没有证书时走 ad-hoc 分支——改证书逻辑时别把这个回退删掉。
- `tauri-action` 在证书缺失时的行为变化是这个仓库唯一一次「构建成功但发布失败」的根因（`60f6976 Fix ad-hoc macOS release fallback`）。
- Release 资产名带版本号 = 破坏固定直链，禁止。
- 覆盖已发布 Release 的资产会永久毁掉别人手里的 SHA-256 对应关系，workflow 已用 `isDraft` 检查拦住，不要绕过。
