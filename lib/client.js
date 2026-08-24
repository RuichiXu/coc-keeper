/**
 * dsh-coc-keeper 浏览器端完整 KP/玩家面板（酒馆风格）。
 *
 * 自包含经典脚本 bundle：由 dsh-client-modules 原样服务，
 * 浏览器内核经 window.__ModuleLoader__ 注册并物化。
 * 通过宿主 /coc-api 读写游戏状态：
 *   GET  /coc-api/state?game=&after=   状态摘要 + 增量日志
 *   POST /coc-api/chat                 玩家输入 → AI-KP 推进剧情
 *   POST /coc-api/tool                 通用工具执行（roll/branch/scene/task/entity/pc…）
 *   POST /coc-api/import               导入规则/剧本(PDF/文本)/人物
 *   POST /coc-api/read                 阅读已导入全文
 */
(function () {
	"use strict";

	if (typeof window === "undefined" || typeof window.__ModuleLoader__ === "undefined") return;

	window.__ModuleLoader__.load({
		id: "@dsh-external/dsh-coc-keeper",
		factory: function (require) {
			var module = { exports: {} };
			var exports = module.exports;

			var PANEL_ID = "coc-keeper-panel";
			var STYLE_ID = "coc-keeper-panel.css";
			var LS_GAME = "coc-keeper:game";
			var LS_TAB = "coc-keeper:tab";

			// ── 基础工具 ──
			function el(tag, attrs, text) {
				var node = document.createElement(tag);
				if (attrs) for (var key in attrs) if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
				if (text !== void 0) node.textContent = text;
				return node;
			}
			function esc(value) {
				return String(value ?? "").replace(/[&<>"']/g, function (c) {
					return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
				});
			}
			function gameId() { try { return localStorage.getItem(LS_GAME) || "default"; } catch { return "default"; } }
			function setGame(id) { try { localStorage.setItem(LS_GAME, id || "default"); } catch { /* ignore */ } }
			function tabPref() { try { return localStorage.getItem(LS_TAB) || "chat"; } catch { return "chat"; } }
			function setTabPref(t) { try { localStorage.setItem(LS_TAB, t); } catch { /* ignore */ } }

			function api(path, options) {
				return fetch(path, options).then(function (res) {
					return res.json().catch(function () { return { ok: false, error: "响应解析失败" }; });
				});
			}
			function post(path, body) {
				return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ game: gameId() }, body)) });
			}
			function tool(name, args) {
				return post("/coc-api/tool", { name: name, args: Object.assign({ game: gameId() }, args || {}) });
			}
			function fmtTime(iso) {
				if (!iso) return "";
				try { return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
			}

			// ── 全局面板状态 ──
			var S = { digest: null, entries: [], seq: 0, tab: tabPref(), busy: false, error: "" };

			// ── 样式 ──
			var STYLE = [
				"#coc-keeper-panel{position:fixed;right:12px;bottom:12px;z-index:9999;width:min(520px,96vw);height:min(90vh,820px);display:flex;flex-direction:column;border-radius:16px;overflow:hidden;box-shadow:0 14px 48px rgba(8,14,34,.5);border:1px solid rgba(110,145,215,.42);background:#0c1532;color:#e6ebf8;font:13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}",
				"#coc-keeper-panel *{box-sizing:border-box}",
				"#coc-keeper-panel button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid rgba(140,170,230,.45);background:rgba(72,104,176,.26);color:#e6ebf8;padding:4px 10px;transition:background .12s,transform .08s,opacity .12s}",
				"#coc-keeper-panel button:hover{background:rgba(104,140,220,.4)}",
				"#coc-keeper-panel button:active{transform:translateY(1px)}",
				"#coc-keeper-panel button:disabled{opacity:.45;cursor:not-allowed}",
				"#coc-keeper-panel input,#coc-keeper-panel textarea,#coc-keeper-panel select{font:inherit;color:#e6ebf8;background:rgba(18,30,66,.92);border:1px solid rgba(120,150,215,.4);border-radius:7px;padding:5px 8px;width:100%}",
				"#coc-keeper-panel textarea{resize:vertical;min-height:54px}",
				"#coc-keeper-panel .coc-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(4,8,24,.5);border-bottom:1px solid rgba(140,170,230,.22);cursor:move;user-select:none;flex:none}",
				"#coc-keeper-panel .coc-head b{flex:1;font-size:13px;letter-spacing:.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				"#coc-keeper-panel .coc-head input{width:92px;flex:none;padding:3px 7px;font-size:12px}",
				"#coc-keeper-panel .coc-chat{flex:1;overflow-y:auto;padding:12px 12px 6px;display:flex;flex-direction:column;gap:7px;min-height:120px;scroll-behavior:smooth}",
				"#coc-keeper-panel .coc-msg{max-width:88%;padding:7px 11px;border-radius:12px;white-space:pre-wrap;word-break:break-word;font-size:13px}",
				"#coc-keeper-panel .coc-msg.kp{align-self:flex-start;background:#1a2c5e;border:1px solid rgba(130,165,235,.35);border-bottom-left-radius:4px}",
				"#coc-keeper-panel .coc-msg.user{align-self:flex-end;background:#24407f;border:1px solid rgba(150,180,240,.4);border-bottom-right-radius:4px}",
				"#coc-keeper-panel .coc-msg.sys{align-self:center;background:rgba(120,140,190,.16);color:#aebce0;font-size:11.5px;padding:4px 12px;border-radius:999px}",
				"#coc-keeper-panel .coc-msg .who{display:block;font-size:10.5px;color:#8fa4d4;margin-bottom:2px;letter-spacing:.04em}",
				"#coc-keeper-panel .coc-typing{align-self:flex-start;color:#93a6d0;font-size:12px;padding:4px 2px}",
				"#coc-keeper-panel .coc-composer{flex:none;border-top:1px solid rgba(140,170,230,.2);padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:rgba(4,8,24,.35)}",
				"#coc-keeper-panel .coc-composer textarea{min-height:48px;max-height:160px}",
				"#coc-keeper-panel .coc-send-row{display:flex;gap:6px;align-items:center}",
				"#coc-keeper-panel .coc-send-row .send{flex:1;font-weight:600;background:rgba(60,110,200,.42)}",
				"#coc-keeper-panel .coc-quick{display:grid;grid-template-columns:1fr 64px 70px 1fr;gap:5px}",
				"#coc-keeper-panel .coc-quick .q2{display:flex;gap:5px;grid-column:1/-1}",
				"#coc-keeper-panel .coc-quick .q2 button{flex:1;font-size:12px}",
				"#coc-keeper-panel .coc-tabs{flex:none;display:flex;border-top:1px solid rgba(140,170,230,.2);background:rgba(4,8,24,.45)}",
				"#coc-keeper-panel .coc-tabs button{flex:1;border:0;border-radius:0;background:transparent;padding:7px 2px;font-size:12px;color:#9db0d8;border-bottom:2px solid transparent}",
				"#coc-keeper-panel .coc-tabs button.on{color:#ffd98a;border-bottom-color:#e6b45c;background:rgba(120,90,30,.12)}",
				"#coc-keeper-panel .coc-panel{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}",
				"#coc-keeper-panel .coc-card{border:1px solid rgba(120,150,215,.28);border-radius:11px;padding:9px 11px;background:rgba(22,40,86,.35)}",
				"#coc-keeper-panel .coc-card h4{margin:0 0 7px;font-size:11px;letter-spacing:.12em;color:#9fb2dd;text-transform:uppercase}",
				"#coc-keeper-panel .coc-row{display:flex;align-items:center;gap:6px;margin:4px 0}",
				"#coc-keeper-panel .coc-kv{color:#cdd8f0;margin:3px 0}",
				"#coc-keeper-panel .coc-kv b{color:#8fa4d4;font-weight:600;margin-right:5px}",
				"#coc-keeper-panel .coc-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid rgba(160,190,240,.4);background:rgba(90,120,200,.25)}",
				"#coc-keeper-panel .coc-badge.ai{color:#ffd98a;border-color:rgba(255,205,130,.55);background:rgba(160,120,40,.25)}",
				"#coc-keeper-panel .coc-badge.human{color:#9fe0c0;border-color:rgba(120,220,170,.5);background:rgba(40,130,90,.25)}",
				"#coc-keeper-panel .coc-opt{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}",
				"#coc-keeper-panel .coc-opt button{font-size:12px;border-color:rgba(190,160,90,.55);background:rgba(150,120,50,.22)}",
				"#coc-keeper-panel .coc-kp-item{margin:3px 0;padding:4px 0;border-bottom:1px dashed rgba(120,150,215,.18)}",
				"#coc-keeper-panel .coc-kp-item:last-child{border-bottom:0}",
				"#coc-keeper-panel .coc-kp-item.revealed{color:#9fe0c0}",
				"#coc-keeper-panel .coc-scene-tag{color:#7f93c2;font-size:11px}",
				"#coc-keeper-panel .coc-bar{height:7px;border-radius:99px;background:rgba(255,255,255,.09);overflow:hidden;margin-top:3px}",
				"#coc-keeper-panel .coc-bar>i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#5d8ae0,#8fb0f0)}",
				"#coc-keeper-panel .coc-bar.san>i{background:linear-gradient(90deg,#7a5cd0,#b08ff0)}",
				"#coc-keeper-panel .coc-bar.hp>i{background:linear-gradient(90deg,#4aa07a,#7fd0a8)}",
				"#coc-keeper-panel .coc-bar.luck>i{background:linear-gradient(90deg,#c0a050,#f0d080)}",
				"#coc-keeper-panel .coc-mini{font-size:11px;color:#93a6d0}",
				"#coc-keeper-panel .coc-inv{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}",
				"#coc-keeper-panel .coc-inv span{background:rgba(90,120,200,.22);border:1px solid rgba(130,160,225,.3);border-radius:6px;padding:1px 7px;font-size:11.5px}",
				"#coc-keeper-panel .coc-inv button{margin-left:4px;padding:0 5px;font-size:10.5px;background:rgba(180,70,70,.3)}",
				"#coc-keeper-panel .coc-task{display:flex;align-items:center;gap:7px;padding:3px 0;border-bottom:1px dashed rgba(120,150,215,.16)}",
				"#coc-keeper-panel .coc-task:last-child{border-bottom:0}",
				"#coc-keeper-panel .coc-task input[type=checkbox]{width:15px;height:15px;flex:none;accent-color:#8fb0f0}",
				"#coc-keeper-panel .coc-task.done span{text-decoration:line-through;color:#7f93c2}",
				"#coc-keeper-panel .coc-task span{flex:1}",
				"#coc-keeper-panel .coc-empty{color:#8b9cc4;font-style:italic;font-size:12.5px}",
				"#coc-keeper-panel .coc-tip{color:#7f93c2;font-size:11.5px;line-height:1.6}",
				"#coc-keeper-panel .coc-note{color:#ffd98a;font-size:12px;min-height:16px}",
				"#coc-keeper-panel .coc-hint{color:#e0a0a0;font-size:12px}",
				"#coc-keeper-panel .coc-field{margin:5px 0}",
				"#coc-keeper-panel .coc-field label{display:block;font-size:11px;color:#93a6d0;margin-bottom:3px}",
				"#coc-keeper-panel .coc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:6px}",
				"#coc-keeper-panel .coc-btnrow{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}",
				"#coc-keeper-panel .coc-btnrow button{font-size:12px}",
				"#coc-keeper-panel .coc-file{position:relative;overflow:hidden}",
				"#coc-keeper-panel .coc-file input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer}",
				"#coc-keeper-panel .coc-result-box{margin-top:7px;padding:6px 9px;border-radius:8px;background:rgba(0,0,0,.25);font-size:12px;white-space:pre-wrap;color:#ffe9b0;max-height:200px;overflow:auto}",
				"#coc-keeper-panel .coc-result-box.err{color:#ffb0a8}",
				"#coc-keeper-panel .coc-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(8,14,34,.72);z-index:10;font-size:13px;color:#ffd98a;backdrop-filter:blur(2px)}",
				"#coc-keeper-panel .coc-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 52%,rgba(150,180,240,.55) 52%);border-bottom-right-radius:16px;z-index:5}",
				"#coc-keeper-panel .coc-resize-top{position:absolute;top:-3px;left:8px;right:8px;height:6px;cursor:n-resize;z-index:5}",
				"#coc-keeper-panel .coc-resize-bottom{position:absolute;bottom:-3px;left:8px;right:8px;height:6px;cursor:s-resize;z-index:5}",
				"#coc-keeper-panel .coc-resize-left{position:absolute;left:-3px;top:8px;bottom:8px;width:6px;cursor:w-resize;z-index:5}",
				"#coc-keeper-panel .coc-resize-right{position:absolute;right:-3px;top:8px;bottom:8px;width:6px;cursor:e-resize;z-index:5}",
				"#coc-keeper-panel .coc-resize-top:hover,#coc-keeper-panel .coc-resize-bottom:hover,#coc-keeper-panel .coc-resize-left:hover,#coc-keeper-panel .coc-resize-right:hover{background:rgba(150,180,240,.25)}",
				"#coc-keeper-panel .coc-max-btn{background:transparent;border:0;padding:2px 6px;font-size:14px;cursor:pointer;color:#9db0d8;margin-left:auto}",
				"#coc-keeper-panel .coc-max-btn:hover{color:#ffd98a}",
				"#coc-keeper-panel .coc-divider{flex:none;height:5px;cursor:ns-resize;background:rgba(140,170,230,.12);border-top:1px solid rgba(140,170,230,.15);border-bottom:1px solid rgba(140,170,230,.15);position:relative}",
				"#coc-keeper-panel .coc-divider:hover{background:rgba(140,170,230,.25)}",
				"#coc-keeper-panel .coc-divider::after{content:'';display:block;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:30px;height:2px;border-radius:2px;background:rgba(140,170,230,.4)}",
				"#coc-keeper-panel .coc-chat{flex:1;overflow-y:auto;padding:12px 12px 6px;display:flex;flex-direction:column;gap:7px;min-height:60px;scroll-behavior:smooth}",
				"#coc-keeper-player-panel{position:fixed;left:12px;bottom:12px;z-index:9998;width:min(360px,94vw);display:flex;flex-direction:column;border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(8,14,34,.45);border:1px solid rgba(110,145,215,.38);background:#0c1532;color:#e6ebf8;font:13px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif}",
				"#coc-keeper-player-panel *{box-sizing:border-box}",
				"#coc-keeper-player-panel button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid rgba(140,170,230,.45);background:rgba(72,104,176,.26);color:#e6ebf8;padding:4px 10px}",
				"#coc-keeper-player-panel button:hover{background:rgba(104,140,220,.4)}",
				"#coc-keeper-player-panel input,#coc-keeper-player-panel textarea{font:inherit;color:#e6ebf8;background:rgba(18,30,66,.92);border:1px solid rgba(120,150,215,.4);border-radius:7px;padding:5px 8px;width:100%}",
				"#coc-keeper-player-panel .pp-head{display:flex;align-items:center;gap:8px;padding:7px 11px;background:rgba(4,8,24,.5);border-bottom:1px solid rgba(140,170,230,.22);cursor:move;flex:none}",
				"#coc-keeper-player-panel .pp-head b{flex:1;font-size:13px;letter-spacing:.05em}",
				"#coc-keeper-player-panel .pp-body{flex:1;overflow-y:auto;padding:10px 11px;display:flex;flex-direction:column;gap:8px;max-height:70vh}",
				"#coc-keeper-player-panel .pp-card{border:1px solid rgba(120,150,215,.28);border-radius:10px;padding:8px 10px;background:rgba(22,40,86,.35)}",
				"#coc-keeper-player-panel .pp-card h4{margin:0 0 6px;font-size:11px;letter-spacing:.12em;color:#9fb2dd}",
				"#coc-keeper-player-panel .pp-kv{color:#cdd8f0;margin:2px 0}",
				"#coc-keeper-player-panel .pp-kv b{color:#8fa4d4;font-weight:600;margin-right:5px}",
				"#coc-keeper-player-panel .pp-msg{white-space:pre-wrap;word-break:break-word;font-size:12.5px}",
				"#coc-keeper-player-panel .pp-msg.user{color:#ffd98a}",
				"#coc-keeper-player-panel .pp-msg.kp{color:#cdd8f0}",
				"#coc-keeper-player-panel .pp-composer{border-top:1px solid rgba(140,170,230,.2);padding:7px 10px;display:flex;gap:6px;align-items:center;background:rgba(4,8,24,.35);flex:none}",
				"#coc-keeper-player-panel .pp-composer textarea{min-height:38px;max-height:120px;flex:1}"
			].join("\n");

			// ── 通用面板坞：右下角常驻 🧩，统一管理所有插件面板 ──
			var DOCK_ID = "dsh-panel-dock";
			var DOCK_STYLE_ID = "dsh-panel-dock.css";
			var dockPanels = [];
			var dockNode = null;
			var dockPop = null;

			function ensureDock() {
				if (dockNode !== null) return dockNode;
				var dockStyle = el("style", { id: DOCK_STYLE_ID, "data-plugin": "@dsh-external/dsh-coc-keeper", "data-plugin-css": DOCK_STYLE_ID });
				dockStyle.textContent = [
					"#dsh-panel-dock{position:fixed;right:14px;bottom:14px;z-index:10001;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}",
					"#dsh-panel-dock .dock-fab{width:46px;height:46px;border-radius:15px;border:1px solid rgba(150,180,240,.5);background:linear-gradient(180deg,#1b2f63,#0e1b42);color:#ffe9b0;font-size:20px;cursor:pointer;box-shadow:0 8px 26px rgba(8,14,34,.55);display:flex;align-items:center;justify-content:center;transition:transform .12s}",
					"#dsh-panel-dock .dock-fab:hover{transform:translateY(-2px)}",
					"#dsh-panel-dock .dock-pop{min-width:210px;border-radius:12px;border:1px solid rgba(120,150,215,.4);background:rgba(14,24,54,.97);box-shadow:0 12px 34px rgba(8,14,34,.6);overflow:hidden}",
					"#dsh-panel-dock .dock-head{padding:7px 11px;font-size:11px;letter-spacing:.1em;color:#9fb2dd;border-bottom:1px solid rgba(140,170,230,.2)}",
					"#dsh-panel-dock .dock-row{display:flex;align-items:center;gap:9px;padding:9px 11px;cursor:pointer;border-bottom:1px dashed rgba(120,150,215,.16)}",
					"#dsh-panel-dock .dock-row:last-child{border-bottom:0}",
					"#dsh-panel-dock .dock-row:hover{background:rgba(90,125,205,.22)}",
					"#dsh-panel-dock .dock-icon{font-size:17px}",
					"#dsh-panel-dock .dock-name{flex:1;color:#e6ebf8}",
					"#dsh-panel-dock .dock-state{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid rgba(130,160,225,.4);color:#8fa4d4}",
					"#dsh-panel-dock .dock-state.on{color:#9fe0c0;border-color:rgba(120,220,170,.5)}",
					"#dsh-panel-dock .dock-empty{padding:10px 12px;color:#8b9cc4;font-size:12px}"
				].join("\n");
				document.head.append(dockStyle);
				dockNode = el("div", { id: DOCK_ID });
				var fab = el("button", { type: "button", class: "dock-fab", title: "插件面板（统一管理所有面板）" }, "🧩");
				dockPop = el("div", { class: "dock-pop", style: "display:none" });
				dockNode.append(fab, dockPop);
				document.body.append(dockNode);
				fab.addEventListener("click", function (event) {
					event.stopPropagation();
					var open = dockPop.style.display === "none";
					dockPop.style.display = open ? "block" : "none";
					if (open) renderDockList();
				});
				document.addEventListener("click", function (event) {
					if (dockNode !== null && !dockNode.contains(event.target)) dockPop.style.display = "none";
				});
				return dockNode;
			}
			function renderDockList() {
				if (dockPop === null) return;
				dockPop.textContent = "";
				dockPop.append(el("div", { class: "dock-head" }, "插件面板"));
				if (dockPanels.length === 0) {
					dockPop.append(el("div", { class: "dock-empty" }, "暂无已注册的面板插件"));
					return;
				}
				dockPanels.forEach(function (entry) {
					var row = el("div", { class: "dock-row" });
					row.append(el("span", { class: "dock-icon" }, entry.icon || "🧩"));
					row.append(el("span", { class: "dock-name" }, entry.title || entry.id));
					var visible = typeof entry.isVisible === "function" && entry.isVisible();
					row.append(el("span", { class: "dock-state" + (visible ? " on" : "") }, visible ? "开" : "关"));
					row.addEventListener("click", function () {
						if (typeof entry.toggle === "function") entry.toggle();
						renderDockList();
					});
					dockPop.append(row);
				});
			}
			function refreshDockStates() {
				if (dockPop !== null && dockPop.style.display !== "none") renderDockList();
			}
			function registerDockPanel(entry) {
				ensureDock();
				dockPanels.push(entry);
				refreshDockStates();
				return function () {
					var index = dockPanels.indexOf(entry);
					if (index >= 0) dockPanels.splice(index, 1);
					refreshDockStates();
				};
			}
			if (typeof window.__dshPanelDock__ === "undefined") {
				window.__dshPanelDock__ = {
					register: registerDockPanel,
					panels: function () { return dockPanels.map(function (p) { return { id: p.id, title: p.title, icon: p.icon }; }); }
				};
			}

			// ── 面板位置/尺寸记忆 + 拖动/缩放 ──
			var LS_RECT = "coc-keeper:rect";
			var LS_VISIBLE = "coc-keeper:visible";
			function loadPanelRect() {
				try {
					var value = JSON.parse(localStorage.getItem(LS_RECT));
					if (value !== null && typeof value === "object" && typeof value.x === "number" && typeof value.y === "number") return value;
				} catch { /* ignore */ }
				return null;
			}
			function savePanelRect(panel) {
				try {
					var rect = panel.getBoundingClientRect();
					localStorage.setItem(LS_RECT, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }));
				} catch { /* ignore */ }
			}
			function loadPanelVisible() {
				try {
					var value = localStorage.getItem(LS_VISIBLE);
					return value === null ? true : value === "1";
				} catch { return true; }
			}
			function savePanelVisible(value) {
				try { localStorage.setItem(LS_VISIBLE, value ? "1" : "0"); } catch { /* ignore */ }
			}
			function enableDrag(target, handle) {
				handle.addEventListener("mousedown", function (event) {
					if (event.target.closest("button,input,select,textarea")) return;
					event.preventDefault();
					var startX = event.clientX;
					var startY = event.clientY;
					var rect = target.getBoundingClientRect();
					function move(ev) {
						var x = rect.left + ev.clientX - startX;
						var y = rect.top + ev.clientY - startY;
						x = Math.max(60 - rect.width, Math.min(x, window.innerWidth - 60));
						y = Math.max(0, Math.min(y, window.innerHeight - 44));
						target.style.left = x + "px";
						target.style.top = y + "px";
						target.style.right = "auto";
						target.style.bottom = "auto";
					}
					function up() {
						document.removeEventListener("mousemove", move);
						savePanelRect(target);
					}
					document.addEventListener("mousemove", move);
					document.addEventListener("mouseup", up, { once: true });
				});
			}
			function enableResize(target, handle, direction) {
				handle.addEventListener("mousedown", function (event) {
					event.preventDefault();
					event.stopPropagation();
					var startX = event.clientX;
					var startY = event.clientY;
					var width = target.offsetWidth;
					var height = target.offsetHeight;
					var rect = target.getBoundingClientRect();
					var startLeft = rect.left;
					var startTop = rect.top;
					function move(ev) {
						var dx = ev.clientX - startX;
						var dy = ev.clientY - startY;
						var w = width;
						var h = height;
						var left = startLeft;
						var top = startTop;
						if (direction === "e" || !direction) {
							w = width + dx;
						}
						if (direction === "s" || !direction) {
							h = height + dy;
						}
						if (direction === "w") {
							w = width - dx;
							left = startLeft + dx;
						}
						if (direction === "n") {
							h = height - dy;
							top = startTop + dy;
						}
						w = Math.max(320, Math.min(w, window.innerWidth - 40));
						h = Math.max(400, Math.min(h, window.innerHeight - 40));
						target.style.width = w + "px";
						target.style.height = h + "px";
						if (direction === "w" || direction === "n") {
							target.style.left = left + "px";
							target.style.top = top + "px";
							target.style.right = "auto";
							target.style.bottom = "auto";
						}
					}
					function up() {
						document.removeEventListener("mousemove", move);
						savePanelRect(target);
					}
					document.addEventListener("mousemove", move);
					document.addEventListener("mouseup", up, { once: true });
				});
			}
			// 可拖拽分隔条：调整聊天区与输入区的比例
			function enableDividerDrag(divider, chatArea, composerArea) {
				divider.addEventListener("mousedown", function (event) {
					event.preventDefault();
					event.stopPropagation();
					var startY = event.clientY;
					var panelHeight = divider.parentElement.offsetHeight;
					var dividerHeight = divider.offsetHeight;
					var composerHeight = composerArea.offsetHeight;
					var startChatHeight = chatArea.offsetHeight;
					function move(ev) {
						var dy = ev.clientY - startY;
						var newChatH = startChatHeight + dy;
						// 最小聊天高度 60px，最小输入区高度 120px
						var minComposer = 120;
						var maxChatH = panelHeight - dividerHeight - minComposer;
						newChatH = Math.max(60, Math.min(newChatH, maxChatH));
						chatArea.style.flex = "none";
						chatArea.style.height = newChatH + "px";
					}
					function up() {
						document.removeEventListener("mousemove", move);
					}
					document.addEventListener("mousemove", move);
					document.addEventListener("mouseup", up, { once: true });
				});
			}

			// ── DOM 骨架 ──
			function mountPanel() {
				if (document.getElementById(PANEL_ID) !== null) return function () { /* already mounted */ };

				var style = el("style", { id: STYLE_ID, "data-plugin": "@dsh-external/dsh-coc-keeper", "data-plugin-css": STYLE_ID });
				style.textContent = STYLE;
				document.head.append(style);

				var panel = el("div", { id: PANEL_ID });
				var loading = el("div", { class: "coc-loading" }, "加载中…");
				panel.append(loading);

				// 恢复记忆的位置与尺寸
				var savedRect = loadPanelRect();
				if (savedRect !== null) {
					panel.style.left = savedRect.x + "px";
					panel.style.top = savedRect.y + "px";
					panel.style.width = savedRect.w + "px";
					panel.style.height = savedRect.h + "px";
					panel.style.right = "auto";
					panel.style.bottom = "auto";
				}

				// 头部（按住可拖动）
				var head = el("div", { class: "coc-head", title: "按住拖动移动面板" });
				head.append(el("b", null, "🎲 CoC Keeper"));
				var gameSelect = el("select", { title: "选择游戏场次" });
				gameSelect.style.width = "118px";
				gameSelect.style.flex = "none";
				head.append(gameSelect);
				var newGameBtn = el("button", { type: "button", title: "新建游戏场次" }, "＋");
				head.append(newGameBtn);
				var refreshBtn = el("button", { type: "button", title: "刷新" }, "⟳");
				head.append(refreshBtn);
				var hideBtn = el("button", { type: "button", title: "最小化到面板坞（右下角 🧩 恢复）" }, "🗕");
				head.append(hideBtn);
				panel.append(head);

				// 聊天区
				var chat = el("div", { class: "coc-chat" });
				panel.append(chat);

				// 可拖拽分隔条
				var divider = el("div", { class: "coc-divider", title: "拖动调整聊天区高度" });
				panel.append(divider);

				// 输入区（包含快捷掷骰）
				var composer = el("div", { class: "coc-composer" });
				var input = el("textarea", { placeholder: "输入你的行动…（回车发送，Shift+回车换行）" });
				var sendRow = el("div", { class: "coc-send-row" });
				var note = el("div", { class: "coc-note" });
				var sendBtn = el("button", { type: "button", class: "send" }, "发送");
				sendRow.append(note, sendBtn);
				composer.append(input, sendRow);
				// 快捷掷骰
				var quick = el("div", { class: "coc-quick" });
				var qExpr = el("input", { type: "text", value: "d100", title: "骰式", spellcheck: "false" });
				var qTarget = el("input", { type: "number", min: "1", max: "200", placeholder: "目标值", title: "目标技能值" });
				var qDiff = el("select", null);
				[["regular", "常规"], ["hard", "困难"], ["extreme", "极限"]].forEach(function (pair) { qDiff.append(el("option", { value: pair[0] }, pair[1])); });
				var qLabel = el("input", { type: "text", placeholder: "检定说明", spellcheck: "false" });
				var qBtns = el("div", { class: "q2" });
				var qOpen = el("button", { type: "button", title: "明骰（结果公开）" }, "🎲 明骰");
				var qSecret = el("button", { type: "button", title: "暗骰（仅 KP 可见）" }, "🔒 暗骰");
				qBtns.append(qOpen, qSecret);
				quick.append(qExpr, qTarget, qDiff, qLabel, qBtns);
				composer.append(quick);
				panel.append(composer);

				// 分隔条拖拽
				enableDividerDrag(divider, chat, composer);

				// 标签页
				// 标签页：主持 / 剧情 / 调试（调试含导入·实体·设置）
				var tabs = el("div", { class: "coc-tabs" });
				var TAB_DEFS = [["dm", "主持"], ["plot", "剧情"], ["debug", "调试"]];
				var tabButtons = {};
				TAB_DEFS.forEach(function (pair) {
					var btn = el("button", { type: "button", "data-tab": pair[0] }, pair[1]);
					tabButtons[pair[0]] = btn;
					tabs.append(btn);
				});
				panel.append(tabs);

				// 面板容器：dm / plot / debug 为顶级；status、plotInner 归 plot；ents、import、settings 归 debug
				var panels = {};
				["dm", "plot", "debug"].forEach(function (key) {
					var box = el("div", { class: "coc-panel", "data-panel": key });
					box.style.display = "none";
					panels[key] = box;
					panel.append(box);
				});
				["status", "plotInner", "ents", "import", "settings"].forEach(function (key) {
					var box = el("div", { class: "coc-subpanel", "data-subpanel": key });
					panels[key] = box;
				});
				panels.plot.append(panels.status, panels.plotInner);
				panels.debug.append(panels.ents, panels.import, panels.settings);
				// renderPlotPanel 等旧函数写入 panels.plot；这里把其输出指向 plotInner 以保持语义

				document.body.append(panel);

				// 缩放手柄（四边 + 右下角）
				var resizeHandle = el("div", { class: "coc-resize", title: "拖动调整大小" });
				var resizeTop = el("div", { class: "coc-resize-top", title: "拖动调整高度" });
				var resizeBottom = el("div", { class: "coc-resize-bottom", title: "拖动调整高度" });
				var resizeLeft = el("div", { class: "coc-resize-left", title: "拖动调整宽度" });
				var resizeRight = el("div", { class: "coc-resize-right", title: "拖动调整宽度" });
				panel.append(resizeHandle, resizeTop, resizeBottom, resizeLeft, resizeRight);
				enableDrag(panel, head);
				enableResize(panel, resizeHandle);
				enableResize(panel, resizeTop, "n");
				enableResize(panel, resizeBottom, "s");
				enableResize(panel, resizeLeft, "w");
				enableResize(panel, resizeRight, "e");

				// 最大化按钮
				var maxBtn = el("button", { type: "button", class: "coc-max-btn", title: "最大化/还原" }, "⛶");
				head.append(maxBtn);
				maxBtn.addEventListener("click", function () {
					if (panel.classList.contains("coc-maximized")) {
						panel.classList.remove("coc-maximized");
						panel.style.width = "";
						panel.style.height = "";
						panel.style.left = "";
						panel.style.top = "";
						panel.style.right = "12px";
						panel.style.bottom = "12px";
						maxBtn.textContent = "⛶";
					} else {
						panel.classList.add("coc-maximized");
						panel.style.width = "100vw";
						panel.style.height = "100vh";
						panel.style.left = "0";
						panel.style.top = "0";
						panel.style.right = "auto";
						panel.style.bottom = "auto";
						panel.style.borderRadius = "0";
						maxBtn.textContent = "⤡";
					}
				});

				// 显隐（最小化到面板坞）
				if (!loadPanelVisible()) panel.style.display = "none";
				function setVisible(value) {
					panel.style.display = value ? "flex" : "none";
					savePanelVisible(value);
					refreshDockStates();
				}
				hideBtn.addEventListener("click", function () { setVisible(false); });

				// 注册进全局面板坞（右下角 🧩 统一管理）
				var unregisterDock = registerDockPanel({
					id: "@dsh-external/dsh-coc-keeper",
					title: "CoC 跑团",
					icon: "🎲",
					isVisible: function () { return panel.style.display !== "none"; },
					toggle: function () { setVisible(panel.style.display === "none"); }
				});

				// ── 标签切换 ──
				// ── 标签切换 ──
				function showTab(key) {
					S.tab = key;
					setTabPref(key);
					["dm", "plot", "debug"].forEach(function (k) { panels[k].style.display = k === key ? "flex" : "none"; });
					Object.keys(tabButtons).forEach(function (k) { tabButtons[k].classList.toggle("on", k === key); });
					if (key === "plot") { renderStatusPanel(); renderPlotPanel(); }
					else if (key === "debug") renderDebugPanel();
					else renderDmPanel();
				}
				Object.keys(tabButtons).forEach(function (key) {
					tabButtons[key].addEventListener("click", function () { showTab(key); });
				});
				gameSelect.addEventListener("change", function () {
					setGame(gameSelect.value || "default");
					resetSession();
					poll(true);
				});
				newGameBtn.addEventListener("click", function () {
					var id = prompt("新游戏 ID：", "game-" + Date.now().toString(36));
					if (id === null || id.trim().length === 0) return;
					post("/coc-api/game-create", { game: id.trim() }).then(function (json) {
						if (json.ok) { setGame(id.trim()); resetSession(); poll(true); }
						else alert("创建失败：" + (json.error || "未知错误"));
					});
				});
				refreshBtn.addEventListener("click", function () { poll(true); });
				// ── 发送 ──
				function sendChat() {
					var text = input.value.trim();
					if (text.length === 0 || S.busy) return;
					input.value = "";
					note.textContent = "KP 思考中…";
					S.busy = true;
					sendBtn.disabled = true;
					qOpen.disabled = true;
					qSecret.disabled = true;
					var typing = el("div", { class: "coc-typing" }, "🕯 KP 正在回应…");
					chat.append(typing);
					chat.scrollTop = chat.scrollHeight;
					post("/coc-api/chat", { text: text, player: "玩家" }).then(function (json) {
						typing.remove();
						if (!json.ok) {
							note.textContent = "失败：" + (json.error || "未知错误");
							if (json.error && /回复中|思考中/.test(json.error)) poll(true);
						} else {
							note.textContent = "";
							resetSession();
							poll(true);
						}
					}).catch(function (err) {
						typing.remove();
						note.textContent = "请求失败：" + err.message;
					}).finally(function () {
						S.busy = false;
						sendBtn.disabled = false;
						qOpen.disabled = false;
						qSecret.disabled = false;
					});
				}
				sendBtn.addEventListener("click", sendChat);
				input.addEventListener("keydown", function (event) {
					if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendChat(); }
				});

				// ── 快捷掷骰 ──
				function quickRoll(secret) {
					if (S.busy) return;
					var args = {
						expression: qExpr.value.trim() || "d100",
						target: qTarget.value === "" ? void 0 : Number(qTarget.value),
						difficulty: qDiff.value,
						label: qLabel.value.trim(),
						player: "玩家"
					};
					note.textContent = "掷骰中…";
					post("/coc-api/roll", Object.assign({ secret: secret }, args)).then(function (json) {
						note.textContent = json.ok ? "" : "失败：" + (json.error || "");
						if (json.ok) { resetSession(); poll(true); }
					}).catch(function (err) { note.textContent = "请求失败：" + err.message; });
				}
				qOpen.addEventListener("click", function () { quickRoll(false); });
				qSecret.addEventListener("click", function () { quickRoll(true); });

				// ── 数据轮询 ──
				function resetSession() {
					S.entries = [];
					S.seq = 0;
					chat.textContent = "";
				}
				function poll(force) {
					refreshGames();
					return api("/coc-api/state?game=" + encodeURIComponent(gameId()) + "&after=" + S.seq).then(function (json) {
						loading.style.display = "none";
						if (json.ok) {
							S.digest = json.data;
							if (Array.isArray(json.entries) && json.entries.length > 0) {
								S.entries = S.entries.concat(json.entries);
								S.seq = json.seq;
								renderChatEntries(json.entries);
							}
							if (force) { renderChatFull(); renderPanel(S.tab); }
						} else {
							S.error = json.error || "";
						}
						return json;
					}).catch(function () { loading.style.display = "none"; });
				}
				function refreshGames() {
					return api("/coc-api/games").then(function (json) {
						if (!json.ok) return;
						var current = gameId();
						gameSelect.textContent = "";
						(json.data || []).forEach(function (g) {
							var opt = el("option", { value: g.id }, g.title + (g.scenario ? " · " + g.scenario.name : ""));
							if (g.id === current) opt.selected = true;
							gameSelect.append(opt);
						});
						if (gameSelect.options.length === 0) {
							gameSelect.append(el("option", { value: current }, current));
						}
					});
				}

				// ── 聊天渲染 ──
				function entryNode(entry) {
					var box = el("div", { class: "coc-msg " + (entry.kind === "user" ? "user" : entry.kind === "kp" ? "kp" : "sys") });
					if (entry.kind === "user") {
						box.append(el("span", { class: "who" }, esc(entry.player || "玩家") + " · " + fmtTime(entry.at)));
						box.append(document.createTextNode(entry.text));
					} else if (entry.kind === "kp") {
						box.append(el("span", { class: "who" }, "KP · " + fmtTime(entry.at)));
						box.append(document.createTextNode(entry.text));
					} else {
						box.append(document.createTextNode(entry.text));
					}
					return box;
				}
				function renderChatEntries(entries) {
					for (var i = 0; i < entries.length; i += 1) chat.append(entryNode(entries[i]));
					chat.scrollTop = chat.scrollHeight;
				}
				function renderChatFull() {
					chat.textContent = "";
					if (S.digest === null) {
						chat.append(el("div", { class: "coc-msg sys" }, "尚无游戏数据：在下方输入行动即自动创建游戏，或到「导入」页导入剧本/规则/人物。"));
					} else {
						for (var i = 0; i < S.entries.length; i += 1) chat.append(entryNode(S.entries[i]));
					}
					chat.scrollTop = chat.scrollHeight;
				}

				// ── 面板渲染入口 ──
				function renderPanel(key) {
					if (key === "plot") { renderStatusPanel(); renderPlotPanel(); }
					else if (key === "debug") renderDebugPanel();
					else renderDmPanel();
				}
				// ── 主持页：KP 自然语言指令（预览 → 确认执行） ──
				var kpCommandInput = null;
				var kpPreviewBox = null;
				function renderDmPanel() {
					var box = panels.dm;
					box.textContent = "";
					var card = el("div", { class: "coc-card" });
					card.append(el("h4", null, "KP 指令（自然语言 → 结构化工具调用）"));
					kpCommandInput = el("textarea", { placeholder: "例如：让守秘人做一个暗骰，看玩家是否发现门后的血迹" });
					card.append(kpCommandInput);
					var row = el("div", { class: "coc-row" });
					var previewBtn = el("button", { type: "button" }, "解析预览");
					var execBtn = el("button", { type: "button", style: "background:rgba(60,110,200,.42);font-weight:600" }, "确认执行");
					execBtn.disabled = true;
					row.append(previewBtn, execBtn);
					card.append(row);
					kpPreviewBox = el("div", { class: "coc-kp-item" });
					card.append(kpPreviewBox);
					box.append(card);
					var pendingCalls = [];
					previewBtn.addEventListener("click", function () {
						var cmd = kpCommandInput.value.trim();
						if (cmd.length === 0) return;
						previewBtn.disabled = true;
						kpPreviewBox.textContent = "解析中…";
						post("/coc-api/kp-command", { command: cmd }).then(function (json) {
							previewBtn.disabled = false;
							if (!json.ok) { kpPreviewBox.textContent = "失败：" + (json.error || "未知错误"); return; }
							var calls = json.data.calls || [];
							pendingCalls = calls;
							if (calls.length === 0) { kpPreviewBox.textContent = "⚠ " + (json.data.warning || "LLM 未能解析出工具调用"); execBtn.disabled = true; return; }
							kpPreviewBox.textContent = "";
							calls.forEach(function (call, i) {
								var line = el("div", { class: "coc-kv" });
								line.textContent = (i + 1) + ". " + call.name + "(" + JSON.stringify(call.args || {}) + ")";
								kpPreviewBox.append(line);
							});
							execBtn.disabled = false;
						});
					});
					execBtn.addEventListener("click", function () {
						if (pendingCalls.length === 0) return;
						execBtn.disabled = true;
						kpPreviewBox.textContent = "执行中…";
						post("/coc-api/kp-command", { action: "execute", calls: pendingCalls }).then(function (json) {
							execBtn.disabled = false;
							if (!json.ok) { kpPreviewBox.textContent = "失败：" + (json.error || "未知错误"); return; }
							kpPreviewBox.textContent = "";
							(json.data || []).forEach(function (r) {
								var line = el("div", { class: "coc-kv" });
								line.textContent = (r.ok ? "✓ " : "✗ ") + r.name + " " + (r.render || r.error || "");
								kpPreviewBox.append(line);
							});
							poll(true);
						});
					});
				}
				// ── 调试页：导入 / 实体 / 设置 子切换 ──
				var debugTab = "import";
				function renderDebugPanel() {
					var box = panels.debug;
					box.textContent = "";
					var row = el("div", { class: "coc-row" });
					[["import", "导入"], ["ents", "实体"], ["settings", "设置"]].forEach(function (pair) {
						var btn = el("button", { type: "button", style: "flex:1" }, pair[1]);
						if (debugTab === pair[0]) btn.style.background = "rgba(120,90,30,.5)";
						btn.addEventListener("click", function () { debugTab = pair[0]; renderDebugPanel(); });
						row.append(btn);
					});
					box.append(row);
					panels.import.style.display = "none";
					panels.ents.style.display = "none";
					panels.settings.style.display = "none";
					box.append(panels.import, panels.ents, panels.settings);
					if (debugTab === "import") { panels.import.style.display = "block"; panels.ents.style.display = "none"; panels.settings.style.display = "none"; renderImportPanel(); }
					else if (debugTab === "ents") { panels.import.style.display = "none"; panels.ents.style.display = "block"; panels.settings.style.display = "none"; renderEntsPanel(); }
					else { panels.import.style.display = "none"; panels.ents.style.display = "none"; panels.settings.style.display = "block"; renderSettingsPanel(); }
				}
				function kv(parent, label, value) {
					var row = el("div", { class: "coc-kv" });
					row.append(el("b", null, label), el("span", null, value));
					parent.append(row);
					return row;
				}
				function bar(parent, label, value, max, kind, onMinus, onPlus) {
					var row = el("div", { class: "coc-row" });
					var text = el("span", { style: "width:108px;flex:none" }, label + " " + value + "/" + (max || "?"));
					row.append(text);
					if (onMinus) row.append(el("button", { type: "button", style: "padding:0 7px" }, "−"));
					var track = el("div", { class: "coc-bar " + (kind || ""), style: "flex:1" });
					var pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
					track.append(el("i", { style: "width:" + pct.toFixed(1) + "%" }));
					row.append(track);
					if (onPlus) row.append(el("button", { type: "button", style: "padding:0 7px" }, "＋"));
					parent.append(row);
					var btns = row.querySelectorAll("button");
					if (onMinus) btns[0].addEventListener("click", onMinus);
					if (onPlus) btns[btns.length - 1].addEventListener("click", onPlus);
				}
				function setNote(container, json) {
					var noteEl = container.querySelector(".coc-note");
					if (!noteEl) {
						noteEl = el("div", { class: "coc-note" });
						container.append(noteEl);
					}
					noteEl.textContent = json && json.ok ? (json.render || "完成") : (json && json.error ? "失败：" + json.error : "");
				}

				// ── 状态页（概述/场景/时间/玩家状态栏/物品栏/任务栏） ──
				function renderStatusPanel() {
					var box = panels.status;
					box.textContent = "";
					if (S.digest === null) {
						box.append(el("div", { class: "coc-empty" }, "尚无游戏数据。"));
						return;
					}
					var d = S.digest;

					var overview = el("div", { class: "coc-card" });
					overview.append(el("h4", null, "剧情概述"));
					var synInput = el("textarea", { placeholder: "一句话剧情概述…" });
					synInput.value = d.synopsis || "";
					overview.append(synInput);
					var synSave = el("button", { type: "button" }, "保存概述");
					synSave.addEventListener("click", function () {
						tool("coc_scene", { synopsis: synInput.value }).then(function (json) { setNote(overview, json); poll(true); });
					});
					overview.append(synSave);
					box.append(overview);

					var stateCard = el("div", { class: "coc-card" });
					stateCard.append(el("h4", null, "剧情状态"));
					var modeRow = el("div", { class: "coc-row" });
					modeRow.append(el("span", { style: "flex:1" }, "KP 模式"));
					var modeBadge = el("span", { class: "coc-badge " + (d.kpMode === "human" ? "human" : "ai") }, d.kpMode === "human" ? "人类 KP" : "AI KP");
					modeRow.append(modeBadge);
					stateCard.append(modeRow);
					var modeBtns = el("div", { class: "coc-btnrow" });
					var aiBtn = el("button", { type: "button" }, "🤖 AI 当 KP");
					var huBtn = el("button", { type: "button" }, "🧑 人类 KP");
					[["ai", aiBtn], ["human", huBtn]].forEach(function (pair) {
						pair[1].addEventListener("click", function () {
							post("/coc-api/kp", { action: pair[0] }).then(function () { poll(true); });
						});
					});
					modeBtns.append(aiBtn, huBtn);
					stateCard.append(modeBtns);

					var sceneField = el("div", { class: "coc-field" });
					sceneField.append(el("label", null, "当前场景"));
					var sceneInput = el("input", { type: "text", value: d.currentScene || "", placeholder: "当前场景", spellcheck: "false" });
					sceneField.append(sceneInput);
					var sceneSave = el("button", { type: "button", style: "margin-top:5px" }, "保存场景");
					sceneSave.addEventListener("click", function () {
						tool("coc_scene", { scene: sceneInput.value }).then(function (json) { setNote(stateCard, json); poll(true); });
					});
					sceneField.append(sceneSave);
					stateCard.append(sceneField);

					var timeField = el("div", { class: "coc-field" });
					timeField.append(el("label", null, "游戏内时间"));
					var timeRow = el("div", { class: "coc-row" });
					var timeInput = el("input", { type: "text", value: d.time || "", placeholder: "1925年10月1日 下午3点", spellcheck: "false" });
					var timeSave = el("button", { type: "button" }, "保存");
					timeSave.addEventListener("click", function () {
						tool("coc_scene", { time: timeInput.value }).then(function (json) { setNote(stateCard, json); poll(true); });
					});
					timeRow.append(timeInput, timeSave);
					timeField.append(timeRow);
					var timeQuick = el("div", { class: "coc-btnrow" });
					[["hour", "+1 小时"], ["day", "+1 天"], ["night", "到夜晚"]].forEach(function (pair) {
						var btn = el("button", { type: "button" }, pair[1]);
						btn.addEventListener("click", function () {
							post("/coc-api/tool", { name: "coc_scene", args: { game: gameId(), timeAdvance: pair[0] } }).then(function () { poll(true); });
						});
						timeQuick.append(btn);
					});
					timeField.append(timeQuick);
					stateCard.append(timeField);
					box.append(stateCard);

					// 玩家状态栏
					var pcCard = el("div", { class: "coc-card" });
					pcCard.append(el("h4", null, "玩家状态栏"));
					if (d.characters.length === 0) {
						pcCard.append(el("div", { class: "coc-empty" }, "还没有调查员：到「人物」页添加，或「导入」页导入人物卡。"));
					}
					d.characters.forEach(function (pc) {
						var card = el("div", { class: "coc-card", style: "background:rgba(30,52,104,.3)" });
						card.append(el("h4", null, esc(pc.name) + (pc.occupation ? " · " + esc(pc.occupation) : "") + (pc.player ? " · " + esc(pc.player) : "")));
						bar(card, "HP", pc.hp, pc.stats ? pc.stats.HP : void 0, "hp",
							function () { tool("coc_pc", { name: pc.name, hp: (pc.hp || 0) - 1 }).then(function () { poll(true); }); },
							function () { tool("coc_pc", { name: pc.name, hp: (pc.hp || 0) + 1 }).then(function () { poll(true); }); });
						bar(card, "SAN", pc.san, 99, "san",
							function () { tool("coc_pc", { name: pc.name, san: (pc.san || 0) - 1 }).then(function () { poll(true); }); },
							function () { tool("coc_pc", { name: pc.name, san: (pc.san || 0) + 1 }).then(function () { poll(true); }); });
						bar(card, "MP", pc.mp, pc.stats ? pc.stats.MP : void 0, "", null, null);
						bar(card, "LUCK", pc.luck, 99, "luck", null, null);
						var invLabel = el("div", { class: "coc-kv" });
						invLabel.append(el("b", null, "物品栏"));
						card.append(invLabel);
						var inv = el("div", { class: "coc-inv" });
						if (pc.inventory.length === 0) inv.append(el("span", { style: "background:none;border:0;color:#7f93c2" }, "（空）"));
						pc.inventory.forEach(function (item) {
							var tag = el("span", null, esc(item));
							var rm = el("button", { type: "button", title: "移除" }, "✕");
							rm.addEventListener("click", function () {
								tool("coc_pc", { name: pc.name, inventoryRemove: item }).then(function () { poll(true); });
							});
							tag.append(rm);
							inv.append(tag);
						});
						card.append(inv);
						var invAddRow = el("div", { class: "coc-row" });
						var invAdd = el("input", { type: "text", placeholder: "添加物品…", spellcheck: "false" });
						var invBtn = el("button", { type: "button" }, "添加");
						invBtn.addEventListener("click", function () {
							if (invAdd.value.trim()) tool("coc_pc", { name: pc.name, inventoryAdd: invAdd.value.trim() }).then(function () { poll(true); });
						});
						invAddRow.append(invAdd, invBtn);
						card.append(invAddRow);
						pcCard.append(card);
					});
					box.append(pcCard);

					// 任务栏
					var taskCard = el("div", { class: "coc-card" });
					taskCard.append(el("h4", null, "任务栏"));
					if (d.tasks.length === 0) taskCard.append(el("div", { class: "coc-empty" }, "暂无任务"));
					d.tasks.forEach(function (task) {
						var row = el("div", { class: "coc-task" + (task.status === "done" ? " done" : "") });
						var check = el("input", { type: "checkbox" });
						check.checked = task.status === "done";
						check.addEventListener("change", function () {
							tool("coc_task", { action: task.status === "done" ? "reopen" : "complete", taskId: task.id }).then(function () { poll(true); });
						});
						row.append(check, el("span", null, esc(task.title)));
						var del = el("button", { type: "button", style: "padding:0 6px;font-size:11px" }, "删");
						del.addEventListener("click", function () {
							tool("coc_task", { action: "remove", taskId: task.id }).then(function () { poll(true); });
						});
						row.append(del);
						taskCard.append(row);
					});
					var taskRow = el("div", { class: "coc-row" });
					var taskInput = el("input", { type: "text", placeholder: "新任务…", spellcheck: "false" });
					var taskBtn = el("button", { type: "button" }, "添加");
					taskBtn.addEventListener("click", function () {
						if (taskInput.value.trim()) tool("coc_task", { action: "add", title: taskInput.value.trim() }).then(function () { poll(true); });
					});
					taskRow.append(taskInput, taskBtn);
					taskCard.append(taskRow);
					box.append(taskCard);
				}

				// ── 剧情页（关键点/分支/提醒） ──
				function renderPlotPanel() {
				var box = panels.plotInner;
					box.textContent = "";
					if (S.digest === null) { box.append(el("div", { class: "coc-empty" }, "尚无游戏数据。")); return; }
					var d = S.digest;

					// 剧本选择器
					var scenarioIds = {};
					d.keyPoints.forEach(function (k) { if (k.scenarioId) scenarioIds[k.scenarioId] = true; });
					d.branches.forEach(function (b) { if (b.scenarioId) scenarioIds[b.scenarioId] = true; });
					var scenarioList = Object.keys(scenarioIds).sort();
					var filterKey = "scenarioFilter_" + gameId();
					var currentFilter;
					try { currentFilter = localStorage.getItem(filterKey) || "all"; } catch { currentFilter = "all"; }
					if (scenarioList.length > 0 || d.scenario) {
						var filterRow = el("div", { class: "coc-row", style: "margin-bottom:8px" });
						filterRow.append(el("label", null, "\U0001f3af 筛选剧本："));
						var filterSel = el("select", { style: "flex:1" });
						filterSel.append(el("option", { value: "all" }, "全部"));
						if (d.scenario) filterSel.append(el("option", { value: "current" }, "\U0001f4d6 " + esc(d.scenario.name)));
						scenarioList.forEach(function (sid) {
							if (sid && sid !== (d.scenario ? d.scenario.name : "")) {
								filterSel.append(el("option", { value: sid }, esc(sid)));
							}
						});
						filterSel.value = currentFilter;
						filterSel.addEventListener("change", function () {
							try { localStorage.setItem(filterKey, filterSel.value); } catch {}
							poll(true);
						});
						filterRow.append(filterSel);
						box.append(filterRow);
					}

					function matchesFilter(item) {
						if (currentFilter === "all") return true;
						if (currentFilter === "current") return item.scenarioId === (d.scenario ? d.scenario.name : "");
						return item.scenarioId === currentFilter;
					}

					var filteredKPs = d.keyPoints.filter(matchesFilter);
					var filteredBRs = d.branches.filter(matchesFilter);

					var kpCard = el("div", { class: "coc-card" });
					kpCard.append(el("h4", null, "关键剧情点" + (filteredKPs.length < d.keyPoints.length ? "（" + filteredKPs.length + "/" + d.keyPoints.length + "）" : "")));
					if (filteredKPs.length === 0) kpCard.append(el("div", { class: "coc-empty" }, "暂无（导入剧本可自动草拟）"));
					filteredKPs.forEach(function (kp) {
						var item = el("div", { class: "coc-kp-item" + (kp.revealed ? " revealed" : "") });
						item.append(el("span", null, (kp.revealed ? "\u2713 " : "\u25cb ") + esc(kp.title)));
						if (kp.scene) item.append(el("span", { class: "coc-scene-tag" }, " @" + esc(kp.scene)));
						if (kp.scenarioId) item.append(el("span", { class: "coc-mini", style: "margin-left:4px;color:#8bc34a" }, "[" + esc(kp.scenarioId) + "]"));
						if (!kp.revealed) {
							var reveal = el("button", { type: "button", style: "margin-left:6px;padding:0 7px;font-size:11px" }, "揭示");
							reveal.addEventListener("click", function () {
								tool("coc_branch", { action: "reveal", keyPointId: kp.id }).then(function () { poll(true); });
							});
							item.append(reveal);
						}
						kpCard.append(item);
					});
					box.append(kpCard);

					var brCard = el("div", { class: "coc-card" });
					brCard.append(el("h4", null, "剧情分支" + (filteredBRs.length < d.branches.length ? "（" + filteredBRs.length + "/" + d.branches.length + "）" : "")));
					if (filteredBRs.length === 0) brCard.append(el("div", { class: "coc-empty" }, "暂无分支"));
					filteredBRs.forEach(function (branch) {
						var item = el("div", { class: "coc-kp-item" });
						var head = el("div");
						head.append(el("span", null, (branch.reached ? "\u25b6 " : "\u25cb ") + esc(branch.title)));
						if (branch.scene) head.append(el("span", { class: "coc-scene-tag" }, " @" + esc(branch.scene)));
						if (branch.id === d.currentBranchId) head.append(el("span", { class: "coc-badge", style: "margin-left:6px" }, "当前"));
						if (branch.scenarioId) head.append(el("span", { class: "coc-mini", style: "margin-left:4px;color:#8bc34a" }, "[" + esc(branch.scenarioId) + "]"));
						item.append(head);
						if (branch.chosen) {
							item.append(el("div", { class: "coc-mini" }, "已选择：" + esc(branch.chosen)));
						} else if (branch.options.length > 0) {
							var opts = el("div", { class: "coc-opt" });
							branch.options.forEach(function (option) {
								var btn = el("button", { type: "button" }, esc(option.label) + (option.leadsTo ? " \u2192" + esc(option.leadsTo) : ""));
								btn.addEventListener("click", function () {
									tool("coc_branch", { action: "choose", branchId: branch.id, optionLabel: option.label }).then(function () { poll(true); });
								});
								opts.append(btn);
							});
							item.append(opts);
						}
						brCard.append(item);
					});
					box.append(brCard);

					// ── 提醒 ──
					var rmCard = el("div", { class: "coc-card" });
					var rmTitle = el("div", { class: "coc-row" });
					rmTitle.append(el("h4", null, "待触发提醒"));
					var rmInput = el("input", { type: "text", placeholder: "场景名", spellcheck: "false", style: "flex:1;margin:0 6px" });
					var rmBtn = el("button", { type: "button" }, "添加提醒");
					rmBtn.addEventListener("click", function () {
						if (rmInput.value.trim()) tool("coc_remind", { action: "add", scene: rmInput.value.trim(), text: "提醒内容" }).then(function () { poll(true); });
					});
					rmTitle.append(rmInput, rmBtn);
					rmCard.append(rmTitle);
					var pending = d.reminders.filter(function (r) { return !r.fired; });
					if (pending.length === 0) rmCard.append(el("div", { class: "coc-empty" }, "无待提醒"));
					pending.forEach(function (r) {
						var item = el("div", { class: "coc-kp-item" });
						item.append(el("span", null, esc(r.scene) + " \u2192 " + esc(r.text)));
						var fire = el("button", { type: "button", style: "margin-left:6px;padding:0 7px;font-size:11px" }, "已触发");
						fire.addEventListener("click", function () {
							tool("coc_remind", { action: "fire", reminderId: r.id }).then(function () { poll(true); });
						});
						item.append(fire);
						rmCard.append(item);
					});
					box.append(rmCard);
				}// ── 实体页 ──
				function renderEntsPanel() {
					var box = panels.ents;
					box.textContent = "";
					if (S.digest === null) { box.append(el("div", { class: "coc-empty" }, "尚无游戏数据。")); return; }
					var d = S.digest;
					var TYPE_LABEL = { npc: "NPC", location: "地点", item: "物品", org: "组织", other: "其他" };

					// 剧本选择器
					var scenarioIds = {};
					d.entities.forEach(function (e) { if (e.scenarioId) scenarioIds[e.scenarioId] = true; });
					var scenarioList = Object.keys(scenarioIds).sort();
					var filterKey = "entFilter_" + gameId();
					var currentFilter;
					try { currentFilter = localStorage.getItem(filterKey) || "all"; } catch { currentFilter = "all"; }
					if (scenarioList.length > 0 || d.scenario) {
						var filterRow = el("div", { class: "coc-row", style: "margin-bottom:8px" });
						filterRow.append(el("label", null, "\U0001f3af 筛选剧本："));
						var filterSel = el("select", { style: "flex:1" });
						filterSel.append(el("option", { value: "all" }, "全部"));
						filterSel.append(el("option", { value: "general" }, "通用（无剧本）"));
						if (d.scenario) filterSel.append(el("option", { value: "current" }, "\U0001f4d6 " + esc(d.scenario.name)));
						scenarioList.forEach(function (sid) {
							if (sid && sid !== (d.scenario ? d.scenario.name : "")) {
								filterSel.append(el("option", { value: sid }, esc(sid)));
							}
						});
						filterSel.value = currentFilter;
						filterSel.addEventListener("change", function () {
							try { localStorage.setItem(filterKey, filterSel.value); } catch {}
							poll(true);
						});
						filterRow.append(filterSel);
						box.append(filterRow);
					}

					function matchesFilter(item) {
						if (currentFilter === "all") return true;
						if (currentFilter === "general") return !item.scenarioId;
						if (currentFilter === "current") return item.scenarioId === (d.scenario ? d.scenario.name : "");
						return item.scenarioId === currentFilter;
					}

					var filtered = d.entities.filter(matchesFilter);
					if (filtered.length === 0) box.append(el("div", { class: "coc-empty" }, "暂无实体" + (currentFilter !== "all" ? "（当前筛选）" : "（导入剧本时可自动草拟 NPC/地点/物品）")));
					var groups = {};
					filtered.forEach(function (e) { (groups[e.type] = groups[e.type] || []).push(e); });
					Object.keys(groups).forEach(function (type) {
						var card = el("div", { class: "coc-card" });
						card.append(el("h4", null, (TYPE_LABEL[type] || type) + "\uff08" + groups[type].length + "\uff09"));
						groups[type].forEach(function (e) {
							var item = el("div", { class: "coc-kp-item" });
							var head = el("div");
							head.append(el("span", null, "\u25c6 " + esc(e.name)));
							if (e.scene) head.append(el("span", { class: "coc-scene-tag" }, " @" + esc(e.scene)));
							if (e.scenarioId) head.append(el("span", { class: "coc-mini", style: "margin-left:4px;color:#8bc34a" }, "[" + esc(e.scenarioId) + "]"));
							item.append(head);
							if (e.desc) item.append(el("div", { class: "coc-mini" }, esc(e.desc)));
							var stateInput = el("input", { type: "text", value: e.state || "", placeholder: "当前状态", spellcheck: "false" });
							var saveState = el("button", { type: "button", style: "padding:2px 8px;font-size:11px" }, "存状态");
							saveState.addEventListener("click", function () {
								tool("coc_entity", { action: "update", entityId: e.id, entity: { state: stateInput.value } }).then(function () { poll(true); });
							});
							var del = el("button", { type: "button", style: "padding:2px 8px;font-size:11px;background:rgba(180,70,70,.3)" }, "删");
							del.addEventListener("click", function () {
								tool("coc_entity", { action: "remove", entityId: e.id }).then(function () { poll(true); });
							});
							var row = el("div", { class: "coc-row" });
							row.append(stateInput, saveState, del);
							item.append(row);
							card.append(item);
						});
						box.append(card);
					});
				}function renderEntsPanel() {
					var box = panels.ents;
					box.textContent = "";
					if (S.digest === null) { box.append(el("div", { class: "coc-empty" }, "尚无游戏数据。")); return; }
					var d = S.digest;
					var TYPE_LABEL = { npc: "NPC", location: "地点", item: "物品", org: "组织", other: "其他" };
					if (d.scenario) box.append(el("div", { style: "font-size:12px;color:#8bc34a;margin-bottom:6px" }, "📖 剧本：" + esc(d.scenario.name)));
					if (d.entities.length === 0) box.append(el("div", { class: "coc-empty" }, "暂无实体（导入剧本时可自动草拟 NPC/地点/物品）"));
					var groups = {};
					d.entities.forEach(function (e) { (groups[e.type] = groups[e.type] || []).push(e); });
					Object.keys(groups).forEach(function (type) {
						var card = el("div", { class: "coc-card" });
						card.append(el("h4", null, (TYPE_LABEL[type] || type) + "（" + groups[type].length + "）"));
						groups[type].forEach(function (e) {
							var item = el("div", { class: "coc-kp-item" });
							var head = el("div");
							head.append(el("span", null, "◆ " + esc(e.name)));
							if (e.scene) head.append(el("span", { class: "coc-scene-tag" }, " @" + esc(e.scene)));
							item.append(head);
							if (e.desc) item.append(el("div", { class: "coc-mini" }, esc(e.desc)));
							var stateInput = el("input", { type: "text", value: e.state || "", placeholder: "当前状态", spellcheck: "false" });
							var saveState = el("button", { type: "button", style: "padding:2px 8px;font-size:11px" }, "存状态");
							saveState.addEventListener("click", function () {
								tool("coc_entity", { action: "update", entityId: e.id, entity: { state: stateInput.value } }).then(function () { poll(true); });
							});
							var del = el("button", { type: "button", style: "padding:2px 8px;font-size:11px;background:rgba(180,70,70,.3)" }, "删");
							del.addEventListener("click", function () {
								tool("coc_entity", { action: "remove", entityId: e.id }).then(function () { poll(true); });
							});
							var row = el("div", { class: "coc-row" });
							row.append(stateInput, saveState, del);
							item.append(row);
							card.append(item);
						});
						box.append(card);
					});
					// 添加实体
					var addCard = el("div", { class: "coc-card" });
					addCard.append(el("h4", null, "添加实体"));
					var eName = el("input", { type: "text", placeholder: "名称", spellcheck: "false" });
					var eType = el("select", null);
					Object.keys(TYPE_LABEL).forEach(function (k) { eType.append(el("option", { value: k }, TYPE_LABEL[k])); });
					var eDesc = el("input", { type: "text", placeholder: "描述", spellcheck: "false" });
					var eScene = el("input", { type: "text", placeholder: "所在场景（可选）", spellcheck: "false" });
					var g2 = el("div", { class: "coc-grid2" });
					var f1 = el("div", { class: "coc-field" });
					f1.append(el("label", null, "名称"), eName);
					var f2 = el("div", { class: "coc-field" });
					f2.append(el("label", null, "类型"), eType);
					g2.append(f1, f2);
					addCard.append(g2);
					var descField = el("div", { class: "coc-field" });
					descField.append(el("label", null, "描述"), eDesc);
					addCard.append(descField);
					var sceneField = el("div", { class: "coc-field" });
					sceneField.append(el("label", null, "所在场景"), eScene);
					addCard.append(sceneField);
					var addBtn = el("button", { type: "button" }, "添加");
					addBtn.addEventListener("click", function () {
						tool("coc_entity", { action: "add", entity: { type: eType.value, name: eName.value.trim(), desc: eDesc.value.trim(), scene: eScene.value.trim() } }).then(function (json) {
							setNote(addCard, json);
							poll(true);
						});
					});
					addCard.append(addBtn);
					box.append(addCard);
				}

				// ── 导入页 ──
				function renderImportPanel() {
					var box = panels.import;
					box.textContent = "";
					var card = el("div", { class: "coc-card" });
					card.append(el("h4", null, "导入规则 / 剧本 / 人物"));
					var kindSel = el("select", null);
					[["auto", "自动识别"], ["scenario", "剧本（模组）"], ["rules", "规则书"], ["characters", "人物卡"]].forEach(function (pair) {
						kindSel.append(el("option", { value: pair[0] }, pair[1]));
					});
					var nameInput = el("input", { type: "text", placeholder: "名称（可选）", spellcheck: "false" });
					var g2 = el("div", { class: "coc-grid2" });
					var f1 = el("div", { class: "coc-field" });
					f1.append(el("label", null, "类型"), kindSel);
					var f2 = el("div", { class: "coc-field" });
					f2.append(el("label", null, "名称"), nameInput);
					g2.append(f1, f2);
					card.append(g2);

					var fileInput = el("input", { type: "file", accept: ".pdf,.doc,.docx,.txt,.md,.json", style: "position:absolute;left:-9999px;opacity:0;width:1px;height:1px" });
					var fileBtn = el("button", { type: "button", class: "coc-file" }, "📄 选择文件（PDF/DOC/DOCX/TXT/MD/JSON）");
					fileBtn.addEventListener("click", function (e) { e.preventDefault(); fileInput.click(); });
					var fileHint = el("div", { class: "coc-mini" });
					fileInput.addEventListener("change", function () {
						fileHint.textContent = fileInput.files && fileInput.files[0] ? "已选择：" + fileInput.files[0].name : "";
					});
					card.append(fileInput, fileBtn, fileHint);

					var textArea = el("textarea", { placeholder: "或直接粘贴文本内容…" });
					var textField = el("div", { class: "coc-field" });
					textField.append(el("label", null, "或粘贴文本"), textArea);
					card.append(textField);

					var structRow = el("div", { class: "coc-row" });
					var structCheck = el("input", { type: "checkbox", style: "width:15px;height:15px" });
					structCheck.checked = true;
					structRow.append(structCheck, el("span", null, "剧本自动草拟关键剧情点/分支/实体"));
					card.append(structRow);

					var resultBox = el("div", { class: "coc-result-box", style: "display:none" });
					card.append(resultBox);

					var btnRow = el("div", { class: "coc-btnrow" });
				var runBtn = el("button", { type: "button", style: "font-weight:600" }, "开始导入");
				btnRow.append(runBtn);
				card.append(btnRow);
					runBtn.addEventListener("click", function () {
						var file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
						resultBox.classList.remove("err");
						resultBox.style.display = "block";
						// 创建进度条
						resultBox.textContent = "";
						var progressBar = el("div", { class: "coc-progress-bar", style: "width:100%;height:6px;background:#eee;border-radius:3px;margin:8px 0;overflow:hidden" });
						var progressFill = el("div", { class: "coc-progress-fill", style: "width:0%;height:100%;background:#4caf50;border-radius:3px;transition:width 0.3s" });
						progressBar.append(progressFill);
						var progressMsg = el("div", { class: "coc-progress-msg", style: "font-size:12px;color:#666;margin-bottom:8px" });
						resultBox.append(progressBar, progressMsg);
						progressMsg.textContent = "准备导入…";
						// SSE 流式导入：通过 fetch 读取实时进度
						function doImportSSE(body) {
							body.stream = true;
							var url = "/coc-api/import";
							fetch(url, {
								method: "POST",
								headers: { "content-type": "application/json", "accept": "text/event-stream" },
								body: JSON.stringify(Object.assign({ game: gameId() }, body))
							}).then(function (resp) {
								var reader = resp.body.getReader();
								var decoder = new TextDecoder();
								var buffer = "";
								function readStream() {
									reader.read().then(function (result) {
										// 先处理数据（即使 done=true，小响应可能一次送达）
										if (result.value) {
											buffer += decoder.decode(result.value, { stream: true });
										}
										// 解析 SSE 事件
										var lines = buffer.split("\n");
										buffer = lines.pop(); // 保留不完整行
										var currentEvent = null;
										for (var i = 0; i < lines.length; i++) {
											var line = lines[i];
											if (line.startsWith("event: ")) {
												currentEvent = line.slice(7).trim();
											} else if (line.startsWith("data: ")) {
												var data = line.slice(6);
												try {
													var parsed = JSON.parse(data);
													handleSSEEvent(currentEvent, parsed);
												} catch (e) { /* ignore parse errors */ }
											}
										}
										// 继续读取下一块（除非流已结束）
										if (!result.done) {
											readStream();
										}
									}).catch(function (err) {
										resultBox.classList.add("err");
										progressMsg.textContent = "流读取失败：" + err.message;
									});
								}
								readStream();
							}).catch(function (err) {
								resultBox.classList.add("err");
								progressMsg.textContent = "请求失败：" + err.message;
							});
						}
						function handleSSEEvent(event, data) {
							if (event === "progress") {
								progressFill.style.width = (data.percent || 0) + "%";
								progressMsg.textContent = data.message || "";
							} else if (event === "result") {
								// 隐藏进度条，显示结果
								progressBar.style.display = "none";
								if (data.ok) {
									resultBox.classList.remove("err");
									resultBox.innerHTML = ""; // 清空进度条
									resultBox.append(el("div", { style: "font-size:13px;color:#8bc34a;font-weight:600;margin-bottom:6px" }, "✅ 导入成功"));
									var detail = el("div", { style: "font-size:12px;white-space:pre-wrap;line-height:1.5" });
									detail.textContent = data.render || "导入完成";
									resultBox.append(detail);
									// 静默刷新 state（保留结果框，但刷新面板数据）
									api("/coc-api/state?game=" + encodeURIComponent(gameId()) + "&after=" + S.seq).then(function (json) {
										if (json.ok) { S.digest = json.data; renderPanel(S.tab); }
									}).catch(function () {});
								} else {
									resultBox.classList.add("err");
									resultBox.innerHTML = "";
									resultBox.append(el("div", { style: "font-size:13px;color:#ff5252;font-weight:600;margin-bottom:6px" }, "❌ 导入失败"));
									var detail = el("div", { style: "font-size:12px;white-space:pre-wrap;line-height:1.5" });
									detail.textContent = "失败：" + (data.error || "");
									resultBox.append(detail);
								}
							} else if (event === "error") {
								progressBar.style.display = "none";
								resultBox.classList.add("err");
								resultBox.innerHTML = "";
								resultBox.append(el("div", { style: "font-size:13px;color:#ff5252;font-weight:600;margin-bottom:6px" }, "❌ 导入失败"));
								var detail = el("div", { style: "font-size:12px;white-space:pre-wrap;line-height:1.5" });
								detail.textContent = "失败：" + (data.error || "");
								resultBox.append(detail);
							}
						}
						if (file) {
							var reader = new FileReader();
							reader.onload = function () {
								var base64 = String(reader.result).split(",")[1] || "";
								doImportSSE({
									kind: kindSel.value, name: nameInput.value.trim(),
									fileBase64: base64, fileName: file.name,
									parseStructure: structCheck.checked
								});
							};
							reader.onerror = function () { progressMsg.textContent = "文件读取失败"; };
							reader.readAsDataURL(file);
						} else {
							doImportSSE({
								kind: kindSel.value, name: nameInput.value.trim(),
								text: textArea.value, parseStructure: structCheck.checked
							});
						}
					});
					box.append(card);

					// 已导入 + 阅读全文
					var d = S.digest;
					if (d !== null) {
						var info = el("div", { class: "coc-card" });
						info.append(el("h4", null, "已导入内容"));
						if (d.rules) {
							var rulesRow = el("div", { class: "coc-row" });
							rulesRow.append(el("span", null, "规则：" + esc(d.rules.name) + "（" + d.rules.chars + " 字符）"));
							var delRulesBtn = el("button", { type: "button", style: "margin-left:auto;background:#b71c1c;color:#fff;padding:2px 8px;font-size:11px" }, "删除");
							delRulesBtn.addEventListener("click", function () {
								if (confirm("确定删除规则「" + d.rules.name + "」？")) {
									post("/coc-api/clear-rules", { game: gameId() }).then(function () { poll(true); });
								}
							});
							rulesRow.append(delRulesBtn);
							info.append(rulesRow);
						}
						if (d.scenario) {
							var scenarioRow = el("div", { class: "coc-row" });
							scenarioRow.append(el("span", null, "剧本：" + esc(d.scenario.name) + "（" + d.scenario.chars + " 字符）"));
							var delScenarioBtn = el("button", { type: "button", style: "margin-left:auto;background:#b71c1c;color:#fff;padding:2px 8px;font-size:11px" }, "删除");
							delScenarioBtn.addEventListener("click", function () {
								if (confirm("确定删除剧本「" + d.scenario.name + "」及其关联的关键剧情点/分支/实体？")) {
									post("/coc-api/clear-scenario", { game: gameId() }).then(function () { poll(true); });
								}
							});
							scenarioRow.append(delScenarioBtn);
							info.append(scenarioRow);
						}
						if (!d.rules && !d.scenario) info.append(el("div", { class: "coc-empty" }, "尚未导入规则/剧本"));
						var readSel = el("select", null);
						if (d.rules) readSel.append(el("option", { value: "rules" }, "规则"));
						if (d.scenario) readSel.append(el("option", { value: "scenario" }, "剧本"));
						var readBtn = el("button", { type: "button" }, "阅读全文");
						var readMore = el("button", { type: "button", style: "display:none" }, "继续阅读 ↓");
						var readBox = el("div", { class: "coc-result-box", style: "display:none" });
						var readOffset = 0;
						function loadRead() {
							post("/coc-api/read", { what: readSel.value, offset: readOffset, limit: 4000 }).then(function (json) {
								readBox.style.display = "block";
								if (!json.ok) { readBox.textContent = "失败：" + (json.error || ""); return; }
								readBox.textContent = (readBox.textContent === "" ? "" : readBox.textContent + "\n\n") + json.data.text;
								readOffset = json.data.end;
								readMore.style.display = readOffset < json.data.totalChars ? "inline-block" : "none";
							});
						}
						readBtn.addEventListener("click", function () { readOffset = 0; readBox.textContent = ""; loadRead(); });
						readMore.addEventListener("click", loadRead);
						var readRow = el("div", { class: "coc-row" });
						readRow.append(readSel, readBtn, readMore);
						info.append(readRow, readBox);
						box.append(info);
					}
				}

				// ── 设置页 ──
				function renderSettingsPanel() {
					var box = panels.settings;
					box.textContent = "";
					var card = el("div", { class: "coc-card" });
					card.append(el("h4", null, "LLM API 配置"));
					card.append(el("p", { style: "font-size:12px;color:#888;margin-bottom:10px" }, "配置 AI 解析剧本和大模型 KP 所需的 API 信息。保存后即可使用。"));
					
					// 加载当前配置
					var cfg = { llmProvider: "", llmModel: "", apiKey: "", apiBaseUrl: "" };
					post("/coc-api/config", { action: "get" }).then(function (json) {
						if (json.ok && json.data) {
							cfg = json.data;
							providerInput.value = cfg.llmProvider || "";
							modelInput.value = cfg.llmModel || "";
							keyInput.value = cfg.apiKey || "";
							urlInput.value = cfg.apiBaseUrl || "";
						}
					}).catch(function () {});
					
					var providerInput = el("input", { type: "text", placeholder: "例如：deepseek, openai", spellcheck: "false" });
					providerInput.value = cfg.llmProvider || "";
					var f1 = el("div", { class: "coc-field" });
					f1.append(el("label", null, "API 提供商"), providerInput);
					card.append(f1);
					
					var modelInput = el("input", { type: "text", placeholder: "例如：deepseek-chat, gpt-4o-mini", spellcheck: "false" });
					modelInput.value = cfg.llmModel || "";
					var f2 = el("div", { class: "coc-field" });
					f2.append(el("label", null, "模型名称"), modelInput);
					card.append(f2);
					
					var keyInput = el("input", { type: "password", placeholder: "API Key（不会明文显示）", spellcheck: "false" });
					keyInput.value = cfg.apiKey ? "••••••••" : "";
					var f3 = el("div", { class: "coc-field" });
					f3.append(el("label", null, "API Key"), keyInput);
					card.append(f3);
					
					var urlInput = el("input", { type: "text", placeholder: "可选，留空自动推断", spellcheck: "false" });
					urlInput.value = cfg.apiBaseUrl || "";
					// 预设按钮
					var presetBtns = el("div", { class: "coc-btnrow", style: "margin-top:4px" });
					presetBtns.append(el("span", { style: "font-size:11px;color:#888;margin-right:6px" }, "预设："));
					[["DeepSeek", "https://api.deepseek.com/v1/chat/completions"], ["OpenAI", "https://api.openai.com/v1/chat/completions"]].forEach(function (pair) {
						var btn = el("button", { type: "button", style: "font-size:11px;padding:2px 8px" }, pair[0]);
						btn.addEventListener("click", function () {
							providerInput.value = pair[0].toLowerCase();
							urlInput.value = pair[1];
						});
						presetBtns.append(btn);
					});
					var f4 = el("div", { class: "coc-field" });
					f4.append(el("label", null, "API 地址"), urlInput, presetBtns);
					card.append(f4);
					
					var saveBtn = el("button", { type: "button", style: "font-weight:600;margin-top:10px" }, "保存配置");
					card.append(saveBtn);
					
					var statusMsg = el("div", { style: "font-size:12px;margin-top:6px" });
					card.append(statusMsg);
					
					saveBtn.addEventListener("click", function () {
						var newKey = keyInput.value;
						// 如果用户没改密码框（显示••••••••），保留原值
						if (newKey === "••••••••") newKey = cfg.apiKey || "";
						post("/coc-api/config", {
							action: "set",
							llmProvider: providerInput.value.trim(),
							llmModel: modelInput.value.trim(),
							apiKey: newKey,
							apiBaseUrl: urlInput.value.trim()
						}).then(function (json) {
							if (json.ok) {
								statusMsg.textContent = "✅ 配置已保存";
								statusMsg.style.color = "#8bc34a";
								cfg = json.data;
							} else {
								statusMsg.textContent = "❌ " + (json.error || "保存失败");
								statusMsg.style.color = "#ff5252";
							}
						}).catch(function (err) {
							statusMsg.textContent = "❌ 请求失败：" + err.message;
							statusMsg.style.color = "#ff5252";
						});
					});
					
					box.append(card);
					
					// 测试连接
					var testCard = el("div", { class: "coc-card" });
					testCard.append(el("h4", null, "测试连接"));
					testCard.append(el("p", { style: "font-size:12px;color:#888;margin-bottom:8px" }, "保存配置后，点击测试检查 API 是否可用。"));
					var testBtn = el("button", { type: "button" }, "测试 API 连接");
					var testResult = el("div", { style: "font-size:12px;margin-top:6px;white-space:pre-wrap" });
					testCard.append(testBtn, testResult);
					testBtn.addEventListener("click", function () {
						testResult.textContent = "测试中…";
						testResult.style.color = "#888";
						// 先保存当前配置
						var newKey = keyInput.value;
						if (newKey === "••••••••") newKey = cfg.apiKey || "";
						post("/coc-api/config", {
							action: "set",
							llmProvider: providerInput.value.trim(),
							llmModel: modelInput.value.trim(),
							apiKey: newKey,
							apiBaseUrl: urlInput.value.trim()
						}).then(function (json) {
							if (!json.ok) {
								testResult.textContent = "❌ 保存配置失败：" + (json.error || "");
								testResult.style.color = "#ff5252";
								return;
							}
							// 调用测试接口
							return post("/coc-api/test-llm", { game: gameId() });
						}).then(function (json) {
							if (json && json.ok) {
								testResult.textContent = "✅ " + (json.data || "连接成功");
								testResult.style.color = "#8bc34a";
							} else if (json) {
								testResult.textContent = "❌ " + (json.error || "测试失败");
								testResult.style.color = "#ff5252";
							}
						}).catch(function (err) {
							testResult.textContent = "❌ 请求失败：" + err.message;
							testResult.style.color = "#ff5252";
						});
					});
										box.append(testCard);
					
					// 内置规则
					var rulesCard = el("div", { class: "coc-card" });
					rulesCard.append(el("h4", null, "内置规则"));
					rulesCard.append(el("p", { style: "font-size:12px;color:#888;margin-bottom:8px" }, "插件内置了完整的 CoC 7e 规则摘要（技能列表、战斗规则、理智值、职业模板等）。首次启动时自动导入。"));
					var importRulesBtn = el("button", { type: "button" }, "📖 重新导入内置规则");
					var rulesStatus = el("div", { style: "font-size:12px;margin-top:6px" });
					rulesCard.append(importRulesBtn, rulesStatus);
					importRulesBtn.addEventListener("click", function () {
						rulesStatus.textContent = "导入中…";
						rulesStatus.style.color = "#888";
						post("/coc-api/import-builtin-rules", { game: gameId() }).then(function (json) {
							if (json.ok) {
								rulesStatus.textContent = "✅ 已导入 " + (json.data.name || "CoC 7e 规则") + "（" + (json.data.chars || 0) + " 字符）";
								rulesStatus.style.color = "#8bc34a";
								poll(true);
							} else {
								rulesStatus.textContent = "❌ " + (json.error || "导入失败");
								rulesStatus.style.color = "#ff5252";
							}
						}).catch(function (err) {
							rulesStatus.textContent = "❌ 请求失败：" + err.message;
							rulesStatus.style.color = "#ff5252";
						});
					});
					box.append(rulesCard);
				}
				// 启动
				showTab(S.tab);
				poll(true);
				var timer = setInterval(function () { poll(false); }, 2500);

				return function cleanup() {
					if (timer !== null) clearInterval(timer);
					unregisterDock();
					panel.remove();
					style.remove();
				};
			}

			// ── 玩家面板（独立用户视图，只显示玩家可见内容） ──
			var PLAYER_PANEL_ID = "coc-keeper-player-panel";
			function mountPlayerPanel() {
				if (document.getElementById(PLAYER_PANEL_ID) !== null) return function () {};
				var panel = el("div", { id: PLAYER_PANEL_ID });
				var head = el("div", { class: "pp-head", title: "按住拖动" });
				head.append(el("b", null, "🎭 玩家视图"));
				var hideBtn = el("button", { type: "button", title: "隐藏" }, "🗕");
				head.append(hideBtn);
				panel.append(head);
				var body = el("div", { class: "pp-body" });
				panel.append(body);
				var composer = el("div", { class: "pp-composer" });
				var input = el("textarea", { placeholder: "输入你的行动…（回车发送）" });
				var sendBtn = el("button", { type: "button" }, "发送");
				composer.append(input, sendBtn);
				panel.append(composer);
				document.body.append(panel);
				var visible = true;
				hideBtn.addEventListener("click", function () { visible = !visible; body.style.display = visible ? "flex" : "none"; composer.style.display = visible ? "flex" : "none"; hideBtn.textContent = visible ? "🗕" : "👁"; });
				var unregisterDock = registerDockPanel({
					id: "@dsh-external/dsh-coc-keeper-player",
					title: "CoC 玩家视图",
					icon: "🎭",
					isVisible: function () { return panel.style.display !== "none"; },
					toggle: function () { panel.style.display = panel.style.display === "none" ? "flex" : "none"; }
				});
				function renderPlayer(data) {
					body.textContent = "";
					if (data === null) { body.append(el("div", { class: "pp-card" }, "尚无游戏数据。")); return; }
					var sceneCard = el("div", { class: "pp-card" });
					sceneCard.append(el("h4", null, "当前场景"));
					sceneCard.append(el("div", { class: "pp-kv" }, "📍 " + esc(data.currentScene || "（未设定）")));
					sceneCard.append(el("div", { class: "pp-kv" }, "🕰 " + esc(data.time || "（未设定）")));
					body.append(sceneCard);
					if (Array.isArray(data.characters) && data.characters.length > 0) {
						var pcCard = el("div", { class: "pp-card" });
						pcCard.append(el("h4", null, "调查员"));
						data.characters.forEach(function (pc) {
							var line = el("div", { class: "pp-kv" });
							line.textContent = pc.name + "：HP " + pc.hp + " / SAN " + pc.san + " / MP " + pc.mp + (Array.isArray(pc.inventory) && pc.inventory.length > 0 ? "｜物品：" + pc.inventory.join("、") : "");
							pcCard.append(line);
						});
						body.append(pcCard);
					}
					if (Array.isArray(data.entities) && data.entities.length > 0) {
						var entCard = el("div", { class: "pp-card" });
						entCard.append(el("h4", null, "你注意到"));
						data.entities.forEach(function (e) {
							entCard.append(el("div", { class: "pp-kv" }, "◆ " + esc(e.name) + (e.desc ? "：" + esc(String(e.desc).slice(0, 80)) : "")));
						});
						body.append(entCard);
					}
					var log = Array.isArray(data.log) ? data.log.slice(-8) : [];
					if (log.length > 0) {
						var logCard = el("div", { class: "pp-card" });
						logCard.append(el("h4", null, "最近动态"));
						log.forEach(function (entry) {
							var line = el("div", { class: "pp-msg " + (entry.kind || "") });
							line.textContent = (entry.kind === "user" ? (entry.player || "玩家") + "：" : "KP：") + entry.text;
							logCard.append(line);
						});
						body.append(logCard);
					}
				}
				function pollPlayer() {
					return api("/coc-api/player-view?game=" + encodeURIComponent(gameId())).then(function (json) {
						if (json.ok) renderPlayer(json.data);
					});
				}
				sendBtn.addEventListener("click", function () {
					var text = input.value.trim();
					if (text.length === 0) return;
					input.value = "";
					sendBtn.disabled = true;
					post("/coc-api/chat", { text: text, player: "玩家" }).then(function (json) {
						sendBtn.disabled = false;
						if (json.ok) { pollPlayer(); if (typeof poll === "function") poll(true); }
						else { alert("发送失败：" + (json.error || "未知错误")); }
					});
				});
				input.addEventListener("keydown", function (event) {
					if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendBtn.click(); }
				});
				pollPlayer();
				var timer = setInterval(pollPlayer, 3000);
				return function cleanup() {
					clearInterval(timer);
					unregisterDock();
					panel.remove();
				};
			}
			// ── 插件契约 ──
			exports.apply = function apply(ctx) {
				if (typeof document === "undefined") return;
				var disposer = null;
				var playerDisposer = null;
				var start = function () {
					if (document.getElementById(PANEL_ID) === null) disposer = mountPanel();
					if (document.getElementById("coc-keeper-player-panel") === null) playerDisposer = mountPlayerPanel();
				};
				if (document.body) start();
				else document.addEventListener("DOMContentLoaded", start, { once: true });
				if (ctx && typeof ctx.effect === "function") {
					ctx.effect(function () {
						return function () {
							if (disposer) disposer();
							if (playerDisposer) playerDisposer();
						};
					}, "coc-keeper: panels");
				}
			};
			return module.exports;
		}
	});
})();
