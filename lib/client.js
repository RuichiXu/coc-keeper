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
			function asArray(value) { return Array.isArray(value) ? value : []; }
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
			// 两个面板（KP/玩家）共享的场次下拉框与跨面板刷新钩子
			var GAME_SELECTS = [];
			var kpPoll = null;
			var kpResetAndPoll = null;
			var playerPoll = null;
			function refreshGameSelects() {
				return api("/coc-api/games").then(function (json) {
					if (!json.ok) return;
					var current = gameId();
					GAME_SELECTS.forEach(function (sel) {
						sel.textContent = "";
						(json.data || []).forEach(function (g) {
							var opt = el("option", { value: g.id }, g.title + (g.scenario ? " · " + g.scenario.name : ""));
							if (g.id === current) opt.selected = true;
							sel.append(opt);
						});
						if (sel.options.length === 0) {
							sel.append(el("option", { value: current }, current));
						}
					});
				});
			}
			function fmtTime(iso) {
				if (!iso) return "";
				try { return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
			}

			// ── 轻量 Markdown 渲染（原生 DOM，无依赖） ──
			// 支持：**粗体**、__粗体__、*斜体*、_斜体_、`代码`、# 标题、> 引用；
			// 其余按纯文本处理，换行保留。所有文本经 textContent 写入，天然防注入。
			function appendInlineMd(parent, text) {
				var tokens = String(text).split(/(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`)/g);
				for (var i = 0; i < tokens.length; i += 1) {
					var token = tokens[i];
					if (token === "") continue;
					var m;
					if ((m = token.match(/^\*\*([^*]+)\*\*$/)) !== null || (m = token.match(/^__([^_]+)__$/)) !== null) {
						var strong = el("strong", null); strong.textContent = m[1]; parent.append(strong);
					} else if ((m = token.match(/^\*([^*\s][^*]*)\*$/)) !== null || (m = token.match(/^_([^_\s][^_]*)_$/)) !== null) {
						var em = el("em", null); em.textContent = m[1]; parent.append(em);
					} else if ((m = token.match(/^`([^`]+)`$/)) !== null) {
						var code = el("code", { class: "pp-md-code" }); code.textContent = m[1]; parent.append(code);
					} else {
						parent.append(document.createTextNode(token));
					}
				}
			}
			function appendMarkdown(parent, text) {
				var lines = String(text ?? "").split(/\r?\n/);
				for (var i = 0; i < lines.length; i += 1) {
					var line = lines[i];
					if (i > 0) parent.append(document.createElement("br"));
					var heading = line.match(/^(#{1,6})\s+(.+)$/);
					if (heading !== null) {
						var h = el("span", { class: "pp-md-h" }); h.textContent = heading[2]; parent.append(h);
						continue;
					}
					if (/^\s*>\s?/.test(line)) {
						var q = el("span", { class: "pp-md-q" }); appendInlineMd(q, line.replace(/^\s*>\s?/, "")); parent.append(q);
						continue;
					}
					appendInlineMd(parent, line);
				}
			}

			// ── 全局面板状态 ──
var S = { digest: null, entries: [], seq: 0, tab: tabPref(), busy: false, error: "", importView: null };

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
				"#coc-keeper-panel .coc-msg strong{color:#ffd98a;font-weight:600}",
				"#coc-keeper-panel .coc-msg em{font-style:italic;color:#c7d4f4}",
				"#coc-keeper-panel .coc-msg code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:rgba(255,255,255,.1);border-radius:4px;padding:0 4px}",
				"#coc-keeper-panel .coc-msg .pp-md-h{display:block;font-weight:700;color:#ffd98a;margin:2px 0}",
				"#coc-keeper-panel .coc-msg .pp-md-q{display:block;border-left:2px solid rgba(160,180,220,.5);padding-left:7px;color:#aebce0;margin:2px 0}",
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
				"#coc-keeper-player-panel .pp-msg{white-space:pre-wrap;word-break:break-word;font-size:12.5px;padding:6px 9px;border-radius:10px;margin:4px 0;border:1px solid rgba(140,170,230,.22)}",
				"#coc-keeper-player-panel .pp-msg .pp-who{display:block;font-size:10.5px;color:#8fa4d4;margin-bottom:2px;letter-spacing:.04em}",
				"#coc-keeper-player-panel .pp-msg.user{color:#ffd98a;background:rgba(64,92,160,.4);border-color:rgba(255,217,138,.3)}",
				"#coc-keeper-player-panel .pp-msg.kp{color:#cdd8f0;background:rgba(26,44,94,.5);border-color:rgba(130,165,235,.28)}",
				"#coc-keeper-player-panel .pp-msg.roll{color:#aebce0;background:rgba(120,140,190,.12);border-color:rgba(160,180,220,.22);font-size:11.5px;text-align:center}",
				"#coc-keeper-player-panel .pp-msg.check{color:#ffd98a;background:rgba(150,120,50,.16);border-color:rgba(255,205,130,.32);font-size:12px;text-align:center}",
				"#coc-keeper-player-panel .pp-msg strong{color:#ffd98a;font-weight:600}",
				"#coc-keeper-player-panel .pp-msg em{font-style:italic;color:#c7d4f4}",
				"#coc-keeper-player-panel .pp-msg code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:rgba(255,255,255,.1);border-radius:4px;padding:0 4px}",
				"#coc-keeper-player-panel .pp-msg .pp-md-h{display:block;font-weight:700;color:#ffd98a;margin:2px 0}",
				"#coc-keeper-player-panel .pp-msg .pp-md-q{display:block;border-left:2px solid rgba(160,180,220,.5);padding-left:7px;color:#aebce0;margin:2px 0}",
				"#coc-keeper-player-panel .pp-composer{border-top:1px solid rgba(140,170,230,.2);padding:7px 10px;display:flex;gap:6px;align-items:center;background:rgba(4,8,24,.35);flex:none}",
				"#coc-keeper-player-panel .pp-composer textarea{min-height:38px;max-height:120px;flex:1}",
				".coc-wizard-overlay{position:fixed;inset:0;z-index:9999;background:rgba(2,6,20,.62);display:flex;align-items:center;justify-content:center}",
				".coc-wizard{width:min(520px,94vw);max-height:84vh;overflow-y:auto;border-radius:14px;border:1px solid rgba(120,150,215,.4);background:#0c1532;color:#e6ebf8;padding:16px 18px;font:13px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;box-shadow:0 16px 48px rgba(4,10,30,.6)}",
				".coc-wizard h3{margin:0 0 10px;font-size:15px}",
				".coc-wizard-step{display:none}",
				".coc-wiz-pc-list{display:flex;flex-direction:column;gap:5px;max-height:300px;overflow-y:auto;border:1px solid rgba(120,150,215,.25);border-radius:9px;padding:8px}",
				".coc-wiz-pc{display:flex;gap:8px;align-items:center;padding:5px 7px;border-radius:7px;background:rgba(22,40,86,.4)}",
				".coc-wiz-pc:hover{background:rgba(40,64,120,.5)}",
				".coc-wiz-sum{border:1px solid rgba(120,150,215,.25);border-radius:9px;padding:8px 10px;background:rgba(22,40,86,.35)}",
				".coc-detail-overlay{position:fixed;inset:0;z-index:9999;background:rgba(2,6,20,.62);display:flex;align-items:center;justify-content:center}",
				".coc-detail{width:min(480px,94vw);max-height:84vh;overflow-y:auto;border-radius:14px;border:1px solid rgba(120,150,215,.4);background:#0c1532;color:#e6ebf8;padding:16px 18px;font:13px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;box-shadow:0 16px 48px rgba(4,10,30,.6)}",
				".coc-detail h3{margin:0 0 10px;font-size:15px}",
				".coc-detail-body .coc-kv{margin:4px 0}",
				"#coc-keeper-panel .coc-net-toolbar{display:flex;flex-wrap:wrap;gap:5px;align-items:center}",
				"#coc-keeper-panel .coc-net-toolbar input[type=text]{flex:1;min-width:110px}",
				"#coc-keeper-panel .coc-net-toolbar select{width:auto;flex:none}",
				"#coc-keeper-panel .coc-net-toolbar label{font-size:11.5px;color:#9db0d8;display:flex;align-items:center;gap:3px}",
				"#coc-keeper-panel .coc-net-toolbar label input{width:auto;accent-color:#8fb0f0}",
				"#coc-keeper-panel .coc-net-legend{display:flex;flex-wrap:wrap;gap:8px;font-size:11.5px;color:#9db0d8}",
				"#coc-keeper-panel .coc-net-legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:3px;vertical-align:middle}",
				"#coc-keeper-panel .coc-net-zoomrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px}",
				"#coc-keeper-panel .coc-net-zoomrow button{font-size:12px;padding:3px 9px}",
				"#coc-keeper-panel .coc-net-zoomrow .coc-net-zoom-hint{margin-left:auto;font-size:11px;color:#7f95c8}",
				"#coc-keeper-panel .coc-net-viewport{position:relative;overflow:hidden;height:560px;border:1px solid rgba(120,150,215,.25);border-radius:11px;background:radial-gradient(circle at 20% 15%,rgba(72,104,176,.14),rgba(6,12,30,.35) 65%)}",
				"#coc-keeper-panel .coc-net-svg{display:block;position:absolute;left:0;top:0;transform-origin:0 0;cursor:grab;user-select:none;-webkit-user-select:none}",
				"#coc-keeper-panel .coc-net-svg.panning{cursor:grabbing}",
				"#coc-keeper-panel .coc-net-svg text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;fill:#c7d4f4;pointer-events:none}",
				"#coc-keeper-panel .coc-net-svg .coc-net-band-title{font-size:11px;fill:#9db0d8;font-weight:700}",
				"#coc-keeper-panel .coc-net-svg .node{stroke-width:1.6;cursor:pointer}",
				"#coc-keeper-panel .coc-net-svg .node:hover{stroke-width:2.6;filter:brightness(1.2)}",
				"#coc-keeper-panel .coc-net-svg .node.dim{opacity:.16}",
				"#coc-keeper-panel .coc-net-svg .node.focus{stroke:#ffe9b0;stroke-width:2.6}",
				"#coc-keeper-panel .coc-net-svg .edge{stroke:rgba(155,185,240,.62);stroke-width:1.5;fill:none}",
				"#coc-keeper-panel .coc-net-svg .edge.has-req{stroke-dasharray:none;stroke:rgba(255,205,130,.75)}",
				"#coc-keeper-panel .coc-net-svg .edge.fallback{stroke:rgba(125,155,215,.38);stroke-dasharray:2 5}",
				"#coc-keeper-panel .coc-net-svg .edge.dim{opacity:.08}",
				"#coc-keeper-panel .coc-net-svg .edge.focus{stroke:#ffe9b0;stroke-width:2.2}",
				"#coc-keeper-panel .coc-net-svg .node.virtual circle{fill:#1e2a4a;stroke:#7d9bd8;stroke-dasharray:3 3}",
				"#coc-keeper-panel .coc-net-svg .edge-label{font-size:9px;fill:#8fa4d4;paint-order:stroke;stroke:#0c1532;stroke-width:3px;stroke-linejoin:round}",
				"#coc-keeper-panel .coc-net-svg .node-label{paint-order:stroke;stroke:#0a1026;stroke-width:3px;stroke-linejoin:round}",
				"#coc-keeper-panel .coc-net-svg .check-badge-text{font-size:8px;fill:#1a1420;font-weight:700}",
				"#coc-keeper-panel .coc-net-detail{display:flex;flex-direction:column;gap:7px}",
				"#coc-keeper-panel .coc-cond{display:inline-block;margin:2px 4px 2px 0;padding:2px 7px;border-radius:999px;font-size:11px;background:rgba(90,120,200,.2);border:1px solid rgba(130,160,225,.32);color:#d3ddf5}",
				"#coc-keeper-panel .coc-cond.neg{background:rgba(180,70,70,.22);border-color:rgba(230,120,110,.4);color:#ffc9c2}",
				"#coc-keeper-panel .coc-cond.routing{background:rgba(150,120,50,.22);border-color:rgba(255,205,130,.42);color:#ffe9b0}",
				"#coc-keeper-panel .coc-endcard{border:1px solid rgba(190,160,90,.4);border-radius:11px;padding:8px 10px;background:rgba(40,34,12,.35);margin-top:5px}",
				"#coc-keeper-panel .coc-endcard h4{color:#ffd98a;margin:0 0 5px}",
				"#coc-keeper-panel .coc-net-stats{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:#9db0d8}",
				"#coc-keeper-panel.net-mode .coc-chat,#coc-keeper-panel.net-mode .coc-composer,#coc-keeper-panel.net-mode .coc-divider{display:none}"
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
			function clampPanelToViewport(panel) {
				// 面板必须保留一个可拖动的头部区域在视口内；用户误拖出屏后能自行拉回。
				var rect = panel.getBoundingClientRect();
				var x = Math.max(60 - rect.width, Math.min(rect.left, window.innerWidth - 60));
				var y = Math.max(0, Math.min(rect.top, window.innerHeight - 44));
				if (x !== rect.left || y !== rect.top) {
					panel.style.left = x + "px";
					panel.style.top = y + "px";
					panel.style.right = "auto";
					panel.style.bottom = "auto";
				}
			}
			function resetPanelRect(panel) {
				try { localStorage.removeItem(LS_RECT); } catch { /* ignore */ }
				panel.style.left = "";
				panel.style.top = "";
				panel.style.width = "";
				panel.style.height = "";
				panel.style.right = "12px";
				panel.style.bottom = "12px";
				panel.classList.remove("coc-maximized");
				if (typeof GAME_SELECTS !== "undefined") { /* 保持兼容 */ }
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
					// 挂载前面板未入文档，getBoundingClientRect 不可用；直接用保存值钳制。
					savedRect.x = Math.max(60 - savedRect.w, Math.min(savedRect.x, window.innerWidth - 60));
					savedRect.y = Math.max(0, Math.min(savedRect.y, window.innerHeight - 44));
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
				GAME_SELECTS.push(gameSelect);
				var newGameBtn = el("button", { type: "button", title: "新建游戏场次" }, "＋");
				head.append(newGameBtn);
				var delGameBtn = el("button", { type: "button", title: "删除当前场次", style: "background:rgba(160,50,50,.35)" }, "🗑");
				head.append(delGameBtn);
				var refreshBtn = el("button", { type: "button", title: "刷新" }, "⟳");
				head.append(refreshBtn);
				var hideBtn = el("button", { type: "button", title: "最小化到面板坞（右下角 🧩 恢复）" }, "🗕");
				var resetPosBtn = el("button", { type: "button", title: "重置面板位置与大小（拖出屏幕时使用）" }, "⌖");
				resetPosBtn.addEventListener("click", function () { resetPanelRect(panel); });
				head.append(resetPosBtn, hideBtn);
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
				var TAB_DEFS = [["dm", "主持"], ["plot", "剧情"], ["net", "解析"], ["debug", "调试"]];
				var tabButtons = {};
				TAB_DEFS.forEach(function (pair) {
					var btn = el("button", { type: "button", "data-tab": pair[0] }, pair[1]);
					tabButtons[pair[0]] = btn;
					tabs.append(btn);
				});
				panel.append(tabs);

				// 面板容器：dm / plot / debug 为顶级；status、plotInner 归 plot；ents、import、settings 归 debug
				var panels = {};
				["dm", "plot", "net", "debug"].forEach(function (key) {
					var box = el("div", { class: "coc-panel", "data-panel": key });
					box.style.display = "none";
					panels[key] = box;
					panel.append(box);
				});
				["status", "plotInner", "ents", "chars", "assets", "import", "settings"].forEach(function (key) {
					var box = el("div", { class: "coc-subpanel", "data-subpanel": key });
					panels[key] = box;
				});
				panels.plot.append(panels.status, panels.plotInner);
				panels.debug.append(panels.ents, panels.chars, panels.assets, panels.import, panels.settings);
				// renderPlotPanel 等旧函数写入 panels.plot；这里把其输出指向 plotInner 以保持语义

				document.body.append(panel);

				window.addEventListener("resize", function () {
					if (panel.style.left !== "" && panel.style.left !== null) clampPanelToViewport(panel);
				});

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
					panel.classList.toggle("net-mode", key === "net");
					["dm", "plot", "net", "debug"].forEach(function (k) { panels[k].style.display = k === key ? "flex" : "none"; });
					Object.keys(tabButtons).forEach(function (k) { tabButtons[k].classList.toggle("on", k === key); });
					if (key === "plot") { renderStatusPanel(); renderPlotPanel(); }
					else if (key === "net") renderNetPanel();
					else if (key === "debug") renderDebugPanel();
					else renderDmPanel();
				}
				Object.keys(tabButtons).forEach(function (key) {
					tabButtons[key].addEventListener("click", function () { showTab(key); });
				});
				gameSelect.addEventListener("change", function () {
					setGame(gameSelect.value || "default");
					refreshGameSelects();
					resetSession();
					poll(true);
					if (typeof playerPoll === "function") playerPoll();
				});
				newGameBtn.addEventListener("click", function () { openGameWizard(); });
				delGameBtn.addEventListener("click", function () {
					var gid = gameId();
					if (!confirm("确定删除当前场次「" + gid + "」？该场次的所有游戏数据都会删除，通用资产不受影响。")) return;
					post("/coc-api/game-delete", { game: gid }).then(function (json) {
						if (!json.ok) { alert("删除失败：" + (json.error || "未知错误")); return; }
						refreshGames().then(function () {
							var opts = gameSelect.options;
							if (opts.length > 0) {
								setGame(opts[0].value);
							} else {
								post("/coc-api/game-create", { game: "default" }).then(function () {
									setGame("default");
									resetSession();
									poll(true);
								});
								return;
							}
							resetSession();
							poll(true);
						});
					});
				});
				refreshBtn.addEventListener("click", function () { poll(true); });

				// ── 场次创建向导（选剧本 → 选调查员 → 开场白） ──
				function openGameWizard(presetScenarioId) {
					var existing = document.getElementById("coc-game-wizard");
					if (existing !== null) existing.remove();
					var ws = { step: 1, scenarioId: "", characterAssetIds: [], aiInvestigatorIds: [], scenarios: [], investigators: [] };
					var overlay = el("div", { id: "coc-game-wizard", class: "coc-wizard-overlay" });
					var modal = el("div", { class: "coc-wizard" });
					overlay.append(modal);
					overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });

					var step1 = el("div", { class: "coc-wizard-step" });
					var step2 = el("div", { class: "coc-wizard-step" });
					var step3 = el("div", { class: "coc-wizard-step" });
					var step4 = el("div", { class: "coc-wizard-step" });
					modal.append(step1, step2, step3, step4);

					function showStep(n) { ws.step = n; [step1, step2, step3, step4].forEach(function (el2, i) { el2.style.display = (i + 1) === n ? "block" : "none"; }); }

					// Step 1：场次名 + 剧本
					step1.append(el("h3", null, "① 新场次：选择剧本"));
					var nameInput = el("input", { type: "text", placeholder: "场次名称（默认 game-xxx）", spellcheck: "false" });
					nameInput.style.width = "100%";
					nameInput.value = "game-" + Date.now().toString(36);
					step1.append(nameInput);
					var scenSel = el("select", { style: "width:100%;margin-top:8px" });
					scenSel.append(el("option", { value: "" }, "（不选剧本，创建空场次）"));
					var scenHint = el("div", { class: "coc-mini" });
					var scenRow = el("div", { class: "coc-row", style: "align-items:center;gap:6px;margin-top:8px" });
					var scenReloadBtn = el("button", { type: "button", title: "重新加载剧本列表", style: "padding:4px 8px" }, "刷新列表");
					scenReloadBtn.addEventListener("click", function (e) { e.preventDefault(); loadScenarios(); });
					scenRow.append(scenSel, scenReloadBtn);
					step1.append(scenRow, scenHint);
					var loadScenarios = function () {
						scenSel.textContent = "";
						scenSel.append(el("option", { value: "" }, "（不选剧本，创建空场次）"));
						scenHint.textContent = "剧本列表加载中…";
						post("/coc-api/assets", { kind: "scenarios", action: "list" }).then(function (json) {
							if (!json.ok) { scenHint.textContent = "剧本列表加载失败：" + (json.error || "未知错误"); return; }
							ws.scenarios = json.data || [];
							ws.scenarios.forEach(function (sc) { scenSel.append(el("option", { value: sc.id }, sc.name + "（" + (sc.recommendedPlayers || "2-4 人") + "）")); });
							scenHint.textContent = ws.scenarios.length > 0 ? "共 " + ws.scenarios.length + " 个剧本" : "资产库暂无剧本：请先到「调试 → 导入」导入剧本，或到「卡库」查看";
							if (presetScenarioId) { scenSel.value = presetScenarioId; }
						});
					};
					loadScenarios();
					var next1 = el("button", { type: "button", style: "margin-top:10px" }, "下一步：选择调查员 →");
					next1.addEventListener("click", function () {
						var gid = nameInput.value.trim();
						if (gid.length === 0) { alert("请填写场次名称"); return; }
						ws.gameId = gid;
						ws.scenarioId = scenSel.value;
						var sc = ws.scenarios.find(function (x) { return x.id === ws.scenarioId; });
						var hintText = sc !== undefined ? "📖 " + sc.name + "｜建议人数：" + (sc.recommendedPlayers || "2-4 人") : "未选择剧本";
						scenHint.textContent = "";
						var scenInfo = document.getElementById("coc-wiz-scen-info");
						if (scenInfo === null) {
							scenInfo = el("div", { id: "coc-wiz-scen-info", class: "coc-wiz-scen coc-mini" });
							step2.insertBefore(scenInfo, step2.querySelector(".coc-wiz-next2"));
						}
						scenInfo.textContent = hintText;
						loadInvestigatorChoices();
						showStep(2);
					});
					step1.append(next1);

					// Step 2：调查员多选 + AI 调查员（明确选项）
					step2.append(el("h3", null, "② 加入调查员卡"));
					step2.append(el("div", { class: "coc-mini", style: "margin-bottom:4px" }, "玩家调查员（可多选）"));
					var pcList = el("div", { class: "coc-wiz-pc-list" });
					step2.append(pcList);
					var aiRow = el("div", { class: "coc-row", style: "margin-top:10px;align-items:center" });
					aiRow.append(el("span", null, "🤖 是否加入 AI 调查员？"));
					var aiSel = el("select", { style: "flex:1" });
					aiSel.append(el("option", { value: "" }, "不加入（由玩家主导剧情）"));
					aiRow.append(aiSel);
					step2.append(aiRow);
					var aiHint = el("div", { class: "coc-mini", style: "margin-top:4px" }, "AI 调查员会参与剧情但不主导推进，由 KP 代管。");
					step2.append(aiHint);
					var back2 = el("button", { type: "button", style: "margin-top:10px" }, "← 上一步");
					var next2 = el("button", { type: "button", class: "coc-wiz-next2", style: "margin-top:10px;margin-left:6px" }, "下一步：确认创建 →");
					step2.append(back2, next2);
					back2.addEventListener("click", function () { showStep(1); });
					aiSel.addEventListener("change", function () {
						ws.aiInvestigatorIds = aiSel.value ? [aiSel.value] : [];
						aiHint.textContent = aiSel.value ? "已选择 AI 调查员：" + aiSel.options[aiSel.selectedIndex].text : "AI 调查员会参与剧情但不主导推进，由 KP 代管。";
					});
					function loadInvestigatorChoices() {
						pcList.textContent = "加载调查员卡…";
						post("/coc-api/assets", { kind: "investigators", action: "list" }).then(function (json) {
							if (!json.ok) { pcList.textContent = "加载失败"; return; }
							ws.investigators = json.data || [];
							pcList.textContent = "";
							aiSel.textContent = "";
							aiSel.append(el("option", { value: "" }, "不加入（由玩家主导剧情）"));
							var players = ws.investigators.filter(function (inv) { return inv.aiControlled !== true; });
							var aiCards = ws.investigators.filter(function (inv) { return inv.aiControlled === true; });
							if (players.length === 0) pcList.append(el("div", { class: "coc-mini" }, "暂无通用玩家调查员卡：可先到「调试 → 导入」导入人物卡。"));
							players.forEach(function (inv) {
								var row = el("div", { class: "coc-wiz-pc", style: "display:flex;align-items:center;gap:6px" });
								var info = el("span", { style: "flex:1" });
								info.textContent = esc(inv.name) + "｜" + esc(inv.occupation || "无职业") + "｜HP " + inv.hp + " SAN " + inv.san;
								var badge = el("span", { class: "coc-mini", style: "min-width:34px;text-align:center" }, "未选");
								var toggle = function () {
									var idx = ws.characterAssetIds.indexOf(inv.id);
									if (idx >= 0) {
										ws.characterAssetIds.splice(idx, 1);
										badge.textContent = "未选";
										btn.textContent = "加入";
										btn.style.background = "";
									} else {
										ws.characterAssetIds.push(inv.id);
										badge.textContent = "✓ 已选";
										btn.textContent = "移除";
										btn.style.background = "rgba(180,80,80,.5)";
									}
								};
								var btn = el("button", { type: "button", style: "padding:2px 10px;font-size:11px" }, "加入");
								btn.addEventListener("click", toggle);
								row.append(info, badge, btn);
								pcList.append(row);
							});
							aiCards.forEach(function (inv) {
								aiSel.append(el("option", { value: inv.id }, inv.name + "（" + (inv.occupation || "无职业") + "）"));
							});
							if (aiCards.length === 0) aiSel.append(el("option", { value: "" }, "（暂无可用的 AI 调查员卡）"));
							aiHint.textContent = "AI 调查员会参与剧情但不主导推进，由 KP 代管。";
						});
					}
					next2.addEventListener("click", function () {
						if (ws.characterAssetIds.length === 0 && ws.aiInvestigatorIds.length === 0) {
							if (!confirm("没有加入调查员，确定继续创建空场次吗？")) return;
						}
						var sc = ws.scenarios.find(function (x) { return x.id === ws.scenarioId; });
						sumBox.textContent = "";
						sumBox.append(el("div", null, "场次：" + ws.gameId));
						sumBox.append(el("div", null, "剧本：" + (sc !== undefined ? sc.name + "（" + (sc.recommendedPlayers || "2-4 人") + "）" : "无")));
						var chosen = ws.characterAssetIds.concat(ws.aiInvestigatorIds).map(function (id2) {
							var inv = ws.investigators.find(function (x) { return x.id === id2; });
							return inv !== undefined ? inv.name + (inv.aiControlled ? "（AI）" : "") : id2;
						});
						sumBox.append(el("div", null, "调查员：" + (chosen.length > 0 ? chosen.join("、") : "无")));
						showStep(3);
					});

					// Step 3：确认
					var sumBox = el("div", { class: "coc-wiz-sum" });
					step3.append(el("h3", null, "③ 确认创建"));
					step3.append(sumBox);
					var back3 = el("button", { type: "button", style: "margin-top:10px" }, "← 上一步");
					var createBtn = el("button", { type: "button", style: "margin-top:10px;margin-left:6px;font-weight:600" }, "🚀 创建并开始");
					step3.append(back3, createBtn);
					back3.addEventListener("click", function () { showStep(2); });
					createBtn.addEventListener("click", function () {
						createBtn.disabled = true;
						createBtn.textContent = "创建中…";
						post("/coc-api/game-setup", {
							game: ws.gameId,
							scenarioId: ws.scenarioId || "",
							characterAssetIds: ws.characterAssetIds,
							aiInvestigatorIds: ws.aiInvestigatorIds
						}).then(function (json) {
							createBtn.disabled = false;
							createBtn.textContent = "🚀 创建并开始";
							if (!json.ok) { alert("创建失败：" + (json.error || "未知错误")); return; }
							step4.textContent = "";
							step4.append(el("h3", null, "🎬 开场白"));
							var opening = el("div", { class: "pp-msg kp", style: "white-space:pre-wrap" }, json.data.opening || "");
							step4.append(opening);
							var meta = "场次：" + json.data.game + "｜角色：" + (json.data.characters || []).join("、") + (json.data.scenario ? "｜剧本：" + json.data.scenario.name : "");
							step4.append(el("div", { class: "coc-mini" }, meta));
							var enterBtn = el("button", { type: "button", style: "margin-top:10px;font-weight:600" }, "进入场次 →");
							enterBtn.addEventListener("click", function () {
								overlay.remove();
								refreshGames().then(function () {
									setGame(ws.gameId);
									resetSession();
									poll(true);
								});
							});
							step4.append(enterBtn);
							showStep(4);
						});
					});

					document.body.append(overlay);
					showStep(1);
				}
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
							if (S.tab === "dm") updateDebugStateCard();
							if (force) { renderChatFull(); renderPanel(S.tab); }
						} else {
							S.error = json.error || "";
						}
						return json;
					}).catch(function () { loading.style.display = "none"; });
				}
				kpPoll = poll;
				kpResetAndPoll = function () { resetSession(); poll(true); };
				function refreshGames() {
					return refreshGameSelects();
				}

				// ── 聊天渲染 ──
				function entryNode(entry) {
					var box = el("div", { class: "coc-msg " + (entry.kind === "user" ? "user" : entry.kind === "kp" ? "kp" : "sys") });
					if (entry.kind === "user") {
						box.append(el("span", { class: "who" }, esc(entry.player || "玩家") + " · " + fmtTime(entry.at)));
						box.append(document.createTextNode(entry.text));
					} else if (entry.kind === "kp") {
						box.append(el("span", { class: "who" }, "KP · " + fmtTime(entry.at)));
						appendMarkdown(box, entry.text);
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
					else if (key === "net") renderNetPanel();
					else if (key === "debug") renderDebugPanel();
					else renderDmPanel();
				}
				// ── 主持页：KP 自然语言指令（预览 → 确认执行） ──
				var kpCommandInput = null;
				var kpPreviewBox = null;
				var debugStateBox = null;
				var kpCommandDraft = "";

				// ── 运行调试卡：只读快照 + 门禁快捷操作（走正常聊天/工具 API） ──
				function debugBadge(text, color) {
					var badge = el("span", { class: "coc-badge", style: "margin-right:4px" });
					badge.textContent = text;
					if (color) badge.style.color = color;
					return badge;
				}
				function debugActionButton(label, fn) {
					var btn = el("button", { type: "button", style: "padding:1px 8px;font-size:11px;margin-left:4px" }, label);
					btn.addEventListener("click", function () {
						if (btn.disabled) return;
						btn.disabled = true;
						fn(function () { btn.disabled = false; }, function (err) { btn.disabled = false; note.textContent = "调试操作失败：" + err.message; });
					});
					return btn;
				}
				function debugRefresh() {
					return poll(false).then(function () { updateDebugStateCard(); });
				}
				function debugPost(action) {
					return post("/coc-api/debug", action).then(function (json) {
						if (!json.ok) throw new Error(json.error || "未知错误");
						return debugRefresh();
					});
				}
				function debugRoll(skill) {
					return post("/coc-api/chat", { text: ".ra" + skill, player: "玩家" }).then(function (json) {
						if (!json.ok) throw new Error(json.error || "未知错误");
						kpResetAndPoll();
					});
				}
				function debugChooseCandidate(skill, index) {
					return post("/coc-api/chat", { text: ".ra" + skill + " " + index, player: "玩家" }).then(function (json) {
						if (!json.ok) throw new Error(json.error || "未知错误");
						kpResetAndPoll();
					});
				}
				// 与 lib/shared/testing/story-presets.js 的 STORY_PRESET_NAMES 保持一致。
				var DEBUG_PRESETS = [
					["arrival", "门厅"],
					["door", "门外"],
					["study-entered", "已进书房"],
					["diary-found", "日记手稿"],
					["rug-revealed", "地毯接缝"],
					["spell-decoded", "咒文已解"],
					["final-rite", "最终仪式"],
				];
				function debugGotoPreset(name) {
					return post("/coc-api/debug", { action: "gotoPreset", preset: name }).then(function (json) {
						if (!json.ok) throw new Error(json.error || "未知错误");
						kpResetAndPoll();
					});
				}
				function debugExportFixture(fixtureBox) {
					return post("/coc-api/debug", { action: "exportFixture" }).then(function (json) {
						if (!json.ok) throw new Error(json.error || "未知错误");
						fixtureBox.value = JSON.stringify(json.data, null, 2);
					});
				}
				function updateDebugStateCard() {
					if (debugStateBox === null) return;
					debugStateBox.textContent = "";
					var dbg = S.digest === null ? null : S.digest.debug;
					if (dbg === null || dbg === undefined) {
						debugStateBox.append(el("div", { class: "coc-mini" }, "暂无调试数据"));
						return;
					}
					var row = el("div", { class: "coc-row", style: "flex-wrap:wrap" });
					row.append(debugBadge("场景：" + esc(S.digest.currentScene || "—")));
					row.append(debugBadge("分支：" + esc(S.digest.currentBranchId || "—")));
					row.append(debugBadge(dbg.busy ? "busy" : "idle", dbg.busy ? "#ffd98a" : "#9fe0c0"));
					row.append(debugBadge(dbg.endingReached ? "已结局" : "进行中", dbg.endingReached ? "#ff9f9f" : "#9fe0c0"));
					debugStateBox.append(row);

					// 剧情点跳转（测试）：gotoPreset 走 /coc-api/debug，重置剧情状态到标准节点。
					var presetCard = el("div", { class: "coc-card" });
					presetCard.append(el("h4", null, "剧情点跳转（测试）"));
					DEBUG_PRESETS.forEach(function (entry) {
						presetCard.append(debugActionButton(entry[1], function (done, fail) {
							debugGotoPreset(entry[0]).then(done).catch(fail);
						}));
					});
					var fixtureBox = el("textarea", {
						readonly: true,
						placeholder: "点击“导出状态”后，复制此处的场次夹具 JSON",
						style: "width:100%;height:90px;margin-top:6px;font-size:10px;box-sizing:border-box;display:block",
					});
					presetCard.append(debugActionButton("导出状态", function (done, fail) {
						debugExportFixture(fixtureBox).then(done).catch(fail);
					}));
					presetCard.append(fixtureBox);
					debugStateBox.append(presetCard);

					// 门禁
					var gateCard = el("div", { class: "coc-card" });
					gateCard.append(el("h4", null, "待处理门禁（" + dbg.pendingChecks.length + "）"));
					if (dbg.pendingChecks.length === 0) gateCard.append(el("div", { class: "coc-mini" }, "无"));
					dbg.pendingChecks.forEach(function (gate) {
						var item = el("div", { class: "coc-kp-item" });
						var text = esc(gate.skill) + (gate.difficulty && gate.difficulty !== "regular" ? "·" + esc(gate.difficulty) : "") +
							(gate.action ? "：" + esc(gate.action) : "");
						item.append(el("span", null, text));
						item.append(debugActionButton("掷骰", function (done, fail) {
							debugRoll(gate.skill).then(done).catch(fail);
						}));
						item.append(debugActionButton("移除", function (done, fail) {
							debugPost({ action: "removeGate", gateId: gate.id }).then(done).catch(fail);
						}));
						gateCard.append(item);
					});
					var gateOps = el("div", { class: "coc-row", style: "margin-top:4px" });
					gateOps.append(debugActionButton("清空门禁", function (done, fail) {
						debugPost({ action: "clearGates" }).then(done).catch(fail);
					}));
					gateCard.append(gateOps);
					debugStateBox.append(gateCard);

					// 可达路线（frontier）
					if (dbg.frontier) {
						var frontierCard = el("div", { class: "coc-card" });
						frontierCard.append(el("h4", null, "可达路线（程序计算）"));
						frontierCard.append(el("pre", { class: "coc-mini", style: "white-space:pre-wrap;margin:4px 0" }, esc(dbg.frontier)));
						debugStateBox.append(frontierCard);
					}

					// 候选确认
					if (dbg.pendingChoice !== null && dbg.pendingChoice !== undefined) {
						var choiceCard = el("div", { class: "coc-card" });
						choiceCard.append(el("h4", null, "候选确认：" + esc(dbg.pendingChoice.skill || "")));
						(dbg.pendingChoice.candidates || []).forEach(function (candidate, index) {
							var item = el("div", { class: "coc-kp-item" });
							item.append(el("span", null, (index + 1) + ". " + esc(candidate)));
							item.append(debugActionButton("选" + (index + 1), function (done, fail) {
								debugChooseCandidate(dbg.pendingChoice.skill, index + 1).then(done).catch(fail);
							}));
							choiceCard.append(item);
						});
						choiceCard.append(debugActionButton("清除候选", function (done, fail) {
							debugPost({ action: "clearChoice" }).then(done).catch(fail);
						}));
						debugStateBox.append(choiceCard);
					}

					// 已通过检定点 / 已通过门禁
					var passedCard = el("div", { class: "coc-card" });
					passedCard.append(el("h4", null, "已通过检定点 / 已通过门禁"));
					passedCard.append(el("div", { class: "coc-mini" }, "checkpoints: " + esc((dbg.passedCheckpointIds || []).join(", ") || "无")));
					passedCard.append(el("div", { class: "coc-mini" }, "resolvedChecks: " + esc((dbg.resolvedChecks || []).join(" | ") || "无")));
					passedCard.append(debugActionButton("清空 resolved", function (done, fail) {
						debugPost({ action: "clearResolved" }).then(done).catch(fail);
					}));
					debugStateBox.append(passedCard);

					// SAN 结算
					if (dbg.sanitySettled.length > 0) {
						var sanCard = el("div", { class: "coc-card" });
						sanCard.append(el("h4", null, "SAN 结算（" + dbg.sanitySettled.length + "）"));
						dbg.sanitySettled.slice(-6).forEach(function (entry) {
							sanCard.append(el("div", { class: "coc-mini" }, esc((entry.eventId || "") + " / " + (entry.player || ""))));
						});
						debugStateBox.append(sanCard);
					}

					// 程序事件流
					var eventCard = el("div", { class: "coc-card" });
					eventCard.append(el("h4", null, "程序事件流（新→旧）"));
					var events = dbg.events || [];
					if (events.length === 0) eventCard.append(el("div", { class: "coc-mini" }, "无"));
					events.slice(0, 18).forEach(function (entry) {
						var line = el("div", { class: "coc-mini", style: "margin:2px 0" });
						var when = String(entry.at || "").slice(11, 19);
						line.textContent = when + " " + esc(entry.kind || "") +
							(entry.skill ? " " + esc(entry.skill) : "") +
							(entry.action ? "「" + esc(String(entry.action).slice(0, 40)) + "」" : "") +
							(entry.checkpointId ? " " + esc(entry.checkpointId) : "");
						eventCard.append(line);
					});
					debugStateBox.append(eventCard);
				}
				function renderDebugStateCard(box) {
					var card = el("div", { class: "coc-card" });
					card.append(el("h4", null, "运行调试（只读）"));
					debugStateBox = el("div");
					card.append(debugStateBox);
					updateDebugStateCard();
					box.append(card);
				}
				function renderDmPanel() {
					var box = panels.dm;
					box.textContent = "";
					var card = el("div", { class: "coc-card" });
					card.append(el("h4", null, "KP 指令（自然语言 → 结构化工具调用）"));
					kpCommandInput = el("textarea", { placeholder: "例如：让守秘人做一个暗骰，看玩家是否发现门后的血迹" });
					kpCommandInput.value = kpCommandDraft;
					kpCommandInput.addEventListener("input", function () { kpCommandDraft = kpCommandInput.value; });
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
					renderContractCard(box);
					renderDeepParseCard(box);
					renderDebugStateCard(box);
				}

				// ── 主持页：剧本执行契约（ScenarioContract）编辑/确认 ──
				function renderContractCard(box) {
					var card = el("div", { class: "coc-card" });
					card.append(el("h4", null, "剧本执行契约（ScenarioContract）"));
					var statusLine = el("div", { class: "coc-kv" });
					statusLine.textContent = "加载中…";
					card.append(statusLine);

					var editor = el("textarea", { spellcheck: "false", placeholder: "JSON 契约" });
					editor.style.minHeight = "260px";
					editor.style.fontFamily = "ui-monospace,SFMono-Regular,Menlo,monospace";
					editor.style.fontSize = "11.5px";
					card.append(editor);

					var info = el("div", { class: "coc-kv" });
					info.textContent = "契约在「确认生效」前不拦截叙述；确认后 KP 叙述会接受线索门禁/NPC 知识/仪式条件/最终分支白名单校验。";
					info.style.color = "#aebce0";
					card.append(info);

					var row = el("div", { class: "coc-row" });
					var reloadBtn = el("button", { type: "button" }, "刷新");
					var saveBtn = el("button", { type: "button" }, "保存草稿");
					var confirmBtn = el("button", { type: "button", style: "background:rgba(60,110,200,.42);font-weight:600" }, "确认生效");
					row.append(reloadBtn, saveBtn, confirmBtn);
					card.append(row);

					var contractData = null;

					function loadContract() {
						api("/coc-api/contract?game=" + encodeURIComponent(gameId())).then(function (json) {
							if (!json.ok) { statusLine.textContent = "加载失败：" + (json.error || "未知错误"); return; }
							var data = json.data;
							if (data === null || data.contract === null || data.contract === undefined) {
								statusLine.textContent = "尚无契约。导入剧本后会自动草拟。";
								editor.value = "";
								return;
							}
							contractData = data.contract;
							var status = data.status || "none";
							var source = data.source || "none";
							statusLine.textContent = "状态：" + status + "　来源：" + source + (status === "confirmed" ? "（已生效，叙述将被校验）" : "（未生效，仅草拟）");
							editor.value = JSON.stringify(contractData, null, 2);
						});
					}

					reloadBtn.addEventListener("click", loadContract);
					saveBtn.addEventListener("click", function () {
						var parsed = null;
						try { parsed = JSON.parse(editor.value); } catch (err) {
							statusLine.textContent = "JSON 解析失败：" + err.message;
							return;
						}
						saveBtn.disabled = true;
						post("/coc-api/contract", { contract: parsed, status: "draft", source: "manual" }).then(function (json) {
							saveBtn.disabled = false;
							if (!json.ok) { statusLine.textContent = "保存失败：" + (json.error || "未知错误"); return; }
							statusLine.textContent = "已保存草稿（未生效）。";
							poll(true);
						});
					});
					confirmBtn.addEventListener("click", function () {
						confirmBtn.disabled = true;
						post("/coc-api/contract", { action: "confirm" }).then(function (json) {
							confirmBtn.disabled = false;
							if (!json.ok) { statusLine.textContent = "确认失败：" + (json.error || "未知错误"); return; }
							statusLine.textContent = "已确认生效。之后 KP 叙述将接受契约校验。";
							poll(true);
						});
					});

					loadContract();
					box.append(card);
				}

				// ── 主持页：深度剧情解析（DeepParse）编辑/确认 ──
				function renderDeepParseCard(box) {
					var card = el("div", { class: "coc-card" });
					card.append(el("h4", null, "深度剧情解析（DeepParse）"));
					var statusLine = el("div", { class: "coc-kv" });
					statusLine.textContent = "加载中…";
					card.append(statusLine);

					var graphWarn = el("div", { class: "coc-kv" });
					graphWarn.style.color = "#e0b87c";
					graphWarn.style.marginBottom = "6px";
					card.append(graphWarn);

					var editor = el("textarea", { spellcheck: "false", placeholder: "JSON 深度剧情解析（keyPoints/branches/keyPointConditions/branchConditions/plotEdges/endings）" });
					editor.style.minHeight = "260px";
					editor.style.fontFamily = "ui-monospace,SFMono-Regular,Menlo,monospace";
					editor.style.fontSize = "11.5px";
					card.append(editor);

					var info = el("div", { class: "coc-kv" });
					info.textContent = "深度解析在「确认生效」前不参与运行时判定；确认后 D-4 会把它接入剧情图与结局条件。";
					info.style.color = "#aebce0";
					card.append(info);

					var row = el("div", { class: "coc-row" });
					var reloadBtn = el("button", { type: "button" }, "刷新");
					var saveBtn = el("button", { type: "button" }, "保存草稿");
					var confirmBtn = el("button", { type: "button", style: "background:rgba(60,110,200,.42);font-weight:600" }, "确认生效");
					row.append(reloadBtn, saveBtn, confirmBtn);
					card.append(row);

					function loadDeepParse() {
						api("/coc-api/deep-parse?game=" + encodeURIComponent(gameId())).then(function (json) {
							if (!json.ok) { statusLine.textContent = "加载失败：" + (json.error || "未知错误"); return; }
							var data = json.data;
							if (data === null || data.deepParse === null || data.deepParse === undefined) {
								statusLine.textContent = "尚无深度剧情解析。导入剧本后可用 LLM 生成草稿。";
								editor.value = "";
								graphWarn.textContent = "";
								return;
							}
							var status = data.status || "none";
							var source = data.source || "none";
							statusLine.textContent = "状态：" + status + "　来源：" + source + (status === "confirmed" ? "（已确认，待 D-4 接入运行时）" : "（未生效，仅草拟）");
							var graphIssues = Array.isArray(data.deepParse.graphIssues) ? data.deepParse.graphIssues : [];
							graphWarn.textContent = graphIssues.length > 0
								? "⚠ 剧情图提示：" + graphIssues.map(function (item) { return item.scene + "（" + item.issue + "）"; }).join("、")
								: "";
							editor.value = JSON.stringify(data.deepParse, null, 2);
						});
					}

					reloadBtn.addEventListener("click", loadDeepParse);
					saveBtn.addEventListener("click", function () {
						var parsed = null;
						try { parsed = JSON.parse(editor.value); } catch (err) {
							statusLine.textContent = "JSON 解析失败：" + err.message;
							return;
						}
						saveBtn.disabled = true;
						post("/coc-api/deep-parse", { deepParse: parsed, status: "draft", source: "manual" }).then(function (json) {
							saveBtn.disabled = false;
							if (!json.ok) { statusLine.textContent = "保存失败：" + (json.error || "未知错误"); return; }
							statusLine.textContent = "已保存草稿（未生效）。";
							poll(true);
						});
					});
					confirmBtn.addEventListener("click", function () {
						confirmBtn.disabled = true;
						post("/coc-api/deep-parse", { action: "confirm" }).then(function (json) {
							confirmBtn.disabled = false;
							if (!json.ok) { statusLine.textContent = "确认失败：" + (json.error || "未知错误"); return; }
							statusLine.textContent = "已确认生效。D-4 接入运行时后生效。";
							poll(true);
						});
					});

					loadDeepParse();
					box.append(card);
				}
				// ── 调试页：导入 / 实体 / 设置 子切换 ──
				var debugTab = "import";
				function renderDebugPanel() {
					var box = panels.debug;
					box.textContent = "";
					var row = el("div", { class: "coc-row" });
					[["chars", "人物"], ["assets", "卡库"], ["import", "导入"], ["ents", "实体"], ["settings", "设置"]].forEach(function (pair) {
						var btn = el("button", { type: "button", style: "flex:1" }, pair[1]);
						if (debugTab === pair[0]) btn.style.background = "rgba(120,90,30,.5)";
						btn.addEventListener("click", function () { debugTab = pair[0]; renderDebugPanel(); });
						row.append(btn);
					});
					box.append(row);
					["import", "ents", "chars", "assets", "settings"].forEach(function (key) { panels[key].style.display = "none"; });
					box.append(panels.import, panels.ents, panels.chars, panels.assets, panels.settings);
					if (debugTab === "import") { panels.import.style.display = "block"; renderImportPanel(); }
					else if (debugTab === "ents") { panels.ents.style.display = "block"; renderEntsPanel(); }
					else if (debugTab === "chars") { panels.chars.style.display = "block"; renderCharsPanel(); }
					else if (debugTab === "assets") { panels.assets.style.display = "block"; renderAssetsPanel(); }
					else { panels.settings.style.display = "block"; renderSettingsPanel(); }
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
				function openDetailModal(title, buildBody) {
					var existing = document.getElementById("coc-detail-modal");
					if (existing !== null) existing.remove();
					var overlay = el("div", { id: "coc-detail-modal", class: "coc-detail-overlay" });
					var modal = el("div", { class: "coc-detail" });
					modal.append(el("h3", null, title));
					var body = el("div", { class: "coc-detail-body" });
					modal.append(body);
					var closeBtn = el("button", { type: "button", style: "margin-top:10px" }, "关闭");
					closeBtn.addEventListener("click", function () { overlay.remove(); });
					modal.append(closeBtn);
					overlay.append(modal);
					overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });
					document.body.append(overlay);
					buildBody(body, overlay);
					return overlay;
				}
				function showKpDetail(kp) {
					openDetailModal("关键剧情点：" + kp.title, function (body, overlay) {
						kv2(body, "状态", kp.revealed ? "已揭示" : "未揭示");
						kv2(body, "场景", kp.scene || "（未设定）");
						kv2(body, "所属剧本", kp.scenarioId || "（无）");
						if (kp.desc) kv2(body, "描述", kp.desc);
						if (!kp.revealed) {
							var revealBtn = el("button", { type: "button", style: "margin-top:10px" }, "标记为已揭示");
							revealBtn.addEventListener("click", function () {
								tool("coc_branch", { action: "reveal", keyPointId: kp.id }).then(function () { overlay.remove(); poll(true); });
							});
							body.append(revealBtn);
						}
					});
				}
				function showBranchDetail(branch) {
					openDetailModal("剧情分支：" + branch.title, function (body, overlay) {
						kv2(body, "状态", branch.chosen ? "已选择：" + branch.chosen : (branch.id === S.digest?.currentBranchId ? "当前分支" : "未选择"));
						kv2(body, "场景", branch.scene || "（未设定）");
						kv2(body, "所属剧本", branch.scenarioId || "（无）");
						if (branch.desc) kv2(body, "描述", branch.desc);
						if (!branch.chosen && Array.isArray(branch.options) && branch.options.length > 0) {
							body.append(el("div", { class: "coc-mini", style: "margin-top:8px" }, "可选项："));
							branch.options.forEach(function (option) {
								var row = el("div", { class: "coc-row", style: "align-items:center;gap:6px;margin-top:4px" });
								row.append(el("span", { style: "flex:1" }, esc(option.label) + (option.leadsTo ? " → " + esc(option.leadsTo) : "")));
								var chooseBtn = el("button", { type: "button", style: "padding:2px 10px;font-size:11px" }, "选择此分支");
								chooseBtn.addEventListener("click", function () {
									tool("coc_branch", { action: "choose", branchId: branch.id, optionLabel: option.label }).then(function () { overlay.remove(); poll(true); });
								});
								row.append(chooseBtn);
								body.append(row);
							});
						} else if (branch.chosen) {
							kv2(body, "已选择", branch.chosen);
						} else {
							body.append(el("div", { class: "coc-mini", style: "margin-top:8px" }, "该分支没有可选项。"));
						}
					});
				}
				function kv2(parent, label, value) {
					var row = el("div", { class: "coc-kv" });
					row.append(el("b", null, label + "："), el("span", null, value));
					parent.append(row);
				}
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
						var detailBtn = el("button", { type: "button", style: "margin-left:auto;padding:0 7px;font-size:11px" }, "详情");
						detailBtn.addEventListener("click", function () { showKpDetail(kp); });
						item.append(detailBtn);
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
						}
						var brDetailBtn = el("button", { type: "button", style: "margin-left:auto;padding:0 7px;font-size:11px" }, "详情");
						brDetailBtn.addEventListener("click", function () { showBranchDetail(branch); });
						item.append(brDetailBtn);
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
				}// ── 解析页：深度剧情解析网络结构（SVG 拓扑 + DOM 详情）──
				var NET_UI = { search: "", type: "all", scene: "all", foldChecks: true, zoom: 1, selected: null, focus: "final", issueSeverity: "all", layout: "scene" };
				function svgEl(tag, attrs) {
					var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
					if (attrs) for (var key in attrs) if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
					return node;
				}
				function wrapLabel(title, id, maxPerLine, maxLines) {
					var text = Array.from(String(title || id || ""));
					var limit = maxPerLine * maxLines;
					if (text.length > limit) text = text.slice(0, limit - 1).concat(["…"]);
					var lines = [];
					for (var i = 0; i < text.length; i += maxPerLine) lines.push(text.slice(i, i + maxPerLine).join(""));
					return lines.length > 0 ? lines : [""];
				}
				function nodeDisplayTitle(node) {
					// 场景条带内去掉「场景名·」前缀，避免同一条带里场景名反复出现
					var title = String(node.title || node.id || "");
					var scene = String(node.scene || "");
					if (scene && title !== scene) {
						var sep = scene + "·";
						if (title.indexOf(sep) === 0) return title.slice(sep.length);
						sep = scene + "：";
						if (title.indexOf(sep) === 0) return title.slice(sep.length);
					}
					return title;
				}
				function netNodeId(type, id) {
					return type + ":" + String(id || "");
				}
				function netResolveNode(nodesById, raw) {
					if (raw === null || raw === undefined) return null;
					var value = String(raw).trim();
					if (value.length === 0) return null;
					if (nodesById.has(value)) return nodesById.get(value);
					if (value.startsWith("end:")) {
						var rest = value.slice(4);
						var byId = nodesById.get("end:" + rest);
						if (byId !== undefined) return byId;
						var vals = Array.from(nodesById.values());
						for (var _i = 0; _i < vals.length; _i += 1) {
							var candidate = vals[_i];
							if (candidate && candidate.type === "end" && (String(candidate.id) === rest || String(candidate.title) === rest)) return candidate;
						}
						return null;
					}
					var all = Array.from(nodesById.values());
					for (var _j = 0; _j < all.length; _j += 1) {
						var node = all[_j];
						if (node === undefined) continue;
						var title = String(node.title || "");
						var id = String(node.id || "");
						if (title === value || id === value || title.includes(value) || value.includes(title)) return node;
					}
					return null;
				}
				function buildEvolutionView(nodeById, edgeList, ui) {
					// 演进视图：把检定分支折叠成「场景关键点 → 目标关键点」的琥珀虚线边，
					// 只保留关键点、玩家选择型分支和结局作为节点，按拓扑层从左到右排布。
					function normSceneName(value) { return String(value || "").replace(/[：:]\s*$/, "").trim(); }
					var visible = [];
					var checkpointBrs = [];
					nodeById.forEach(function (node) {
						if (ui.type !== "all" && node.type !== ui.type) return;
						if (ui.scene !== "all" && normSceneName(node.scene) !== normSceneName(ui.scene)) return;
						if (ui.search) {
							var hay = (node.title || "") + " " + (node.id || "") + " " + (node.scene || "");
							if (hay.toLowerCase().indexOf(ui.search.toLowerCase()) < 0) return;
						}
						if (node.type === "br" && node.checkpointBranch === true) { checkpointBrs.push(node); return; }
						visible.push(node);
					});

					function findSceneKp(br) {
						for (var _i = 0; _i < visible.length; _i += 1) {
							var node = visible[_i];
							if (node.type === "kp" && (normSceneName(node.scene) === normSceneName(br.scene) || normSceneName(node.title) === normSceneName(br.scene))) return node;
						}
						return null;
					}

					// 没有场景关键点可锚定的检定分支保留为节点，避免信息丢失
					var fallbackBrs = [];
					checkpointBrs.forEach(function (br) { if (findSceneKp(br) === null) { fallbackBrs.push(br); visible.push(br); } });
					var visibleById = new Map(visible.map(function (node) { return [netNodeId(node.type, node.id), node]; }));

					// 基础边：两端都在演进节点中的原始边
					var visEdges = edgeList.filter(function (edge) {
						return visibleById.has(netNodeId(edge.from.type, edge.from.id)) && visibleById.has(netNodeId(edge.to.type, edge.to.id));
					});

					// 折叠检定分支：
					// - 起点和终点不同 → 合成 sceneKp → target 琥珀虚线边（同对节点合并技能标签）
					// - 起点终点相同（本场景检定） → 作为场景节点的检定徽标，不画自环边
					var checkGroups = new Map();
					var checkBadges = new Map();
					function addCheckLabel(node, label) {
						if (!node || !label) return;
						if (!checkBadges.has(node)) checkBadges.set(node, []);
						var labels = checkBadges.get(node);
						if (labels.indexOf(label) < 0) labels.push(label);
					}
					function skillLabel(br, edge) {
						if (edge && edge.label) return edge.label;
						return nodeDisplayTitle(br) || br.title || br.id;
					}
					checkpointBrs.forEach(function (br) {
						if (fallbackBrs.indexOf(br) >= 0) return;
						var sceneKp = findSceneKp(br);
						if (sceneKp === null) return;
						var sources = [];
						edgeList.forEach(function (edge) {
							if (edge.to === br && visibleById.has(netNodeId(edge.from.type, edge.from.id))) sources.push(edge.from);
						});
						if (sources.length === 0) sources.push(sceneKp);
						var targets = [];
						edgeList.forEach(function (edge) {
							if (edge.from === br && visibleById.has(netNodeId(edge.to.type, edge.to.id))) targets.push({ target: edge.to, label: skillLabel(br, edge) });
						});
						if (targets.length === 0) targets.push({ target: sceneKp, label: skillLabel(br, null) });
						sources.forEach(function (source) {
							targets.forEach(function (item) {
								if (source === item.target) { addCheckLabel(source, item.label); return; }
								var key = netNodeId(source.type, source.id) + "->" + netNodeId(item.target.type, item.target.id);
								if (!checkGroups.has(key)) checkGroups.set(key, { from: source, to: item.target, labels: [] });
								if (item.label) checkGroups.get(key).labels.push(item.label);
							});
						});
					});
					var existingEdgeKeys = new Set(visEdges.map(function (edge) { return netNodeId(edge.from.type, edge.from.id) + "->" + netNodeId(edge.to.type, edge.to.id); }));
					checkGroups.forEach(function (group) {
						var key = netNodeId(group.from.type, group.from.id) + "->" + netNodeId(group.to.type, group.to.id);
						if (existingEdgeKeys.has(key)) return;
						var labels = [];
						group.labels.forEach(function (label) { if (labels.indexOf(label) < 0) labels.push(label); });
						visEdges.push({ from: group.from, to: group.to, label: labels.join(" / "), requires: [], kind: "check" });
					});
					checkBadges.forEach(function (labels, node) { node._checkLabels = labels; });

					// 只对「有边相连」的节点做拓扑分层；孤立节点单独放到底部网格
					var hasIn = new Set();
					var hasOut = new Set();
					visEdges.forEach(function (edge) { hasIn.add(edge.to); hasOut.add(edge.from); });
					var connected = visible.filter(function (node) { return hasIn.has(node) || hasOut.has(node); });
					var isolated = visible.filter(function (node) { return !hasIn.has(node) && !hasOut.has(node); });

					var incoming = new Map();
					connected.forEach(function (node) { incoming.set(node, 0); });
					visEdges.forEach(function (edge) { if (incoming.has(edge.to)) incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1); });
					var layerOf = new Map();
					var queue = [];
					connected.forEach(function (node) { if ((incoming.get(node) || 0) === 0) queue.push(node); });
					while (queue.length > 0) {
						var node = queue.shift();
						if (layerOf.has(node)) continue;
						var layer = 0;
						visEdges.forEach(function (edge) { if (edge.to === node) layer = Math.max(layer, (layerOf.get(edge.from) || 0) + 1); });
						layerOf.set(node, layer);
						visEdges.forEach(function (edge) {
							if (edge.from !== node) return;
							var count = (incoming.get(edge.to) || 0) - 1;
							incoming.set(edge.to, count);
							if (count === 0 && !layerOf.has(edge.to)) queue.push(edge.to);
						});
					}
					var maxLayer = 0;
					layerOf.forEach(function (layer) { if (layer > maxLayer) maxLayer = layer; });
					connected.forEach(function (node) {
						if (!layerOf.has(node)) { maxLayer += 1; layerOf.set(node, maxLayer); }
					});
					// 结局强制最后一列；指向结局的分支放到结局前一列
					connected.forEach(function (node) { if (node.type === "end") layerOf.set(node, maxLayer + 2); });
					connected.forEach(function (node) {
						if (node.type === "end") return;
						visEdges.forEach(function (edge) {
							if (edge.to.type === "end" && edge.from === node) layerOf.set(node, maxLayer + 1);
						});
					});
					maxLayer = 0;
					layerOf.forEach(function (layer) { if (layer > maxLayer) maxLayer = layer; });

					// 每层一列；层内超过 MAX_PER_LAYER 个节点时分成多个子列，避免单列过长
					var STEP_Y = 72;
					var START_X = 70;
					var START_Y = 40;
					var MAX_PER_LAYER = 10;
					var SUB_COL_W = 150;
					var GAP_X = 40;
					var columns = new Map();
					connected.forEach(function (node) {
						var layer = layerOf.get(node) || 0;
						if (!columns.has(layer)) columns.set(layer, []);
						columns.get(layer).push(node);
					});
					var layerOrder = Array.from(columns.keys()).sort(function (a, b) { return a - b; });
					var layerX = new Map();
					var xCursor = START_X;
					var maxInColumn = 0;
					layerOrder.forEach(function (layer) {
						var nodes = columns.get(layer);
						var subCols = Math.max(1, Math.ceil(nodes.length / MAX_PER_LAYER));
						layerX.set(layer, xCursor);
						xCursor += subCols * SUB_COL_W + GAP_X;
						if (Math.min(nodes.length, MAX_PER_LAYER) > maxInColumn) maxInColumn = Math.min(nodes.length, MAX_PER_LAYER);
						nodes.forEach(function (node, index) {
							var sub = Math.floor(index / MAX_PER_LAYER);
							var row = index % MAX_PER_LAYER;
							node._x = layerX.get(layer) + sub * SUB_COL_W;
							node._y = START_Y + row * STEP_Y;
						});
					});
					var flowBottom = START_Y + maxInColumn * STEP_Y + 40;
					var isolatedY = flowBottom + 40;
					var ISO_COLS = 6;
					var ISO_SLOT_W = 112;
					var ISO_SLOT_H = 50;
					var isoRows = Math.ceil(isolated.length / ISO_COLS);
					isolated.forEach(function (node, index) {
						var col = index % ISO_COLS;
						var row = Math.floor(index / ISO_COLS);
						node._x = START_X + col * ISO_SLOT_W;
						node._y = isolatedY + 30 + row * ISO_SLOT_H;
					});
					var svgWidth = Math.max(720, xCursor + 80, START_X + ISO_COLS * ISO_SLOT_W + 80);
					var svgHeight = Math.max(240, (isolated.length > 0 ? isolatedY + 30 + isoRows * ISO_SLOT_H + 90 : flowBottom + 90));

					return {
						visible: visible,
						visEdges: visEdges,
						foldedCount: checkpointBrs.length - fallbackBrs.length,
						svgWidth: svgWidth,
						svgHeight: svgHeight,
						isolated: isolated,
						isolatedY: isolatedY,
					};
				}
				function fmtCondChips(parent, cond, nodeById) {
					if (cond === null || cond === undefined || typeof cond !== "object") return;
					var keys = Object.keys(cond);
					if (keys.length === 0) { parent.append(el("span", { class: "coc-cond" }, "空条件（视为立即满足）")); return; }
					function chip(text, cls, fullText) {
						var chipEl = el("span", { class: "coc-cond" + (cls ? " " + cls : "") }, text);
						if (fullText) chipEl.title = fullText;
						parent.append(chipEl);
					}
					if (cond.scene) chip("📍 场景=" + cond.scene);
					if (Array.isArray(cond.entryEvidence) && cond.entryEvidence.length > 0) {
						var evidenceFull = "🔎 文本证据：" + cond.entryEvidence.join(" / ");
						chip(evidenceFull.length > 80 ? evidenceFull.slice(0, 80) + "…" : evidenceFull, "", evidenceFull);
					}
					if (Array.isArray(cond.checkpointGroups) && cond.checkpointGroups.length > 0) {
						var groups = cond.checkpointGroups.map(function (group) {
							return group.map(function (cid) { return cid; }).join(" 或 ");
						}).join("；且 ");
						chip("✅ 检定通过：" + groups);
					}
					if (Array.isArray(cond.sanityEventIds) && cond.sanityEventIds.length > 0) chip("🧠 SAN 事件：" + cond.sanityEventIds.join(" / "));
					if (Array.isArray(cond.keyPointIds) && cond.keyPointIds.length > 0) {
						var kpLabels = cond.keyPointIds.map(function (kid) {
							var n = netResolveNode(nodeById, "kp:" + kid);
							return n ? n.title + "（" + kid + "）" : kid;
						});
						chip("需已揭示：" + kpLabels.join("、"));
					}
					if (Array.isArray(cond.branchChoiceIds) && cond.branchChoiceIds.length > 0) {
						var brLabels = cond.branchChoiceIds.map(function (bid) {
							var n = netResolveNode(nodeById, "br:" + bid);
							return n ? n.title + "（" + bid + "）" : bid;
						});
						chip("分支已选择：" + brLabels.join("、"));
					}
					if (cond.optionLabel) {
						var labels = Array.isArray(cond.optionLabel) ? cond.optionLabel : [cond.optionLabel];
						chip("选项=" + labels.join(" / "), "routing");
					}
					if (cond.not !== undefined && cond.not !== null) {
						var tmp = el("span");
						fmtCondChips(tmp, cond.not, nodeById);
						var text = tmp.textContent || "";
						chip("排除：" + (text.length > 80 ? text.slice(0, 80) + "…" : text), "neg");
					}
				}
				function qualityIssueList(q) {
					var issues = [];
					function pushChannel(channel, list) {
						(asArray(list) || []).forEach(function (issue) { issues.push(Object.assign({ channel: channel }, issue)); });
					}
					if (Array.isArray(q.reviewIssues) || Array.isArray(q.chunkIssues) || Array.isArray(q.ruleIssues) || Array.isArray(q.preflightIssues)) {
						pushChannel("preflight", q.preflightIssues);
						pushChannel("规则", q.ruleIssues);
						pushChannel("审校", q.reviewIssues);
						pushChannel("分块", q.chunkIssues);
					} else {
						(Array.isArray(q.issues) ? q.issues : []).forEach(function (issue) {
							var where = String(issue?.where || "");
							issues.push(Object.assign({}, issue, { channel: where.startsWith("chunk-") ? "分块" : "" }));
						});
					}
					return issues;
				}
				function renderQualityIssues(box, q) {
					var issues = qualityIssueList(q);
					if (NET_UI.qualityOpen === undefined) NET_UI.qualityOpen = false;
					var card = el("div", { class: "coc-card" });
					var head = el("div", { class: "coc-row" });
					var toggle = el("button", { type: "button" }, NET_UI.qualityOpen ? "收起" : "展开");
					head.append(el("h4", null, "审校 / 门禁问题（" + issues.length + "）"));
					head.append(toggle);
					card.append(head);
					toggle.addEventListener("click", function () {
						NET_UI.qualityOpen = !NET_UI.qualityOpen;
						renderNetContent(box.closest("[data-panel=net]"), box._dp, box._meta);
					});
					if (!NET_UI.qualityOpen) {
						var brief = issues.filter(function (issue) { return issue.severity === "high"; }).length + " high / " + issues.filter(function (issue) { return issue.severity === "medium"; }).length + " medium / " + issues.filter(function (issue) { return issue.severity === "low"; }).length + " low";
						card.append(el("div", { class: "coc-mini" }, brief + "（点击展开查看详情）"));
						box.append(card);
						return;
					}
					if (issues.length === 0) {
						card.append(el("div", { class: "coc-mini" }, "暂无审校问题。"));
						box.append(card);
						return;
					}
					var filterRow = el("div", { class: "coc-net-toolbar" });
					[["all", "全部"], ["high", "high"], ["medium", "medium"], ["low", "low"]].forEach(function (pair) {
						var btn = el("button", { type: "button" }, pair[1]);
						if (NET_UI.issueSeverity === pair[0]) btn.style.background = "rgba(120,90,30,.5)";
						btn.addEventListener("click", function () { NET_UI.issueSeverity = pair[0]; renderNetContent(box.closest("[data-panel=net]"), box._dp, box._meta); });
						filterRow.append(btn);
					});
					card.append(filterRow);
					var shown = issues.filter(function (issue) {
						return NET_UI.issueSeverity === "all" || issue.severity === NET_UI.issueSeverity;
					});
					if (shown.length === 0) card.append(el("div", { class: "coc-mini" }, "该级别没有问题。"));
					shown.slice(0, 80).forEach(function (issue) {
						var row = el("div", { class: "coc-kp-item" });
						var sev = el("span", { class: "coc-badge" + (issue.severity === "high" ? " ai" : "") }, issue.severity || "medium");
						sev.style.marginRight = "6px";
						row.append(sev);
						if (issue.channel) row.append(el("span", { class: "coc-mini" }, "[" + issue.channel + "] "));
						row.append(document.createTextNode((issue.where || "整体") + "："));
						row.append(el("div", null, esc(issue.problem || "")));
						if (issue.suggestion) row.append(el("div", { class: "coc-mini" }, "→ " + esc(issue.suggestion)));
						card.append(row);
					});
					box.append(card);
				}
				function renderStructureCard(box) {
					var card = el("div", { class: "coc-card" });
					card.append(el("h4", null, "结构层级（scenarioStructure · 可编辑）"));
					var debug = (S.digest && S.digest.debug) || {};
					var structure = debug.structure || null;
					if (structure === null || !Array.isArray(structure.sections)) {
						card.append(el("div", { class: "coc-mini" }, "暂无结构描述。旧数据可重新导入剧本生成，或到「调试 → 导入」重新解析。"));
						return card;
					}
					if (Array.isArray(structure.pdfPages) && structure.pdfPages.length > 0) {
						var pageRow = el("div", { class: "coc-row" });
						pageRow.append(el("span", { class: "coc-mini" }, "PDF 页图："));
						structure.pdfPages.slice(0, 40).forEach(function (page) {
							var link = el("a", { href: "/coc-api/page-image?game=" + encodeURIComponent(gameId()) + "&page=" + page.page, target: "_blank", style: "margin-right:6px" }, "第" + page.page + "页");
							pageRow.append(link);
						});
						card.append(pageRow);
					}
					var ta = el("textarea", { spellcheck: "false", style: "width:100%;min-height:220px;font-family:monospace;font-size:11px" });
					ta.value = JSON.stringify(structure.sections, null, 2);
					var btnRow = el("div", { class: "coc-row" });
					var saveBtn = el("button", { type: "button" }, "保存结构编辑");
					var status = el("span", { class: "coc-mini" }, "");
					saveBtn.addEventListener("click", function () {
						var sections;
						try { sections = JSON.parse(ta.value); } catch (err) { status.textContent = "JSON 解析失败：" + err.message; return; }
						saveBtn.disabled = true; status.textContent = "保存中…";
						post("/coc-api/structure", { sections: sections }).then(function (json) {
							saveBtn.disabled = false;
							if (!json.ok) { status.textContent = "保存失败：" + (json.error || "未知错误"); return; }
							status.textContent = "已保存（" + (json.data && json.data.stats ? json.data.stats.keyPoints + " 个关键点" : "") + "）";
							kpResetAndPoll && kpResetAndPoll();
						});
					});
					btnRow.append(saveBtn, status);
					card.append(ta, btnRow);
					card.append(el("div", { class: "coc-mini" }, "字段：id/title/displayName/kind(chapter|scene|scene_event|facts|module_notes|chapter_notes|rules|appendix|meta)/flowRole(main|side|clue)/parentId/order/page/desc。"));
					return card;
				}
				function renderDpEditorCard(box, dp, meta) {
					var card = el("div", { class: "coc-card" });
					card.append(el("h4", null, "深度剧情解析 · 校对编辑（节点/边/结局/条件 JSON）"));
					var ta = el("textarea", { spellcheck: "false", style: "width:100%;min-height:260px;font-family:monospace;font-size:11px" });
					ta.value = JSON.stringify(dp, null, 2);
					var btnRow = el("div", { class: "coc-row" });
					var saveBtn = el("button", { type: "button" }, "保存草稿");
					var confirmBtn = el("button", { type: "button" }, "确认生效");
					var status = el("span", { class: "coc-mini" }, "");
					saveBtn.addEventListener("click", function () {
						var parsed;
						try { parsed = JSON.parse(ta.value); } catch (err) { status.textContent = "JSON 解析失败：" + err.message; return; }
						saveBtn.disabled = true; status.textContent = "保存中…";
						post("/coc-api/deep-parse", { deepParse: parsed, status: "draft", source: "manual" }).then(function (json) {
							saveBtn.disabled = false;
							if (!json.ok) { status.textContent = "保存失败：" + (json.error || "未知错误"); return; }
							status.textContent = "草稿已保存。";
							kpResetAndPoll && kpResetAndPoll();
						});
					});
					confirmBtn.addEventListener("click", function () {
						confirmBtn.disabled = true; status.textContent = "确认中…";
						post("/coc-api/deep-parse", { action: "confirm" }).then(function (json) {
							confirmBtn.disabled = false;
							if (!json.ok) { status.textContent = "确认失败：" + (json.error || "未知错误"); return; }
							status.textContent = "已确认生效。";
							kpResetAndPoll && kpResetAndPoll();
						});
					});
					btnRow.append(saveBtn, confirmBtn, status);
					card.append(ta, btnRow);
					return card;
				}
				function renderNetPanel() {
					var box = panels.net;
					box.textContent = "";
					box.style.display = "flex";
					box.style.flexDirection = "column";
					box.style.gap = "10px";
					api("/coc-api/deep-parse?game=" + encodeURIComponent(gameId())).then(function (json) {
						if (!json.ok) { box.append(el("div", { class: "coc-empty" }, "加载失败：" + (json.error || "未知错误"))); return; }
						var data = json.data;
						box.append(renderStructureCard(box));
						if (data === null || data.deepParse === null || data.deepParse === undefined) {
							box.append(el("h4", null, "深度剧情解析 · 网络结构"));
							box.append(el("div", { class: "coc-empty" }, "尚无深度剧情解析。导入剧本后可用 LLM 生成草稿，或在「调试 → 导入」粘贴 JSON。"));
							return;
						}
						box.append(renderDpEditorCard(box, data.deepParse, data));
						renderNetContent(box, data.deepParse, data);
					});
				}
				function renderNetContent(box, dp, meta) {
					box.textContent = "";
					box.style.display = "flex";
					box.style.flexDirection = "column";
					box.style.gap = "10px";
					box._dp = dp;
					box._meta = meta;
					box.append(el("h4", null, "深度剧情解析 · 网络结构"));
					var digest = S.digest;
					function digestKeyPoints() { return digest ? (digest.keyPoints || []) : []; }
					function digestBranches() { return digest ? (digest.branches || []) : []; }

					var statusLine = el("div", { class: "coc-row" });
					var statusBadge = el("span", { class: "coc-badge" + (meta.status === "confirmed" ? " ai" : "") }, meta.status === "confirmed" ? "已确认生效" : meta.status === "draft" ? "草稿" : String(meta.status || "none"));
					statusLine.append(statusBadge);
					statusLine.append(el("span", { class: "coc-mini" }, "来源：" + esc(meta.source || "none") + (meta.reviewed ? " · 已校对" : "")));
					box.append(statusLine);

					var q = dp.quality || null;
					if (q !== null) {
						var stats = el("div", { class: "coc-net-stats" });
						function stat(label, h, m) { stats.append(el("span", null, label + " h" + h + "/m" + m)); }
						if (q.preflightHigh !== undefined) stat("preflight", q.preflightHigh, q.preflightMedium);
						if (q.ruleHigh !== undefined) stat("规则", q.ruleHigh, q.ruleMedium);
						if (q.reviewHigh !== undefined) stat("审校", q.reviewHigh, q.reviewMedium);
						if (q.chunkHigh !== undefined) stat("分块", q.chunkHigh, q.chunkMedium);
						box.append(stats);
					}

					var toolbar = el("div", { class: "coc-net-toolbar" });
					var sceneModeBtn = el("button", { type: "button" }, "场景视图");
					var flowModeBtn = el("button", { type: "button" }, "演进视图");
					if (NET_UI.layout === "scene") sceneModeBtn.style.background = "rgba(60,90,160,.45)";
					if (NET_UI.layout === "flow") flowModeBtn.style.background = "rgba(60,90,160,.45)";
					sceneModeBtn.addEventListener("click", function () { NET_UI.layout = "scene"; renderNetContent(box, dp, meta); });
					flowModeBtn.addEventListener("click", function () { NET_UI.layout = "flow"; renderNetContent(box, dp, meta); });
					toolbar.append(sceneModeBtn, flowModeBtn);
					var search = el("input", { type: "text", placeholder: "搜索节点标题/id/场景", spellcheck: "false" });
					search.value = NET_UI.search;
					search.addEventListener("input", function () { NET_UI.search = search.value.trim(); renderNetContent(box, dp, meta); });
					toolbar.append(search);
					var typeSel = el("select");
					[["all", "全部类型"], ["kp", "关键点"], ["br", "分支"], ["end", "结局"]].forEach(function (pair) {
						var opt = el("option", { value: pair[0] }, pair[1]);
						if (NET_UI.type === pair[0]) opt.selected = true;
						typeSel.append(opt);
					});
					typeSel.addEventListener("change", function () { NET_UI.type = typeSel.value; renderNetContent(box, dp, meta); });
					toolbar.append(typeSel);
					var sceneSel = el("select");
					sceneSel.append(el("option", { value: "all" }, "全部场景"));
					var scenes = [];
					function pushScene(value) { if (value && scenes.indexOf(value) < 0) scenes.push(value); }
					digestKeyPoints().forEach(function (kp) { pushScene(kp.scene); });
					(dp.keyPoints || []).forEach(function (kp) { pushScene(kp.scene); });
					(dp.branches || []).forEach(function (b) { pushScene(b.scene); });
					scenes.forEach(function (scene) {
						var opt = el("option", { value: scene }, scene);
						if (NET_UI.scene === scene) opt.selected = true;
						sceneSel.append(opt);
					});
					sceneSel.addEventListener("change", function () { NET_UI.scene = sceneSel.value; renderNetContent(box, dp, meta); });
					toolbar.append(sceneSel);
					if (NET_UI.layout !== "flow") {
						var foldLabel = el("label", null, "");
						var foldInput = el("input", { type: "checkbox" });
						foldInput.checked = NET_UI.foldChecks;
						foldInput.addEventListener("change", function () { NET_UI.foldChecks = foldInput.checked; renderNetContent(box, dp, meta); });
						foldLabel.append(foldInput, document.createTextNode("折叠检定分支"));
						toolbar.append(foldLabel);
						var focusBtn = el("button", { type: "button" }, NET_UI.focus === "final" ? "查看全图" : "聚焦最终结局");
						focusBtn.addEventListener("click", function () { NET_UI.focus = NET_UI.focus === "final" ? null : "final"; renderNetContent(box, dp, meta); });
						toolbar.append(focusBtn);
					} else {
						toolbar.append(el("span", { class: "coc-mini" }, "检定分支已折叠为琥珀虚线边"));
					}
					box.append(toolbar);

					var nodeById = new Map();
					function addNode(type, id, title, extra) {
						if (!id) return;
						var key = netNodeId(type, id);
						if (nodeById.has(key)) return;
						nodeById.set(key, Object.assign({ type: type, id: id, title: title || id, scene: "", options: [], desc: "" }, extra || {}));
					}
					digestKeyPoints().forEach(function (kp) { addNode("kp", kp.id, kp.title, { scene: kp.scene, desc: kp.desc, revealed: kp.revealed === true, virtual: kp.virtual === true, reachability: kp.reachability }); });
					(dp.keyPoints || []).forEach(function (kp) { addNode("kp", kp.id, kp.title, { scene: kp.scene, desc: kp.desc, revealed: false, virtual: kp.virtual === true, reachability: kp.reachability }); });
					digestBranches().forEach(function (b) { addNode("br", b.id, b.title, { scene: b.scene, desc: b.desc, options: b.options || [], reached: b.reached === true, checkpointBranch: b.checkpointBranch === true, autoChoose: b.autoChoose === true }); });
					(dp.branches || []).forEach(function (b) { addNode("br", b.id, b.title, { scene: b.scene, desc: b.desc, options: b.options || [], reached: false, checkpointBranch: b.checkpointBranch === true, finalChoice: b.finalChoice === true, autoChoose: b.autoChoose === true }); });
					(dp.endings || []).forEach(function (e) { addNode("end", e.id, e.title, { scene: e.scene || "", branchId: e.branchId, optionLabel: e.optionLabel, mutexGroup: e.mutexGroup, requires: e.requires, blockers: e.blockers, endingKeywords: e.endingKeywords }); });

					var edgeList = [];
					var edgeKeys = new Set();
					function addEdge(kind, from, to, label, requires, fallback) {
						if (from === null || to === null || from === to) return false;
						var key = kind + "|" + netNodeId(from.type, from.id) + "|" + netNodeId(to.type, to.id) + "|" + (label || "");
						if (edgeKeys.has(key)) return false;
						edgeKeys.add(key);
						edgeList.push({ from: from, to: to, label: label || "", requires: requires || [], kind: kind, fallback: fallback === true });
						return true;
					}
					(dp.plotEdges || []).forEach(function (edge) {
						addEdge("edge", netResolveNode(nodeById, edge.from), netResolveNode(nodeById, edge.to), edge.label || "", edge.requires || [], edge.fallback === true);
					});
					digestBranches().concat(dp.branches || []).forEach(function (branch) {
						(branch.options || []).forEach(function (option) {
							if (!option.leadsTo) return;
							var from = netResolveNode(nodeById, "br:" + branch.id);
							var to = netResolveNode(nodeById, option.leadsTo);
							if (from === null || to === null || from === to) return;
							// 已有同起终点的剧情边时，不再重复画选项指向边
							if (edgeList.some(function (e) { return e.kind === "edge" && e.from === from && e.to === to; })) return;
							addEdge("leads", from, to, option.label || "", []);
						});
					});

					var flowMode = NET_UI.layout === "flow";
					var visible = [];
					var foldedCount = 0;
					if (!flowMode) {
						nodeById.forEach(function (node) {
							if (NET_UI.type !== "all" && node.type !== NET_UI.type) return;
							if (NET_UI.scene !== "all" && String(node.scene || "") !== NET_UI.scene) return;
							if (NET_UI.search) {
								var hay = (node.title || "") + " " + (node.id || "") + " " + (node.scene || "");
								if (hay.toLowerCase().indexOf(NET_UI.search.toLowerCase()) < 0) return;
							}
							if (NET_UI.foldChecks && node.type === "br" && node.checkpointBranch === true) { foldedCount += 1; return; }
							if (NET_UI.focus === "final") {
								var isFinal = node.type === "end" || (node.type === "br" && (node.finalChoice === true || node.autoChoose === true || String(node.id).indexOf("br-final") === 0));
								if (!isFinal) return;
							}
							visible.push(node);
						});
					}
					var visibleById = new Map(visible.map(function (node) { return [netNodeId(node.type, node.id), node]; }));
					var visEdges = edgeList.filter(function (edge) {
						return visibleById.has(netNodeId(edge.from.type, edge.from.id)) && visibleById.has(netNodeId(edge.to.type, edge.to.id));
					});

					// 布局：场景视图（聚焦结局 / 场景条带）与演进视图（拓扑分层）二选一。
					var sceneNodeMap = new Map();
					var sceneOrder = [];
					var BAND_TITLE_H = 18;
					var NODE_SLOT_W = 112;
					var NODE_SLOT_H = 50;
					var MAX_PER_ROW = 5;
					var bandY = {};
					var yCursor = 14;
					var svgWidth = 720;
					var svgHeight = 240;
					if (flowMode) {
						var flow = buildEvolutionView(nodeById, edgeList, NET_UI);
						visible = flow.visible;
						visEdges = flow.visEdges;
						foldedCount = flow.foldedCount;
						svgWidth = flow.svgWidth;
						svgHeight = flow.svgHeight;
						if (flow.isolated.length > 0) {
							sceneNodeMap.set("未连线场景点", flow.isolated);
							sceneOrder.push("未连线场景点");
							bandY["未连线场景点"] = flow.isolatedY;
						}
					} else if (NET_UI.focus === "final") {
						// 聚焦最终结局：最终分支排左列，结局排右列，保证每条入边清晰可见。
						var focusBrs = visible.filter(function (node) { return node.type === "br"; });
						var focusEnds = visible.filter(function (node) { return node.type === "end"; });
						var focusOthers = visible.filter(function (node) { return node.type !== "br" && node.type !== "end"; });
						focusBrs.forEach(function (node, index) { node._x = 70; node._y = 70 + index * 96; });
						focusEnds.forEach(function (node, index) {
							var column = Math.floor(index / 3);
							var row = index % 3;
							node._x = 320 + column * 210;
							node._y = 44 + row * 72;
						});
						focusOthers.forEach(function (node, index) { node._x = 320; node._y = 44 + (Math.ceil(focusEnds.length / 3) + index) * 72; });
						sceneNodeMap.set("终幕与结局", visible.slice());
						sceneOrder = Array.from(sceneNodeMap.keys());
						bandY["终幕与结局"] = yCursor;
						var maxFocusY = 0;
						visible.forEach(function (node) { if (node._y > maxFocusY) maxFocusY = node._y; });
						yCursor = maxFocusY + 40;
						svgWidth = 720;
						svgHeight = Math.max(200, yCursor + 50);
					} else {
						// 场景条带：同场景节点横向排布、超宽换行；条带纵向堆叠。
						visible.forEach(function (node) {
							var scene = node.scene || "";
							if (!sceneNodeMap.has(scene)) sceneNodeMap.set(scene, []);
							sceneNodeMap.get(scene).push(node);
						});
						sceneOrder = Array.from(sceneNodeMap.keys());
						sceneOrder.forEach(function (scene) {
							var nodes = sceneNodeMap.get(scene) || [];
							var rows = Math.max(1, Math.ceil(nodes.length / MAX_PER_ROW));
							bandY[scene] = yCursor;
							nodes.forEach(function (node, index) {
								var row = Math.floor(index / MAX_PER_ROW);
								var col = index % MAX_PER_ROW;
								node._x = 64 + col * NODE_SLOT_W;
								node._y = yCursor + BAND_TITLE_H + 12 + row * NODE_SLOT_H;
							});
							yCursor += BAND_TITLE_H + rows * NODE_SLOT_H + 16;
						});
						svgWidth = 720;
						svgHeight = Math.max(240, yCursor + 120);
					}
					var labelCounts = new Map();
					visible.forEach(function (node) {
						var text = nodeDisplayTitle(node);
						var key = String(node.scene || "") + "|" + text;
						labelCounts.set(key, (labelCounts.get(key) || 0) + 1);
					});

					var graphCard = el("div", { class: "coc-card" });
					graphCard.append(el("h4", null, (flowMode ? "演进拓扑" : "网络拓扑") + (foldedCount > 0 ? "（已折叠 " + foldedCount + " 个检定分支）" : "") + " · " + visible.length + " 节点 / " + visEdges.length + " 边"));
					var legend = el("div", { class: "coc-net-legend" });
					legend.append(el("span", { style: "color:#5d8ae0" }, "● 关键点"));
					legend.append(el("span", { style: "color:#e6b45c" }, "◆ 分支"));
					legend.append(el("span", { style: "color:#9fb0d8" }, "⬡ 自动判定"));
					legend.append(el("span", { style: "color:#b08ff0" }, "★ 结局"));
					legend.append(el("span", { style: "color:#7d9bd8" }, "◌ 虚拟枢纽/返回点"));
					if (flowMode) {
						legend.append(el("span", null, "实线=剧情边；虚线=选项指向"));
						legend.append(el("span", { style: "border-bottom:2px dashed rgba(255,205,130,.7);padding-bottom:1px" }, "琥珀虚线=检定边（已折叠）"));
						legend.append(el("span", { style: "border-bottom:2px dotted rgba(125,155,215,.8);padding-bottom:1px" }, "淡色点线=兜底边"));
						legend.append(el("span", { style: "color:#ffd98a" }, "●×n=本场景检定数"));
					} else {
						var edgeSample = el("span", { style: "border-bottom:2px solid rgba(255,205,130,.8);padding-bottom:1px" }, "琥珀边=带条件");
						legend.append(el("span", null, "实线=剧情边；虚线=选项指向"), edgeSample);
						legend.append(el("span", { style: "border-bottom:2px dotted rgba(125,155,215,.8);padding-bottom:1px" }, "淡色点线=确定性兜底边"));
					}
					graphCard.append(legend);

					var zoomRow = el("div", { class: "coc-net-zoomrow" });
					var zoomInBtn = el("button", { type: "button" }, "放大 +");
					var zoomOutBtn = el("button", { type: "button" }, "缩小 −");
					var zoomResetBtn = el("button", { type: "button" }, "重置缩放");
					var zoomHint = el("span", { class: "coc-net-zoom-hint" }, "滚轮缩放 · 拖拽平移");
					zoomRow.append(zoomInBtn, zoomOutBtn, zoomResetBtn, zoomHint);
					graphCard.append(zoomRow);

					var viewport = el("div", { class: "coc-net-viewport" });
					var svg = svgEl("svg", { class: "coc-net-svg", viewBox: "0 0 " + svgWidth + " " + svgHeight, width: String(svgWidth), height: String(svgHeight) });
					svg.style.width = svgWidth + "px";
					svg.style.height = svgHeight + "px";
					var world = svgEl("g", { class: "coc-net-world" });
					svg.append(world);
					var defs = svgEl("defs");
					var marker = svgEl("marker", { id: "coc-net-arrow", markerWidth: "8", markerHeight: "8", refX: "7", refY: "4", orient: "auto", markerUnits: "strokeWidth" });
					marker.append(svgEl("path", { d: "M0,0 L8,4 L0,8 z", fill: "#8fa4d4" }));
					defs.append(marker);
					svg.append(defs);
					viewport.append(svg);
					graphCard.append(viewport);

					var netView = { zoom: 1, panX: 0, panY: 0 };
					function applyNetTransform() {
						world.setAttribute("transform", "translate(" + netView.panX + " " + netView.panY + ") scale(" + netView.zoom + ")");
					}
					function netZoomAt(cx, cy, factor) {
						var oldZoom = netView.zoom;
						var nextZoom = Math.min(4, Math.max(0.15, oldZoom * factor));
						factor = nextZoom / oldZoom;
						netView.panX = cx - (cx - netView.panX) * factor;
						netView.panY = cy - (cy - netView.panY) * factor;
						netView.zoom = nextZoom;
						applyNetTransform();
					}
					zoomInBtn.addEventListener("click", function () {
						var rect = viewport.getBoundingClientRect();
						netZoomAt(rect.width / 2, rect.height / 2, 1.25);
					});
					zoomOutBtn.addEventListener("click", function () {
						var rect = viewport.getBoundingClientRect();
						netZoomAt(rect.width / 2, rect.height / 2, 1 / 1.25);
					});
					zoomResetBtn.addEventListener("click", function () {
						netView.zoom = 1;
						netView.panX = 0;
						netView.panY = 0;
						applyNetTransform();
					});
					viewport.addEventListener("wheel", function (ev) {
						ev.preventDefault();
						var rect = viewport.getBoundingClientRect();
						netZoomAt(ev.clientX - rect.left, ev.clientY - rect.top, Math.exp(-ev.deltaY * 0.0015));
					}, { passive: false });
					var panState = null;
					viewport.addEventListener("pointerdown", function (ev) {
						if (ev.button !== 0) return;
						var target = ev.target;
						if (target && target.closest && (target.closest(".node") || target.closest(".edge") || target.closest(".edge-label"))) return;
						panState = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, panX: netView.panX, panY: netView.panY };
						viewport.classList.add("panning");
						try { viewport.setPointerCapture(ev.pointerId); } catch (_err) {}
					});
					viewport.addEventListener("pointermove", function (ev) {
						if (panState === null || ev.pointerId !== panState.id) return;
						netView.panX = panState.panX + (ev.clientX - panState.x);
						netView.panY = panState.panY + (ev.clientY - panState.y);
						applyNetTransform();
					});
					function endNetPan(ev) {
						if (panState === null || ev.pointerId !== panState.id) return;
						panState = null;
						viewport.classList.remove("panning");
					}
					viewport.addEventListener("pointerup", endNetPan);
					viewport.addEventListener("pointercancel", endNetPan);
					applyNetTransform();

					// 场景条带标题与分隔线（条带名与带内节点标题相同时跳过，避免上下重复）
					sceneOrder.forEach(function (scene) {
						if (!scene) return;
						var bandTop = bandY[scene];
						var bandNodes = sceneNodeMap.get(scene) || [];
						var duplicateTitle = bandNodes.some(function (node) { return String(node.title || "") === scene; });
						if (!duplicateTitle) {
							var bandText = svgEl("text", { x: "12", y: String(bandTop + BAND_TITLE_H - 7), class: "coc-net-band-title" });
							bandText.textContent = scene;
							world.append(bandText);
						}
						var line = svgEl("line", { x1: "8", y1: String(bandTop + BAND_TITLE_H - 2), x2: String(svgWidth - 8), y2: String(bandTop + BAND_TITLE_H - 2) });
						line.setAttribute("stroke", "rgba(130,165,230,.3)");
						line.setAttribute("stroke-width", "1.2");
						line.setAttribute("stroke-dasharray", "3 4");
						world.append(line);
					});

					var showEdgeLabels = flowMode ? visEdges.length <= 120 : (NET_UI.focus === "final" || visEdges.length <= 24);
					visEdges.forEach(function (edge) {
						var x1 = edge.from._x + 18;
						var y1 = edge.from._y;
						var x2 = edge.to._x - 18;
						var y2 = edge.to._y;
						var classes = "edge" + (Array.isArray(edge.requires) && edge.requires.length > 0 ? " has-req" : "") + (edge.fallback === true ? " fallback" : "");
						var path = svgEl("path", { class: classes, d: "M " + x1 + " " + y1 + " C " + (x1 + (x2 - x1) * 0.5) + " " + y1 + ", " + (x1 + (x2 - x1) * 0.5) + " " + y2 + ", " + x2 + " " + y2, "marker-end": "url(#coc-net-arrow)" });
						path.setAttribute("data-kind", edge.kind || "");
						path.setAttribute("data-from", netNodeId(edge.from.type, edge.from.id));
						path.setAttribute("data-to", netNodeId(edge.to.type, edge.to.id));
						if (edge.kind === "leads") path.style.strokeDasharray = "5 4";
						if (edge.kind === "check") { path.style.strokeDasharray = "3 3"; path.style.stroke = "rgba(255,205,130,.6)"; }
						path.addEventListener("click", function () { renderNetEdgeDetail(graphCard, edge, nodeById); });
						var pathTitle = svgEl("title");
						pathTitle.textContent = (edge.from.title || edge.from.id) + " → " + (edge.to.title || edge.to.id) + (edge.label ? " · " + edge.label : "");
						path.append(pathTitle);
						world.append(path);
						var labelThisEdge = showEdgeLabels && edge.label && (!flowMode || edge.kind === "check" || visEdges.length <= 6);
						if (labelThisEdge) {
							var targetTitle = String(edge.to.title || "");
							var sourceTitle = String(edge.from.title || "");
							if (edge.label !== targetTitle && edge.label !== sourceTitle) {
								var label = svgEl("text", { class: "edge-label", x: String((x1 + x2) / 2), y: String((y1 + y2) / 2 - 6), "text-anchor": "middle" });
								label.textContent = edge.label;
								world.append(label);
							}
						}
					});

					visible.forEach(function (node) {
						var group = svgEl("g", { class: "node" + (node.virtual === true ? " virtual" : ""), transform: "translate(" + node._x + "," + node._y + ")" });
						var shape;
						if (node.type === "kp") {
							shape = svgEl("circle", { r: "14", fill: "#2b4a9f", stroke: node.revealed ? "#9fe0c0" : "#8fb0f0" });
						} else if (node.type === "br") {
							var isFinal = node.finalChoice === true || String(node.id).indexOf("br-final") === 0;
							if (node.autoChoose === true) {
								// 自动判定分支：非玩家选项，用六边形 + 灰蓝配色区分。
								shape = svgEl("polygon", { points: "0,-14 12,-7 12,7 0,14 -12,7 -12,-7", fill: "#3d4b6e", stroke: "#9fb0d8", "stroke-dasharray": "3 2" });
							} else {
								shape = svgEl("rect", { x: "-12", y: "-12", width: "24", height: "24", rx: "4", transform: "rotate(45)", fill: isFinal ? "#8a5a20" : "#3c3f7a", stroke: node.reached ? "#9fe0c0" : "#e6b45c" });
							}
						} else {
							shape = svgEl("polygon", { points: "0,-16 6,-5 16,-5 8,4 11,15 0,9 -11,15 -8,4 -16,-5 -6,-5", fill: "#6a4a9f", stroke: "#d8b0ff" });
						}
						group.append(shape);
						var labelText = nodeDisplayTitle(node);
						var labelKey = String(node.scene || "") + "|" + labelText;
						var duplicate = (labelCounts.get(labelKey) || 0) > 1;
						var labelLines = duplicate
							? [wrapLabel(labelText, node.id, 7, 1)[0], "#" + String(node.id).replace(/^br-/, "")]
							: wrapLabel(labelText, node.id, node.type === "kp" ? 10 : 7, 2);
						var label = svgEl("text", { y: "27", "text-anchor": "middle", class: "node-label" });
						labelLines.forEach(function (line, lineIndex) {
							var tspan = svgEl("tspan", { x: "0", dy: lineIndex === 0 ? "0" : "12" });
							tspan.textContent = line;
							label.append(tspan);
						});
						group.append(label);
						if (Array.isArray(node._checkLabels) && node._checkLabels.length > 0) {
							var badge = svgEl("circle", { r: "10", cx: "16", cy: "-16", fill: "#8a6a20", stroke: "#ffd98a" });
							badge.setAttribute("class", "check-badge");
							group.append(badge);
							var badgeText = svgEl("text", { x: "16", y: "-13", "text-anchor": "middle", class: "check-badge-text" });
							badgeText.textContent = "×" + node._checkLabels.length;
							group.append(badgeText);
						}
						if (node.autoChoose === true) {
							var autoBadge = svgEl("circle", { r: "10", cx: "16", cy: "-16", fill: "#4a5568", stroke: "#9fb0d8" });
							group.append(autoBadge);
							var autoBadgeText = svgEl("text", { x: "16", y: "-13", "text-anchor": "middle", class: "check-badge-text" });
							autoBadgeText.textContent = "自";
							group.append(autoBadgeText);
						}
						var title = svgEl("title");
						title.textContent = node.type.toUpperCase() + " " + node.id + " · " + node.title + (node.scene ? " @" + node.scene : "") + (Array.isArray(node._checkLabels) && node._checkLabels.length > 0 ? " · 本场景检定：" + node._checkLabels.join(" / ") : "");
						group.append(title);
						group.addEventListener("click", function () { renderNetNodeDetail(graphCard, node, nodeById, edgeList, dp); });
						world.append(group);
					});

					box.append(graphCard);

					var firstEnding = (dp.endings || [])[0];
					if (firstEnding) {
						var firstNode = netResolveNode(nodeById, "end:" + firstEnding.id);
						if (firstNode !== null) renderNetNodeDetail(graphCard, firstNode, nodeById, edgeList, dp);
					}
					if (q !== null) renderQualityIssues(box, q);
				}
				function renderNetNodeDetail(container, node, nodeById, edgeList, dp) {
					NET_UI.selected = netNodeId(node.type, node.id);
					var old = container.querySelector(".coc-net-detail");
					if (old !== null) old.remove();
					var detail = el("div", { class: "coc-net-detail" });
					detail.append(el("h4", null, "节点详情 · " + node.type.toUpperCase() + " " + String(node.id) + " · " + esc(node.title)));
					var typeRow = el("div", { class: "coc-kv" });
					typeRow.append(el("b", null, "类型"), document.createTextNode(node.type === "kp" ? "关键剧情点" : node.type === "br" ? "剧情分支" : "结局"));
					detail.append(typeRow);
					if (node.autoChoose === true) {
						var autoRow = el("div", { class: "coc-kv" });
						autoRow.append(el("b", null, "模式"), document.createTextNode("自动判定（非玩家选项，由条件触发）"));
						detail.append(autoRow);
					}
					if (node.scene) {
						var sceneRow = el("div", { class: "coc-kv" });
						sceneRow.append(el("b", null, "场景"), document.createTextNode(esc(node.scene)));
						detail.append(sceneRow);
					}
					if (node.desc) {
						var descRow = el("div", { class: "coc-kv" });
						descRow.append(el("b", null, "描述"), document.createTextNode(esc(node.desc)));
						detail.append(descRow);
					}
					if (node.type === "br" && Array.isArray(node.options) && node.options.length > 0) {
						var optBox = el("div", { class: "coc-kv" });
						optBox.append(el("b", null, "选项"));
						node.options.forEach(function (option) {
							optBox.append(el("div", { class: "coc-cond routing" }, esc(option.label) + (option.leadsTo ? " → " + esc(option.leadsTo) : "")));
						});
						detail.append(optBox);
					}
					// 关键点/分支的挂载条件（keyPointConditions / branchConditions）
					var condEntries = [];
					if (dp !== undefined && dp !== null) {
						if (node.type === "kp") {
							condEntries = (dp.keyPointConditions || []).filter(function (entry) { return String(entry?.keyPointId) === String(node.id); });
						} else if (node.type === "br") {
							condEntries = (dp.branchConditions || []).filter(function (entry) { return String(entry?.branchId) === String(node.id); });
						}
					}
					condEntries.forEach(function (entry, index) {
						var condRow = el("div", { class: "coc-kv" });
						condRow.append(el("b", null, "挂载条件" + (condEntries.length > 1 ? " #" + (index + 1) : "")));
						if (entry.requires !== undefined && entry.requires !== null) {
							condRow.append(el("div", { class: "coc-mini" }, "要求："));
							fmtCondChips(condRow, entry.requires, nodeById);
						}
						if (Array.isArray(entry.requiresAnyOf) && entry.requiresAnyOf.length > 0) {
							condRow.append(el("div", { class: "coc-mini" }, "任一满足："));
							entry.requiresAnyOf.forEach(function (group, groupIndex) {
								condRow.append(el("span", { class: "coc-mini" }, "▸"));
								fmtCondChips(condRow, group, nodeById);
							});
						}
						if (entry.autoChooseLabel) {
							condRow.append(el("div", { class: "coc-cond routing" }, "自动选择：" + esc(entry.autoChooseLabel)));
						}
						detail.append(condRow);
					});
					if (node.type === "end") {
						var endBox = el("div", { class: "coc-endcard" });
						endBox.append(el("h4", null, esc(node.title)));
						if (node.optionLabel) {
							var optRow = el("div", { class: "coc-kv" });
							optRow.append(el("b", null, "选项"), document.createTextNode(esc(node.optionLabel)));
							endBox.append(optRow);
						}
						if (node.mutexGroup) {
							var mutRow = el("div", { class: "coc-kv" });
							mutRow.append(el("b", null, "互斥组"), document.createTextNode(esc(node.mutexGroup)));
							endBox.append(mutRow);
						}
						if (node.requires) {
							var reqRow = el("div", { class: "coc-kv" });
							reqRow.append(el("b", null, "前置条件"));
							fmtCondChips(endBox, node.requires, nodeById);
							endBox.append(reqRow);
						}
						if (Array.isArray(node.blockers) && node.blockers.length > 0) {
							var blockRow = el("div", { class: "coc-kv" });
							blockRow.append(el("b", null, "阻断条件"));
							node.blockers.forEach(function (blocker) { fmtCondChips(endBox, blocker, nodeById); });
							endBox.append(blockRow);
						}
						if (Array.isArray(node.endingKeywords) && node.endingKeywords.length > 0) {
							var keyRow = el("div", { class: "coc-kv" });
							keyRow.append(el("b", null, "关键词"), document.createTextNode(node.endingKeywords.join(" / ")));
							endBox.append(keyRow);
						}
						detail.append(endBox);
					}
					var inEdges = edgeList.filter(function (e) { return e.to === node; });
					var outEdges = edgeList.filter(function (e) { return e.from === node; });
					var edgeBox = el("div", { class: "coc-kv" });
					edgeBox.append(el("b", null, "相关边"));
					if (inEdges.length === 0 && outEdges.length === 0) edgeBox.append(el("div", { class: "coc-mini" }, "无"));
					inEdges.forEach(function (e) {
						var row = el("div", { class: "coc-cond" }, "← " + esc(e.from.title || e.from.id) + (e.label ? "（" + esc(e.label) + "）" : "") + (Array.isArray(e.requires) && e.requires.length > 0 ? " ⚠" : ""));
						edgeBox.append(row);
					});
					outEdges.forEach(function (e) {
						var row = el("div", { class: "coc-cond" }, "→ " + esc(e.to.title || e.to.id) + (e.label ? "（" + esc(e.label) + "）" : "") + (Array.isArray(e.requires) && e.requires.length > 0 ? " ⚠" : ""));
						edgeBox.append(row);
						if (Array.isArray(e.requires) && e.requires.length > 0) {
							var reqBox = el("div", { class: "coc-kv", style: "padding-left:12px" });
							e.requires.forEach(function (req) { fmtCondChips(reqBox, req, nodeById); });
							edgeBox.append(reqBox);
						}
					});
					detail.append(edgeBox);
					container.append(detail);
				}
				function renderNetEdgeDetail(container, edge, nodeById) {
					var old = container.querySelector(".coc-net-detail");
					if (old !== null) old.remove();
					var detail = el("div", { class: "coc-net-detail" });
					detail.append(el("h4", null, "边详情 · " + esc(edge.from.title || edge.from.id) + " → " + esc(edge.to.title || edge.to.id)));
					if (edge.label) {
						var labelRow = el("div", { class: "coc-kv" });
						labelRow.append(el("b", null, "触发文本"), document.createTextNode(esc(edge.label)));
						detail.append(labelRow);
					}
					var condRow = el("div", { class: "coc-kv" });
					condRow.append(el("b", null, "条件"));
					if (Array.isArray(edge.requires) && edge.requires.length > 0) {
						var condBox = el("div");
						edge.requires.forEach(function (req) { fmtCondChips(condBox, req, nodeById); });
						detail.append(condBox);
					} else {
						detail.append(el("span", { class: "coc-mini" }, "无条件"));
					}
					container.append(detail);
				}
				// ── 人物页 ──
				function renderCharsPanel() {
					var box = panels.chars;
					box.textContent = "";
					if (S.digest === null) { box.append(el("div", { class: "coc-empty" }, "尚无游戏数据。")); return; }
					var d = S.digest;
					if (!Array.isArray(d.characters) || d.characters.length === 0) {
						box.append(el("div", { class: "coc-empty" }, "还没有调查员：到「导入」页导入人物卡，或新建场次时选择调查员。"));
						return;
					}
					d.characters.forEach(function (pc) {
						var card = el("div", { class: "coc-card" });
						var head = el("div", { class: "coc-row" });
						head.append(el("b", null, "◆ " + esc(pc.name)));
						if (pc.occupation) head.append(el("span", { class: "coc-mini" }, esc(pc.occupation)));
						card.append(head);
						card.append(el("div", { class: "coc-kv" }, ""));
						["hp", "san", "mp", "luck"].forEach(function (key) {
							var row = el("div", { class: "coc-row" });
							row.append(el("span", { style: "width:46px;color:#8fa4d4" }, key.toUpperCase()));
							var val = el("input", { type: "number", value: pc[key] ?? 0, style: "width:80px" });
							var saveBtn = el("button", { type: "button", style: "padding:2px 8px;font-size:11px" }, "更新");
							saveBtn.addEventListener("click", function () {
								var patch = { name: pc.name };
								patch[key] = Number(val.value) || 0;
								tool("coc_pc", patch).then(function () { poll(true); });
							});
							row.append(val, saveBtn);
							card.append(row);
						});
						if (Array.isArray(pc.inventory) && pc.inventory.length > 0) {
							card.append(el("div", { class: "coc-kv" }, "物品：" + pc.inventory.join("、")));
						}
						if (pc.stats && Object.keys(pc.stats).length > 0) {
							var statsLine = Object.keys(pc.stats).map(function (k) { return k + " " + pc.stats[k]; }).join("｜");
							card.append(el("div", { class: "coc-kv", style: "font-size:11px;color:#9fb2dd" }, statsLine));
						}
						box.append(card);
					});
				}
				// ── 卡库页（全局资产库：与场次独立） ──
				function renderAssetsPanel() {
					var box = panels.assets;
					box.textContent = "";
					var sections = [
						["scenarios", "剧本资产", "📖"],
						["investigators", "调查员卡（通用）", "🕵"],
						["entities", "实体资产", "👤"]
					];
					var loaded = 0;
					sections.forEach(function (section) {
						var kind = section[0];
						var card = el("div", { class: "coc-card" });
						card.append(el("h4", null, section[2] + " " + section[1]));
						var listBox = el("div", { class: "coc-wiz-pc-list" });
						listBox.style.maxHeight = "220px";
						card.append(listBox);
						box.append(card);
						post("/coc-api/assets", { kind: kind, action: "list" }).then(function (json) {
							loaded++;
							listBox.textContent = "";
							var items = json.ok ? (json.data || []) : [];
							if (items.length === 0) listBox.append(el("div", { class: "coc-mini" }, "暂无资产"));
							items.forEach(function (asset) {
								var row = el("div", { class: "coc-row", style: "align-items:center;gap:6px" });
								var info = el("span", { style: "flex:1" });
								var name = asset.name || "（未命名）";
								if (kind === "scenarios") info.textContent = "📖 " + name + (asset.recommendedPlayers ? "（" + asset.recommendedPlayers + "）" : "");
								else if (kind === "investigators") info.textContent = "🕵 " + name + (asset.occupation ? "｜" + asset.occupation : "") + (asset.aiControlled ? "｜🤖 AI" : "");
								else info.textContent = "👤 " + name + (asset.type ? "｜" + asset.type : "");
								row.append(info);
								var useBtn = el("button", { type: "button", style: "padding:2px 8px;font-size:11px" }, kind === "scenarios" ? "开新场次" : "加入场次");
								useBtn.addEventListener("click", function () {
									if (kind === "scenarios") {
										openGameWizard(asset.id);
									} else {
										post("/coc-api/assets", { kind: kind, action: "instantiate", assetId: asset.id, game: gameId() }).then(function (json) {
											alert(json.ok ? "已加入当前场次：" + (json.data && json.data.name ? json.data.name : assetId) : "失败：" + (json.error || "未知错误"));
											poll(true);
										});
									}
								});
								row.append(useBtn);
								var delBtn = el("button", { type: "button", style: "padding:2px 8px;font-size:11px;background:#b71c1c;color:#fff" }, "删");
								delBtn.addEventListener("click", function () {
									if (!confirm("确定删除资产「" + name + "」？" + (kind === "scenarios" ? "引用它的场次会一并删除！" : ""))) return;
									post("/coc-api/assets", { kind: kind, action: "delete", assetId: asset.id }).then(function (json) {
										alert(json.ok ? "已删除" : "失败：" + (json.error || "未知错误"));
										refreshGames();
										renderAssetsPanel();
									});
								});
								row.append(delBtn);
								listBox.append(row);
							});
						});
					});
				}
				function renderEntsPanel() {
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
							if (e.revealed === true) head.append(el("span", { class: "coc-mini", style: "margin-left:4px;color:#ffd54f" }, "[已揭示]"));
							item.append(head);
							if (e.desc) item.append(el("div", { class: "coc-mini" }, esc(e.desc)));
							if (e.revealed === true) item.append(el("div", { class: "coc-mini", style: "color:#ffd54f" }, "玩家可见：" + esc(e.playerDesc || "（未填写）") + (e.playerState ? "　［状态：" + esc(e.playerState) + "］" : "")));
							var stateInput = el("input", { type: "text", value: e.state || "", placeholder: "当前状态", spellcheck: "false" });
							var saveState = el("button", { type: "button", style: "padding:2px 8px;font-size:11px" }, "存状态");
							saveState.addEventListener("click", function () {
								tool("coc_entity", { action: "update", entityId: e.id, entity: { state: stateInput.value } }).then(function () { poll(true); });
							});
							var askPlayerFacing = function () {
								var pd = prompt("玩家可见描述（留空则玩家只看到名字，绝不显示 KP 底牌）：", e.playerDesc || "");
								if (pd === null) return null;
								var ps = prompt("玩家可见状态（如：友善 / 敌意 / 已死亡 / 未知，可留空）：", e.playerState || "");
								if (ps === null) ps = e.playerState || "";
								return { playerDesc: pd, playerState: ps };
							};
							var revealBtn = el("button", { type: "button", style: "padding:2px 8px;font-size:11px" }, e.revealed === true ? "隐藏" : "揭示");
							revealBtn.addEventListener("click", function () {
								if (e.revealed === true) {
									tool("coc_entity", { action: "update", entityId: e.id, entity: { revealed: false } }).then(function () { poll(true); });
									return;
								}
								var facing = askPlayerFacing();
								if (facing === null) return;
								tool("coc_entity", { action: "reveal", entityId: e.id, playerDesc: facing.playerDesc, playerState: facing.playerState }).then(function () { poll(true); });
							});
							var editPlayerBtn = null;
							if (e.revealed === true) {
								editPlayerBtn = el("button", { type: "button", style: "padding:2px 8px;font-size:11px" }, "改认知");
								editPlayerBtn.addEventListener("click", function () {
									var facing = askPlayerFacing();
									if (facing === null) return;
									tool("coc_entity", { action: "update", entityId: e.id, entity: { playerDesc: facing.playerDesc, playerState: facing.playerState } }).then(function () { poll(true); });
								});
							}
							var del = el("button", { type: "button", style: "padding:2px 8px;font-size:11px;background:rgba(180,70,70,.3)" }, "删");
							del.addEventListener("click", function () {
								tool("coc_entity", { action: "remove", entityId: e.id }).then(function () { poll(true); });
							});
							var toAsset = el("button", { type: "button", style: "padding:2px 8px;font-size:11px" }, "加入资产库");
							toAsset.addEventListener("click", function () {
								post("/coc-api/assets", { kind: "entities", action: "add-from-game", entityId: e.id, game: gameId() }).then(function (json) {
									if (json.ok) { toAsset.textContent = "✓ 已加入"; toAsset.disabled = true; }
									else alert("加入失败：" + (json.error || "未知错误"));
								});
							});
							var row = el("div", { class: "coc-row" });
							row.append(stateInput, saveState, revealBtn);
							if (editPlayerBtn !== null) row.append(editPlayerBtn);
							row.append(toAsset, del);
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
				function restoreImportView(resultBox) {
					var view = S.importView;
					if (view === null || view === undefined) return;
					resultBox.classList.remove("err");
					resultBox.style.display = "block";
					resultBox.textContent = "";
					if (view.kind === "progress") {
						var progressBar = el("div", { class: "coc-progress-bar", style: "width:100%;height:6px;background:#eee;border-radius:3px;margin:8px 0;overflow:hidden" });
						var progressFill = el("div", { class: "coc-progress-fill", style: "width:0%;height:100%;background:#4caf50;border-radius:3px;transition:width 0.3s" });
						progressBar.append(progressFill);
						var progressMsg = el("div", { class: "coc-progress-msg", style: "font-size:12px;color:#666;margin-bottom:8px" });
						resultBox.append(progressBar, progressMsg);
						progressFill.style.width = (view.percent || 0) + "%";
						progressMsg.textContent = view.message || "";
					} else if (view.kind === "result") {
						if (view.ok) {
							resultBox.append(el("div", { style: "font-size:13px;color:#8bc34a;font-weight:600;margin-bottom:6px" }, "✅ 导入成功"));
							var okDetail = el("div", { style: "font-size:12px;white-space:pre-wrap;line-height:1.5" });
							okDetail.textContent = view.render || "导入完成";
							resultBox.append(okDetail);
						} else {
							resultBox.classList.add("err");
							resultBox.append(el("div", { style: "font-size:13px;color:#ff5252;font-weight:600;margin-bottom:6px" }, "❌ 导入失败"));
							var errDetail = el("div", { style: "font-size:12px;white-space:pre-wrap;line-height:1.5" });
							errDetail.textContent = "失败：" + (view.error || "");
							resultBox.append(errDetail);
						}
					}
				}
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
					restoreImportView(resultBox);

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
						S.importView = { kind: "progress", percent: 0, message: "准备导入…" };
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
										S.importView = { kind: "result", ok: false, error: "流读取失败：" + err.message };
										progressMsg.textContent = "流读取失败：" + err.message;
									});
								}
								readStream();
							}).catch(function (err) {
								resultBox.classList.add("err");
								S.importView = { kind: "result", ok: false, error: "请求失败：" + err.message };
								progressMsg.textContent = "请求失败：" + err.message;
							});
						}
						function handleSSEEvent(event, data) {
							if (event === "progress") {
								progressFill.style.width = (data.percent || 0) + "%";
								progressMsg.textContent = data.message || "";
								S.importView = { kind: "progress", percent: data.percent || 0, message: data.message || "" };
							} else if (event === "result") {
								// 隐藏进度条，显示结果
								progressBar.style.display = "none";
								S.importView = data.ok
									? { kind: "result", ok: true, render: data.render || "导入完成" }
									: { kind: "result", ok: false, error: data.error || "" };
								if (data.ok) {
									resultBox.classList.remove("err");
									resultBox.innerHTML = ""; // 清空进度条
									resultBox.append(el("div", { style: "font-size:13px;color:#8bc34a;font-weight:600;margin-bottom:6px" }, "✅ 导入成功"));
									var detail = el("div", { style: "font-size:12px;white-space:pre-wrap;line-height:1.5" });
									detail.textContent = data.render || "导入完成";
									resultBox.append(detail);
									// 静默刷新 digest，不重建面板（保留结果框）；下次切换 tab 时自然更新
									api("/coc-api/state?game=" + encodeURIComponent(gameId()) + "&after=" + S.seq).then(function (json) {
										if (json.ok) { S.digest = json.data; }
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
								S.importView = { kind: "result", ok: false, error: data.error || "" };
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
									parseStructure: structCheck.checked,
									overwrite: kindSel.value === "scenario"
								});
							};
							reader.onerror = function () { progressMsg.textContent = "文件读取失败"; };
							reader.readAsDataURL(file);
						} else {
							doImportSSE({
								kind: kindSel.value, name: nameInput.value.trim(),
								text: textArea.value, parseStructure: structCheck.checked,
								overwrite: kindSel.value === "scenario"
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
				var playerGameSelect = el("select", { title: "选择游戏场次" });
				playerGameSelect.style.width = "108px";
				playerGameSelect.style.flex = "none";
				head.append(playerGameSelect);
				GAME_SELECTS.push(playerGameSelect);
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
				var playerLastGameId = gameId();
				var playerLogOffset = 0;
				var playerLogCard = null;
				var playerLogHead = null;
				var playerLastStatsKey = "";
				playerGameSelect.addEventListener("change", function () {
					setGame(playerGameSelect.value || "default");
					refreshGameSelects();
					if (typeof kpResetAndPoll === "function") kpResetAndPoll();
					else if (typeof kpPoll === "function") kpPoll(true);
					pollPlayer();
				});
				function appendPlayerLog(card, log) {
					log.forEach(function (entry) {
						var kind = entry.kind || "";
						var line = el("div", { class: "pp-msg " + kind });
						if (kind === "user") {
							line.append(el("span", { class: "pp-who" }, esc(entry.player || "玩家") + " · " + fmtTime(entry.at)));
							line.append(document.createTextNode(entry.text));
						} else if (kind === "kp") {
							line.append(el("span", { class: "pp-who" }, "KP · " + fmtTime(entry.at)));
							appendMarkdown(line, entry.text);
						} else {
							line.textContent = entry.text;
						}
						card.append(line);
					});
				}
				function updatePlayerLogHead(total) {
					if (playerLogHead !== null && total !== undefined) {
						playerLogHead.textContent = "最近动态（" + Math.min(playerLogOffset, total) + "/" + total + "）";
					}
				}
				function renderPlayer(data, appendLog) {
					// 增量轮询：只把新消息追加到已有日志卡片，不重绘整页。
					// 但角色数值（HP/SAN/MP/物品数）变化时必须整页重绘，否则玩家面板不刷新 SAN。
					if (appendLog === true && playerLogCard !== null) {
						if (data === null) return;
						var statsKey = JSON.stringify((data.characters || []).map(function (pc) {
							return [pc.name, pc.hp, pc.san, pc.mp, Array.isArray(pc.inventory) ? pc.inventory.length : 0].join("|");
						}));
						if (statsKey !== playerLastStatsKey) {
							playerLastStatsKey = statsKey;
							renderPlayer(data, false);
							return;
						}
						var newLog = Array.isArray(data.log) ? data.log : [];
						if (newLog.length > 0) {
							appendPlayerLog(playerLogCard, newLog);
							playerLogOffset += newLog.length;
							updatePlayerLogHead(data.logLength);
						}
						return;
					}
					if (data === null) { body.textContent = ""; body.append(el("div", { class: "pp-card" }, "尚无游戏数据。")); return; }
					playerLastStatsKey = JSON.stringify((data.characters || []).map(function (pc) {
						return [pc.name, pc.hp, pc.san, pc.mp, Array.isArray(pc.inventory) ? pc.inventory.length : 0].join("|");
					}));
					body.textContent = "";
					playerLogOffset = 0;
					playerLogCard = null;
					playerLogHead = null;
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
							var stats = pc.stats && Object.keys(pc.stats).length > 0 ? "｜" + Object.keys(pc.stats).map(function (k) { return k + " " + pc.stats[k]; }).join(" ") : "";
							line.textContent = pc.name + (pc.occupation ? "（" + pc.occupation + "）" : "") + "：HP " + pc.hp + " / SAN " + pc.san + " / MP " + pc.mp + stats + (Array.isArray(pc.inventory) && pc.inventory.length > 0 ? "｜物品：" + pc.inventory.join("、") : "");
							pcCard.append(line);
						});
						body.append(pcCard);
					}
					if (Array.isArray(data.entities) && data.entities.length > 0) {
						var entCard = el("div", { class: "pp-card" });
						entCard.append(el("h4", null, "你注意到"));
						data.entities.forEach(function (e) {
							var text = "◆ " + esc(e.name);
							if (e.desc) text += "：" + esc(String(e.desc).slice(0, 80));
							if (e.state) text += "　［状态：" + esc(String(e.state).slice(0, 40)) + "］";
							entCard.append(el("div", { class: "pp-kv" }, text));
						});
						body.append(entCard);
					}
					if (Array.isArray(data.knownClues) && data.knownClues.length > 0) {
						var clueCard = el("div", { class: "pp-card" });
						clueCard.append(el("h4", null, "已知线索"));
						data.knownClues.forEach(function (clue) {
							var text = typeof clue === "string" ? clue : (clue.description || clue.title || JSON.stringify(clue));
							clueCard.append(el("div", { class: "pp-kv" }, "✧ " + esc(text)));
						});
						body.append(clueCard);
					}
					var log = Array.isArray(data.log) ? data.log : [];
					if (log.length > 0) {
						var logCard = el("div", { class: "pp-card" });
						logCard.append(el("h4", null, "最近动态" + (data.logLength !== undefined ? "（" + log.length + "/" + data.logLength + "）" : "")));
						playerLogHead = logCard.firstChild;
						appendPlayerLog(logCard, log);
						playerLogOffset = log.length;
						playerLogCard = logCard;
						body.append(logCard);
					}
				}
				function pollPlayer(appendLog) {
					var gid = gameId();
					if (gid !== playerLastGameId) {
						// KP 端切换了场次：玩家视图重新全量渲染，不做增量追加。
						playerLastGameId = gid;
						appendLog = false;
						if (playerGameSelect.value !== gid) playerGameSelect.value = gid;
					}
					var qs = "/coc-api/player-view?game=" + encodeURIComponent(gid);
					if (appendLog === true) qs += "&after=" + playerLogOffset;
					else qs += "&after=0";
					return api(qs).then(function (json) {
						if (json.ok) renderPlayer(json.data, appendLog);
					});
				}
				playerPoll = pollPlayer;
				refreshGameSelects();
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
				var timer = setInterval(function () { pollPlayer(true); }, 3000);
				return function cleanup() {
					clearInterval(timer);
					unregisterDock();
					GAME_SELECTS = GAME_SELECTS.filter(function (sel) { return sel !== playerGameSelect; });
					if (playerPoll === pollPlayer) playerPoll = null;
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
