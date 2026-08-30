/**
 * dsh-balance-panel — browser half.
 *
 * Registers a `sidebar.footer.action` occupant: 侧边栏底部一个按钮，
 * 点击弹出 DeepSeek 余额 / 今日用量 / 本月用量 / 缓存命中 面板。
 *
 * 数据来自宿主路由 /dsh-balance-api/stats（同源 fetch）。
 * 仅依赖种子模块：react、react/jsx-runtime、@deepseek-ai/dsh-client-ui-primitives。
 */
window.__ModuleLoader__.load({
	id: "dsh-balance-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		// ---- 面板样式（注入独立 <style>，类名加 dbp- 前缀避免冲突） ----
		const css = `
.dbp-root{width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden;text-align:left}
.dbp-root:hover,.dbp-root[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.dbp-rootLabel{white-space:nowrap;font-size:13px;overflow:hidden;text-overflow:ellipsis}
.dbp-balance{white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dbp-rootCount{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dbp-rail{width:36px;height:36px;border-radius:50%;justify-content:center;gap:0;padding:0;margin:0 auto}
.dbp-panel{position:fixed;z-index:30;width:420px;max-width:calc(100vw - 24px);max-height:72vh;overflow-y:auto;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);border-radius:12px;padding:14px 14px 12px;box-sizing:border-box;font-size:13px;color:var(--dsw-alias-label-primary)}
.dbp-head{display:flex;align-items:center;gap:8px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18))}
.dbp-headTitle{font-size:14px;font-weight:600;flex:1}
.dbp-refresh{cursor:pointer;background:0 0;border:none;color:var(--dsw-alias-label-secondary);padding:4px;border-radius:8px;display:inline-flex;align-items:center}
.dbp-refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dbp-section{margin-top:12px}
.dbp-sectionTitle{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}
.dbp-row{display:flex;justify-content:space-between;align-items:baseline;padding:3px 0;gap:12px}
.dbp-label{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dbp-value{font-variant-numeric:tabular-nums;text-align:right}
.dbp-big{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.dbp-sub{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dbp-err{color:var(--dsw-alias-state-error-primary)}
.dbp-ok{color:var(--dsw-alias-state-success-primary)}
.dbp-warnRow{margin-top:8px;padding:6px 8px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary);font-size:12px}
.dbp-ratio{height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;margin-top:4px}
.dbp-ratioFill{height:100%;background:var(--dsw-alias-state-success-primary);border-radius:2px}
.dbp-note{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:2px 0}
.dbp-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:8px;word-break:break-all}
.dbp-footer{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18));color:var(--dsw-alias-label-tertiary);font-size:11px}
`;
		const tagId = "dsh-balance-panel/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance-panel";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const { useState, useEffect, useRef, useCallback, useLayoutEffect } = react;
		const { IconDataOutline16, IconRefreshOutline16, useDismissOnOutsidePointer } = primitives;
		// React.createElement：children 按位置参数传入
		const h = react.createElement;

		// ---- 格式化 ----
		function fmtTokens(n) {
			n = Number(n) || 0;
			if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
			if (n >= 1e4) return (n / 1e4).toFixed(2) + " 万";
			return String(n);
		}
		function fmtRatio(r) {
			return (Number(r) * 100).toFixed(1) + "%";
		}
		function currencySymbol(cur) {
			if (cur === "CNY") return "¥";
			if (cur === "USD") return "$";
			return cur + " ";
		}
		function fmtTime(iso) {
			try {
				const d = new Date(iso);
				return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
			} catch {
				return "";
			}
		}
		function fmtDate(ms) {
			try {
				const d = new Date(ms);
				return (d.getMonth() + 1) + "/" + d.getDate();
			} catch {
				return "";
			}
		}

		const LOW_BALANCE_THRESHOLD = 10; // 低于该值（按币种）标红提醒

		// ---- 面板 ----
		function BalancePanel({ wide }) {
			const [open, setOpen] = useState(false);
			const [data, setData] = useState(null);
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState("");
			const rootRef = useRef(null);
			const btnRef = useRef(null);
			const [anchor, setAnchor] = useState();

			useLayoutEffect(() => {
				if (!open) return;
				const place = () => {
					// 注意：锚点必须取「按钮」的矩形——包装 div 是 display:contents，
					// getBoundingClientRect 返回全零，会把面板定位到屏幕外。
					const rect = btnRef.current?.getBoundingClientRect();
					if (rect !== void 0) setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
				};
				place();
				window.addEventListener("resize", place);
				return () => window.removeEventListener("resize", place);
			}, [open]);

			useDismissOnOutsidePointer(rootRef, open, setOpen);

			const refresh = useCallback(async () => {
				setLoading(true);
				try {
					const res = await fetch("/dsh-balance-api/stats", { headers: { accept: "application/json" } });
					if (!res.ok) throw new Error("HTTP " + res.status);
					const j = await res.json();
					if (!j.ok) throw new Error(j.error || "查询失败");
					setData(j);
					setError("");
				} catch (e) {
					setError(String(e && e.message ? e.message : e));
				} finally {
					setLoading(false);
				}
			}, []);

			// 挂载即拉取 + 每 60 秒刷新：让按钮上的余额始终保持新鲜（无需打开面板）
			useEffect(() => {
				refresh();
				const timer = window.setInterval(refresh, 60_000);
				return () => window.clearInterval(timer);
			}, [refresh]);

			// 打开面板时立即刷新一次
			useEffect(() => {
				if (open) refresh();
			}, [open, refresh]);

			const lowBalance = (() => {
				if (!data || !data.balance) return false;
				if (data.balance.is_available === false) return true;
				return (data.balance.balance_infos || []).some((info) => Number(info.total_balance) < LOW_BALANCE_THRESHOLD);
			})();

			// 按钮上直接显示的余额摘要（取第一个币种）
			const btnBalance = (() => {
				if (!data || !data.balance || !Array.isArray(data.balance.balance_infos) || data.balance.balance_infos.length === 0) return null;
				const info = data.balance.balance_infos[0];
				const total = Number(info.total_balance);
				if (!Number.isFinite(total)) return null;
				return {
					text: currencySymbol(info.currency) + total.toFixed(2),
					low: total < LOW_BALANCE_THRESHOLD || data.balance.is_available === false,
				};
			})();

			const balanceCards = [];
			if (data && data.balance && Array.isArray(data.balance.balance_infos)) {
				for (const info of data.balance.balance_infos) {
					const total = Number(info.total_balance);
					const low = Number.isFinite(total) && total < LOW_BALANCE_THRESHOLD;
					balanceCards.push(
						h("div", { className: "dbp-section", key: info.currency },
							h("div", { className: "dbp-sectionTitle" }, "余额 · " + info.currency),
							h("div", { className: "dbp-row" },
								h("span", { className: "dbp-big " + (low ? "dbp-err" : "") },
									currencySymbol(info.currency) + (Number.isFinite(total) ? total.toFixed(2) : String(info.total_balance))),
								h("span", { className: "dbp-sub" },
									"充值 " + (info.topped_up_balance ?? "—") + " · 赠送 " + (info.granted_balance ?? "—"))
							)
						)
					);
				}
			}

			const usage = data?.usage;
			const renderUsageSection = (title, w, note) => {
				if (!usage) return null;
				const u = usage[w];
				return h("div", { className: "dbp-section", key: title },
					h("div", { className: "dbp-sectionTitle" }, title + (note ? " · " + note : "")),
					h("div", { className: "dbp-row" },
						h("span", { className: "dbp-label" }, "输入 Token"),
						h("span", { className: "dbp-value" }, fmtTokens(u.inputTokens))),
					h("div", { className: "dbp-row" },
						h("span", { className: "dbp-label" }, "输出 Token"),
						h("span", { className: "dbp-value" }, fmtTokens(u.outputTokens))),
					h("div", { className: "dbp-row" },
						h("span", { className: "dbp-label" }, "请求次数"),
						h("span", { className: "dbp-value" }, u.requests)),
					h("div", { className: "dbp-row" },
						h("span", { className: "dbp-label" }, "缓存命中"),
						h("span", { className: "dbp-value " + (u.cacheHitRatio > 0.5 ? "dbp-ok" : "") },
							fmtTokens(u.cacheReadTokens) + " · " + fmtRatio(u.cacheHitRatio))),
					h("div", { className: "dbp-ratio" },
						h("div", { className: "dbp-ratioFill", style: { width: Math.min(100, Math.round((u.cacheHitRatio || 0) * 100)) + "%" } }))
				);
			};

			const trigger = h("button", {
				ref: btnRef,
				type: "button",
				className: "dbp-root" + (wide ? "" : " dbp-rail"),
				"aria-label": "DeepSeek 用量",
				"aria-expanded": open,
				"data-active": open || void 0,
				title: "DeepSeek 余额 / 用量",
				onClick: () => setOpen((v) => !v),
			},
				h(IconDataOutline16, { size: wide ? 16 : 18 }),
				wide ? h("span", { className: "dbp-rootLabel" }, "DeepSeek 用量") : null,
				wide && btnBalance ? h("span", { className: "dbp-balance" + (btnBalance.low ? " dbp-err" : "") }, "· " + btnBalance.text) : null,
				wide && lowBalance ? h("span", { className: "dbp-rootCount dbp-err" }, "⚠") : null
			);

			const panel = open && anchor !== void 0 ? h("div", {
				className: "dbp-panel",
				style: { left: anchor.left, bottom: anchor.bottom },
			},
				h("div", { className: "dbp-head" },
					h("span", { className: "dbp-headTitle" }, "DeepSeek 用量"),
					h("button", {
						type: "button",
						className: "dbp-refresh",
						"aria-label": "刷新",
						title: "刷新",
						onClick: refresh,
					}, h(IconRefreshOutline16, { size: 14 })),
					loading ? h("span", { className: "dbp-sub" }, "刷新中…") : null
				),
				error ? h("div", { className: "dbp-error" }, "加载失败：" + error) : null,
				!error && !data ? h("div", { className: "dbp-note" }, "加载中…") : null,
				!error && data && !data.balance && data.balanceError ? h("div", { className: "dbp-section" },
					h("div", { className: "dbp-sectionTitle" }, "余额"),
					h("div", { className: "dbp-error" }, "余额不可用：" + data.balanceError)
				) : null,
				!error && data && data.balance ? balanceCards : null,
				!error && data && lowBalance ? h("div", { className: "dbp-warnRow" }, "⚠ 余额低于阈值，请及时到 platform.deepseek.com 充值") : null,
				!error && data && usage ? renderUsageSection("今日用量", "today") : null,
				!error && data && usage ? renderUsageSection("本月用量", "month") : null,
				!error && data && usage ? renderUsageSection("全部用量", "all", usage.earliestAt ? "自 " + fmtDate(usage.earliestAt) + " 起" : null) : null,
				!error && data && data.fetchedAt ? h("div", { className: "dbp-footer" }, "更新于 " + fmtTime(data.fetchedAt) + " · 每 60 秒自动刷新 · 用量来自本机会话日志") : null
			) : null;

			return h("div", { ref: rootRef, style: { display: "contents" } }, trigger, panel);
		}

		// ---- 插件入口 ----
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-balance-panel",
				inject: () => ({})
			}, BalancePanel));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
