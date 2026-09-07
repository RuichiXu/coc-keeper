/**
 * HP 扣损账本（Damage Ledger）
 *
 * 统一记录自动结算与 KP 手动 coc_pc 造成的 HP 损失，用于阻止同一事件
 * 被重复扣血（Codex r3：自动扣 1 HP 后，KP 又为同一事件调用 coc_pc 扣 1 HP）。
 *
 * 纯函数 + Node 内置模块，零 DSH 依赖。
 */

const LEDGER_WINDOW_MS = 120000;

/**
 * 记录一次 HP 损失。
 * @param {object} flat
 * @param {string} player
 * @param {number} amount
 * @param {string} source 来源标识，如 "settlement:set-2" / "checkpoint:chk-8" / "kp-tool"
 * @returns {object} 账本条目
 */
export function recordHpLoss(flat, player, amount, source) {
  const ledger = Array.isArray(flat.hpLossLedger) ? flat.hpLossLedger : (flat.hpLossLedger = []);
  const entry = {
    player: String(player ?? ""),
    amount: Number(amount) || 0,
    source: String(source ?? "kp-tool"),
    at: new Date().toISOString(),
  };
  ledger.push(entry);
  if (ledger.length > 40) flat.hpLossLedger = ledger.slice(-40);
  return entry;
}

/**
 * 查找同一角色在窗口期内已记录的等额损失。
 * @param {object} flat
 * @param {string} player
 * @param {number} amount
 * @param {number} [windowMs=120000]
 * @returns {object|null}
 */
export function findRecentHpLoss(flat, player, amount, windowMs = LEDGER_WINDOW_MS) {
  const ledger = Array.isArray(flat.hpLossLedger) ? flat.hpLossLedger : [];
  const now = Date.now();
  return ledger.find((entry) =>
    entry.player === String(player ?? "") &&
    Math.abs(Number(entry.amount) - Number(amount)) < 0.5 &&
    now - Date.parse(entry.at) < windowMs
  ) ?? null;
}
