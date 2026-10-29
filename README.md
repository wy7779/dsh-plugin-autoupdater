# dsh-plugin-autoupdater

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 用的**插件自动更新器**：
定期检查已安装插件的新版本并自动更新；遇到 DSH 拒绝原地升级（`already-installed`）时，自动**卸载后重装**，重装失败会把旧版本恢复回去。

> 只处理从 npm 安装的第三方插件；本地 `link:` / `file:` / git 插件、官方随 DSH 发布的插件、管理必需插件、以及本插件自身都不会被改动。

## 功能

- **定期检查**：默认每 3 小时查一次 npm 的 `latest`（可设为 1/3/6/12/24 小时）；
- **自动安装**：有新版本就装；原地安装被拒时自动走「卸载 → 重装」；
- **失败恢复**：重装失败时尝试把旧版本装回去，并在设置页写明失败原因；
- **空闲窗口**：自动执行只在会话空闲 ≥5 分钟时进行（看会话日志最后写入时间），避免更新把正在跑的对话打断；设置页的「立即检查并更新」不受限制；
- **失败冷却**：同一个包在同一个目标版本上失败后，12 小时内不再重试；
- **可配置**：自动检查 / 自动安装 / 失败时卸载重装 三个开关，检查间隔可选；
- **结果可见**：设置页显示上次检查时间、逐条结果（已更新 / 已更新待重启 / 可更新 / 失败原因 / 跳过原因）。

## 安装

要求：DSH 0.2.1+（在 0.2.1-rc.3 桌面端实测）。插件通过 `pluginManager`、`connection`、`webServer` 三个宿主服务工作，均为该版本内置。

**从 GitHub 安装（桌面端）：**

```bash
dsh plugin --profile desktop add github:wy7779/dsh-plugin-autoupdater
```

如果当前 DSH 版本不支持 `github:` 源，克隆后按本地目录安装：

```bash
git clone https://github.com/wy7779/dsh-plugin-autoupdater.git
dsh plugin --profile desktop add /path/to/dsh-plugin-autoupdater
```

也可以在 **设置 → 插件 → 添加插件** 里填入本地目录路径安装，然后重启 DSH。

## 使用

打开 **设置 → 插件自动更新**：

- 开启「启用自动检查」后，插件会在加载后约 10 分钟做第一次检查，此后按间隔轮询；
- 关闭「自动安装更新」时只报告新版本，点「立即检查并更新」才会安装；
- 关闭「失败时自动卸载重装」后，遇到 `already-installed` 只记录失败，不会改动插件。

配置与最近一次结果保存在 `~/.dsh/plugin-auto-updater/state.json`。

## 工作原理

1. `pluginManager.listBundles()` 列出已安装 bundle，只保留：
   - 已安装、`removable`、无 `readOnlyReason` 的第三方包；
   - 依赖声明是 registry 版本（`name@1.2.3`、`name@^1.2.3` 等），跳过 `link:` / `file:` / git 源；
   - 不是官方随 DSH 发布的包，也不是本插件自己。
2. 从 npm 取 `dist-tags.latest`（默认源失败时回退 npmmirror），做 semver 比较；
3. 有新版本时调用 `installBundle('name@latest')`：
   - 成功（`applied` / `restart-required`）→ 完成；
   - 返回 `already-installed`（DSH 对已装插件的直接升级会拒绝）→ 如果开启修复：`removeBundle(name)` 再 `installBundle('name@latest')`；
   - 重装失败 → 尝试 `installBundle('name@旧版本')` 恢复，并把原因写进结果。
4. 自动执行前会检查会话日志最近的写入时间，活跃时不更新，10 分钟后再试。

## 已知边界

- 部分插件更新后需要**重启 DSH** 才完整生效（结果里会标「已更新（重启后生效）」）；
- 更新 `dsh-ops` 这类提供 shell/文件工具的插件时，相关工具会短暂不可用——所以自动更新只在空闲窗口做；
- 更新是否可用取决于 npm 上是否存在 `latest`；私有源/私有包不在处理范围内；
- 插件不会修改 `~/.dsh/profiles/*/package.json` 之外的内容（全部通过 DSH 的 pluginManager 完成）。

## License

[MIT](./LICENSE)

---

English: A DeepSeek Harness plugin that periodically checks installed npm-backed plugins for newer releases and updates them automatically, falling back to uninstall + reinstall when DSH refuses an in-place upgrade, and restoring the previous version if the reinstall fails.
