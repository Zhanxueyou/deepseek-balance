# DeepSeek API 余额查询工具

包含两个部分：

1. **CLI 工具 `check_balance.py`**：终端查询余额，低余额时 macOS 通知提醒。
2. **DSH 侧边栏插件（仓库根即为插件包）**：直接嵌入 DeepSeek Harness Web 侧边栏，可视化**余额 / 今日用量 / 本月用量 / 缓存命中**。

---

## 一、CLI 工具

查询 DeepSeek 账户的 API 余额，当余额低于阈值时给出醒目提醒，方便你及时充值。

## 功能

- 展示每个币种的**总余额 / 赠送余额 / 充值余额**
- 余额低于阈值时红色警告，退出码为 `2`（便于 cron / 脚本联动告警）
- 多币种支持（CNY / USD 等，跟随账户实际币种）
- `--json` 输出，方便二次加工
- **macOS 通知中心提醒**（`osascript` 实现，无需额外依赖）

## 依赖

仅 Python 3 标准库，无需安装任何第三方包（macOS / Linux 自带 Python 3）。

## 配置 API Key（三选一，按优先级）

```bash
# 方式 1：环境变量
export DEEPSEEK_API_KEY=sk-xxxxxxxx

# 方式 2：本目录下创建 .env 文件
cp .env.example .env   # 然后填入你的 Key

# 方式 3：全局配置文件
mkdir -p ~/.config/deepseek
echo "sk-xxxxxxxx" > ~/.config/deepseek/api_key
```

> API Key 在 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 创建。

## 使用

```bash
# 基本查询
python3 check_balance.py

# 自定义低余额阈值（默认 10.0）
python3 check_balance.py --threshold 5

# 低余额时发送 macOS 通知（会弹出系统通知中心提醒）
python3 check_balance.py --notify

# 仅低余额时通知（余额充足则静默，适合定时任务）
python3 check_balance.py --notify-only-low

# JSON 输出
python3 check_balance.py --json

# 直接执行（已加执行权限）
./check_balance.py
```

### macOS 通知

- `--notify`：无论余额如何都发送通知——低余额时红色警告标题「⚠ DeepSeek 余额不足，请及时充值」，余额充足时确认通知。
- `--notify-only-low`：只在余额低于阈值时通知，余额充足则静默。**推荐用于每日定时检查**，避免每天被打扰。
- 通知内容为各币种余额摘要，例如「CNY 余额 3.25」。
- 仅支持 macOS（通过 `osascript` 调用系统通知中心）；其他系统会自动跳过并提示。

## 退出码

| 退出码 | 含义                     |
| ------ | ------------------------ |
| 0      | 查询成功，余额充足       |
| 2      | 查询成功，余额低于阈值   |
| 1      | 配置 / 网络 / 接口错误   |

### 定时提醒示例（macOS）

编辑 `~/.zshrc`，添加别名：

```bash
alias deepseek-balance="python3 /path/to/deepseek-balance/check_balance.py"
```

配合 cron 每天检查（Linux / macOS），低余额时弹出 macOS 通知提醒充值：

```cron
0 9 * * * /usr/bin/python3 /path/to/deepseek-balance/check_balance.py --notify-only-low >> /tmp/deepseek_balance.log 2>&1
```

低余额时脚本退出码为 2，可据此触发其他告警（邮件、短信等）。

---

## 二、DSH 侧边栏插件（仓库根 = 插件包）

把余额与用量仪表盘直接嵌入 DeepSeek Harness Web GUI 侧边栏（底部「DeepSeek 用量」按钮，点击弹出面板）。

### 展示内容

| 指标 | 来源 |
| ---- | ---- |
| 余额（总 / 充值 / 赠送，多币种） | DeepSeek 官方接口 `/user/balance`（key 读取 DSH credentials，不出进程） |
| 今日 / 本月 / 全部用量（输入/输出 Token、请求数） | 本机 `~/.dsh/sessions` 会话日志聚合 |
| 缓存命中（Token 数 + 命中率 + 进度条） | 会话日志中每次调用的 `cacheReadTokens` |

- 余额低于阈值（10，可在 `lib/client.js` 的 `LOW_BALANCE_THRESHOLD` 调整）时标红并提示充值
- 打开面板时自动刷新，之后每 60 秒自动刷新，也可手动点刷新
- 宿主端数据带 TTL 缓存（余额 60s / 用量 30s）

### 架构

- **宿主端 `lib/index.js`**：注册同源路由 `/dsh-balance-api/stats`（仅 loopback + 同源访问），
  从 DSH `credentials` 服务解析 `DEEPSEEK_API_KEY` 查余额；用量直接扫描本地会话日志
  （多帧 zstd 逐帧解码，与 DSH 持久化层算法一致）。
- **浏览器端 `lib/client.js`**：注册进侧边栏 `sidebar.footer.action` 插槽，弹出面板渲染
  数据。仅依赖 DSH 种子模块（react / primitives），无任何第三方依赖。

### 安装与启用

1. 把插件包符号链接到 DSH 的 node_modules（源码在本目录，改代码即时生效，无需重新安装）：

   ```bash
   cd /path/to/deepseek-balance   # 进入项目源码目录（换成你的实际路径）
   mkdir -p ~/.dsh/profiles/node_modules
   ln -sfn "$(pwd)/dsh-balance-panel" \
     ~/.dsh/profiles/node_modules/dsh-balance-panel
   ```

   > `$(pwd)` 即当前目录；也可直接把 `"$(pwd)/dsh-balance-panel"` 换成源码目录的绝对路径。
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 注册一行：
   ```yaml
   - insert:
       - id: dsh-balance-panel
         name: dsh-balance-panel
   ```
3. patch 变更会被 DSH 的配置监听器热加载（无需重启即可注册路由与客户端 bundle）；
   宿主端代码的修改需要重启 `dsh web` 后生效。

### 验证

- `curl http://127.0.0.1:3080/dsh-balance-api/stats` — 数据接口
- `curl http://127.0.0.1:3080/ | grep dsh-balance-panel` — 浏览器启动清单
- 页面刷新后侧边栏底部出现「DeepSeek 用量」按钮

### 卸载

1. 删除 `~/.dsh/profiles/web/cordis.patch.yml` 中对应的 insert 行
2. 删除 `~/.dsh/profiles/node_modules/dsh-balance-panel` 链接
3. 重启 `dsh web`（或等待下次重启自动生效）
