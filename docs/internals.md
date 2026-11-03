# 内部机制

这份文档解释"它凭什么只删你的"。日常使用看 [README](../README.md) 就够了。

## 归属怎么判定

借用别人的电脑时，那台机器的 `~/.dsh` 里很可能已经有**机主自己的**会话、密钥和附件。插件不按目录一刀切，而是按归属处理：

| 数据 | 怎么判断"是你的" |
| --- | --- |
| 会话日志、会话投影缓存 | 借用模式下**亲眼看到它被创建**（`session/created`）才计入你的；借用开始前就存在的，一律算别人的 |
| API Key、登录凭据 | 借用模式下**亲眼看到它被写入**（`credentials/reference-updated` / `record-updated`）才算你的 |
| 附件、缓存、临时文件 | 内容寻址、没有归属标记，按**创建时间**：本次 DSH 进程启动之后创建的是你的 |
| 工作区条目 | 借用开始时先快照已有 workspace 的 id，之后新增的才算你的 |
| 工作区索引文件、shell 历史、浏览器数据 | 共享或不属于 DSH，**从不删除**，只报告 |

审计结果分三类：`mine`（你的，会删）、`foreign`（别人的，绝不碰）、`shared`（共享的，不归插件管）。

**安全兜底**：确认不了归属的一律算"别人的"。宁可少删，不误删。

## 清理清单

`%DSH_HOME%` 默认是 `C:\Users\<你>\.dsh`。

### 会删（只限你自己的）

| 类别 | 路径 | 归属判据 |
| --- | --- | --- |
| 会话日志 | `sessions\<工作目录>\<会话id>\` 整个目录（并清掉空的父目录） | 借用中看到它被创建 |
| 会话投影缓存 | `storages\session_projcache\sessions\<会话id>.json` | 同上，按会话 id |
| 附件 | `attachments\**`，只删文件不删目录 | 本次进程启动后创建 |
| 缓存 | `cache\**`，只删文件不删目录 | 本次进程启动后创建 |
| 临时产物 | `%TEMP%\dsh-spill-*`、`dsh-subprocess-*`、`dsh-workspace-changes-*`、`dsh-inspect*` | 本次启动后创建，且 30 分钟没有写入 |
| API Key | `.credentials.yaml` 里 `refs` 下你写入的那条 | 借用中看到它被写入 |
| 登录凭据记录 | 同文件 `records` | 借用中看到它被写入 |
| 工作区条目 | `storages\workspace.json` 里本次新建的条目（通过 registry 按 id 删除） | 借用开始时的快照之外 |
| shell / git 历史（可选） | `~/.bash_history`、`~/.zsh_history`、`~/.git-credentials`、PSReadLine 历史 | 默认关闭，需 `shellHistoryOnWipe: true` |

### 不会删

- 别人的会话、投影缓存、附件、缓存、临时产物
- 机主自己的 API Key 和登录凭据
- 机主原有的 workspace 条目
- 你的代码、文档、下载文件——它们不在上面这些目录里
- 浏览器历史 / 下载 / localStorage、Windows 凭据管理器

### 删不掉时

正在被 DSH 写着的文件如果删不掉，会记进 `.borrowed-device.json` 的 `pendingWipe`，**下次启动 DSH 时补删**。

### 强制全删

`/borrowed wipe confirm all` —— 连别人的一起删，只在确认是干净新机器时用。

## 关于 API Key

DSH 把 key 明文写在 `~/.dsh/.credentials.yaml`。插件做三件事：

1. **告诉你它在不在**：审计和横栏直接标出「磁盘上有」还是「来自环境变量」；
2. **离开时删掉它**：「清理我的」会把**你写入的**那条删掉；
3. 真正的保险在别处：用一次性 / 低额度的 key，离开后到 platform.deepseek.com **吊销**。

### 为什么没有「删掉磁盘副本还能继续用」

做过，又删了。运行时里，凭据解析只认**启动时的环境快照**（`dsh-launch-environment` 的 `launchEnvironment`，不可变），`dsh-credentials-local` 的 `inherited()` 只查这份快照。也就是说**运行中修改 `process.env` 永远不会被看到**。

`/borrowed selftest` 会用临时 ref 跑一遍完整流程验证这个结论，在 0.2.x 上返回 `environment-fallback-unavailable`。与其留一个按下去只会回滚的按钮，不如删掉。

### 想真正做到"key 不落盘"

**启动 DSH 之前**把 key 放进环境（`DEEPSEEK_API_KEY=...`，或写进 `$DSH_HOME/.env`），DSH 就不会往凭据文件里写。这样启动后横栏会显示「密钥来自环境变量，磁盘上没有副本」。

`.env` 本身也是文件，只是不在凭据文件里——在别人机器上写它同样要记得删。

## 已知边界

- **先装插件，再开始聊天**。装之前就存在的会话会被当成别人的，不会清理。
- 续聊机主已有的会话，那条文件里混着两个人的内容，属于别人的文件，插件不会删——建议只开新会话。
- 匿名的附件/缓存按创建时间判断；文件系统不提供创建时间时退化为修改时间，可能把机主最近碰过的文件误判成"你的"，此时先用 `/borrowed audit` 复核。
- 清理会删掉**你的**全部会话记录，无法恢复。
- 浏览器侧数据、Windows 凭据管理器、你手动保存的文件都不在管辖内。

## 配置

在 `cordis.patch.yml` 里按行 id 覆盖（改完重启生效）：

```yaml
- id: borrowed-device
  config:
    refs: ['DEEPSEEK_API_KEY']   # 额外要保护的凭据 ref 名
    shellHistoryOnWipe: false    # 清理时是否连 shell / git 历史一起删
    autoArmOnNewMachine: true    # 新机器自动进入借用模式
```
