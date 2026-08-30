#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_balance.py — 查询 DeepSeek API 账户余额，低余额时给出提醒。

功能：
  * 查询 https://api.deepseek.com/user/balance
  * 多币种余额展示（total / granted / topped_up）
  * 余额低于阈值时醒目警告（退出码非 0，便于 cron / 脚本联动）
  * 支持 --json 输出，便于二次加工

API Key 读取顺序（第一个存在的生效）：
  1. 环境变量 DEEPSEEK_API_KEY
  2. 本脚本同目录下的 .env 文件（格式: DEEPSEEK_API_KEY=sk-xxxx）
  3. ~/.config/deepseek/api_key 文件（内容为 key 本身）

依赖：仅 Python 3 标准库，无第三方包。
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

API_URL = "https://api.deepseek.com/user/balance"

# ANSI 颜色（仅 TTY 下启用）
_COLORS = {
    "green": "\033[32m",
    "yellow": "\033[33m",
    "red": "\033[31m",
    "bold": "\033[1m",
    "reset": "\033[0m",
}


def color(text, name):
    if sys.stdout.isatty():
        return f"{_COLORS[name]}{text}{_COLORS['reset']}"
    return text


def find_api_key():
    """按优先级返回 API Key，找不到返回 None。"""
    env_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if env_key:
        return env_key

    env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.isfile(env_file):
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    if k.strip() == "DEEPSEEK_API_KEY":
                        key = v.strip().strip('"').strip("'")
                        if key:
                            return key

    config_file = os.path.expanduser("~/.config/deepseek/api_key")
    if os.path.isfile(config_file):
        with open(config_file, "r", encoding="utf-8") as f:
            key = f.read().strip()
            if key:
                return key

    return None


def fetch_balance(api_key, timeout=15):
    """调用 DeepSeek 余额接口，返回解析后的 dict。"""
    req = urllib.request.Request(
        API_URL,
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def format_balance(value):
    """把字符串/数字余额格式化成两位小数。"""
    try:
        return f"{float(value):.2f}"
    except (TypeError, ValueError):
        return str(value)


def parse_balance_info(balance_infos):
    """把接口返回的 balance_infos 归一化为列表。"""
    if isinstance(balance_infos, list):
        return balance_infos
    if isinstance(balance_infos, dict):
        return [balance_infos]
    return []


def render_human(data, threshold):
    """人类可读输出。返回 (has_low_balance, lines)。"""
    lines = []
    is_available = data.get("is_available")
    infos = parse_balance_info(data.get("balance_infos"))

    lines.append(color("==== DeepSeek API 余额 ====", "bold"))
    if is_available is None:
        lines.append(f"  可用状态: {color('未知', 'yellow')}")
    elif is_available is True:
        lines.append(f"  可用状态: {color('可用', 'green')}")
    else:
        lines.append(f"  可用状态: {color('不可用', 'red')}")

    if not infos:
        lines.append(color("  （接口未返回余额信息）", "yellow"))
        return False, lines

    has_low = False
    for info in infos:
        currency = info.get("currency", "?")
        total = info.get("total_balance")
        granted = info.get("granted_balance")
        topped_up = info.get("topped_up_balance")

        lines.append(f"  {color(currency, 'bold')} 账户:")
        if total is not None:
            lines.append(f"    总余额:        {format_balance(total)} {currency}")
        if granted is not None:
            lines.append(f"    赠送余额:      {format_balance(granted)} {currency}")
        if topped_up is not None:
            lines.append(f"    充值余额:      {format_balance(topped_up)} {currency}")

        # 低余额判断
        if total is not None:
            try:
                if float(total) < threshold:
                    has_low = True
                    lines.append(
                        color(
                            f"    ⚠ 余额低于阈值 {threshold:.2f} {currency}，请及时充值！",
                            "red",
                        )
                    )
            except (TypeError, ValueError):
                pass

    if has_low:
        lines.append(color("=> 余额不足，请尽快到 platform.deepseek.com 充值", "red"))
    else:
        lines.append(color("=> 余额充足", "green"))
    return has_low, lines


def summarize_balance(data, threshold):
    """生成通知用的一句话摘要，返回 (has_low, summary_str)。"""
    parts = []
    has_low = False
    for info in parse_balance_info(data.get("balance_infos")):
        currency = info.get("currency", "?")
        total = info.get("total_balance")
        if total is not None:
            parts.append(f"{currency} 余额 {format_balance(total)}")
            try:
                if float(total) < threshold:
                    has_low = True
            except (TypeError, ValueError):
                pass
    return has_low, "；".join(parts) if parts else "查询成功"


def macos_notify(title, message):
    """通过 osascript 发送 macOS 通知中心通知。返回是否成功。"""
    if sys.platform != "darwin":
        return False
    script = (
        f'display notification {json.dumps(message, ensure_ascii=False)} '
        f'with title {json.dumps(title, ensure_ascii=False)}'
    )
    try:
        import subprocess

        subprocess.run(
            ["osascript", "-e", script],
            check=True,
            capture_output=True,
            timeout=10,
        )
        return True
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser(
        description="查询 DeepSeek API 余额，并在余额过低时提醒充值。"
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=10.0,
        help="低余额警告阈值（按每种币种的总余额判断），默认 10.0",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="以 JSON 格式输出（适合脚本调用）",
    )
    parser.add_argument(
        "--notify",
        action="store_true",
        help="发送 macOS 通知中心提醒（低余额时警告，余额充足时确认）",
    )
    parser.add_argument(
        "--notify-only-low",
        action="store_true",
        help="仅在低余额时发送 macOS 通知（适合 cron 每日执行，避免打扰）",
    )
    args = parser.parse_args()

    api_key = find_api_key()
    if not api_key:
        print(
            "错误: 未找到 API Key。请通过以下任一方式提供：\n"
            "  1. 环境变量 DEEPSEEK_API_KEY\n"
            "  2. 本脚本同目录的 .env 文件（DEEPSEEK_API_KEY=sk-xxx）\n"
            "  3. ~/.config/deepseek/api_key 文件",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        data = fetch_balance(api_key)
    except urllib.error.HTTPError as e:
        print(f"错误: 接口返回 HTTP {e.code}: {e.reason}", file=sys.stderr)
        if e.code in (401, 403):
            print("提示: 请检查 API Key 是否正确、账户是否有效。", file=sys.stderr)
        sys.exit(1)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"错误: 网络请求失败: {e}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"错误: 响应解析失败: {e}", file=sys.stderr)
        sys.exit(1)

    # macOS 通知（先于输出执行，两种输出模式都支持）
    if args.notify or args.notify_only_low:
        low, summary = summarize_balance(data, args.threshold)
        if low:
            ok = macos_notify("⚠ DeepSeek 余额不足，请及时充值", summary)
        elif not args.notify_only_low:
            ok = macos_notify("DeepSeek 余额充足", summary)
        else:
            ok = True  # 余额充足且仅低余额通知模式：静默
        if not ok:
            print("提示: macOS 通知发送失败（仅支持 macOS 系统）", file=sys.stderr)

    if args.json:
        payload = {
            "is_available": data.get("is_available"),
            "balance_infos": parse_balance_info(data.get("balance_infos")),
            "low_balance": False,
        }
        for info in payload["balance_infos"]:
            try:
                if float(info.get("total_balance", 0)) < args.threshold:
                    payload["low_balance"] = True
            except (TypeError, ValueError):
                pass
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        sys.exit(2 if payload["low_balance"] else 0)

    has_low, lines = render_human(data, args.threshold)
    print("\n".join(lines))
    sys.exit(2 if has_low else 0)


if __name__ == "__main__":
    main()
