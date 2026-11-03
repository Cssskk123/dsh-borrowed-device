# 借用设备守卫 · dsh-borrowed-device

在别人的电脑上用 DSH（公司公用机、网吧、朋友的笔记本）时，**只清理你自己的痕迹，不动机主的数据**。

装好后第一次启动会自动进入借用模式，输入框上方出现一条横栏，提醒你离开前清理，并告诉你本机有多少东西属于你、多少属于别人。

## 安装

1. 打开 [Releases](https://github.com/Cssskk123/dsh-borrowed-device/releases/latest)，下载 `dsh-borrowed-device-<版本>.zip`
2. 解压，得到 `dsh-borrowed-device/` 目录
3. DSH → 插件 → 安装本地插件 → 选择这个目录
4. 插件列表里出现「借用设备守卫」即完成

### 让 AI 帮你装

把下面这段直接发给你那台电脑上的 DSH：

> 帮我装一个 DSH 插件：
> 1. 把 `https://github.com/Cssskk123/dsh-borrowed-device/releases/latest/download/dsh-borrowed-device-0.1.1.zip` 下载到临时目录并解压
> 2. 用 `plugin_manager` 的 `install_bundle`，target 指向解压出来的 `dsh-borrowed-device` 目录
> 3. 确认返回的 `application` 是 `applied`，然后告诉我插件列表里有没有「借用设备守卫」
>
> 哪一步失败就把原始报错贴给我，不要自己猜着改。

装插件需要会话处于「完全权限」，中途弹审批点允许即可。版本号变了就让它去 [Releases](https://github.com/Cssskk123/dsh-borrowed-device/releases/latest) 取实际的 zip 文件名。

要求 **DSH >= 0.2.1-rc.5**。从源码安装：直接用「安装本地插件」选仓库目录即可，目录是链接进来的，改完代码重载插件就生效。

## 使用

| 场景 | 做什么 |
| --- | --- |
| 开始用 | 填 API Key，正常干活 |
| 要走了 | 点「清理我的」→ 再点「确认删除」 |
| 这台其实是自己的 | 点「这是我自己的电脑」（12 秒内可撤销） |
| 想看会删什么 | 点「查看」，或先点「清理我的」看清单 |

清理会删掉：**你在本次借用里产生的**会话、附件、缓存、凭据、临时文件。

不会动：别人的会话、机主的密钥、共享的工作区索引，以及你的代码文件。

## 命令

```
/borrowed                 状态
/borrowed audit           按归属列出本机痕迹
/borrowed wipe            预览"你的"哪些会被删
/borrowed wipe confirm    只删你的
/borrowed on              重新进入借用模式
/borrowed trust           这台是我自己的电脑
```

## 常见问题

**点错「这是我自己的电脑」怎么办？**
12 秒内点弹出来的「撤销」；或者输入 `/borrowed on`；或者去 设置 → 通用 → 「借用设备模式」开关打开。误点不会丢数据。

**会占端口吗？**
不会。插件没有自己的监听端口，只是往 DSH 已有的 Web 服务挂了一个路由，DSH 换端口它跟着换。

**会不会删到机主的东西？**
不会。判定规则、完整清理清单、已知边界都在 [docs/internals.md](docs/internals.md)。

**为什么没有「删掉磁盘副本还能继续用」？**
这版 DSH 的凭据解析只认启动时的环境快照，运行中改环境变量无效，`/borrowed selftest` 可以复现这个结论。详见 docs。

## 开发

```bash
node test/smoke.mjs   # 7 个归属与清理测试
npm pack              # 打包成 tgz
```

- `index.js` — 主机半：工具、命令、审计、清理、HTTP 路由
- `client.js` — 界面半：输入框上方的横栏、设置页开关
- `cordis.patch.yml` — 插件挂载入口
- `test/smoke.mjs` — 用临时 `$DSH_HOME` 跑真实清理逻辑

MIT License。
