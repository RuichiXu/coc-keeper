/**
 * 规则域 Skills 注册
 *
 * Step 6：把 CoC 7e 规则摘要注册为 DSH skills，
 * 模型可按需用 skill 工具加载完整规则说明，降低系统提示词负担。
 *
 * ctx.skills 由宿主提供；本模块防御性注册（无 skills 服务时跳过）。
 */

const DICE_SKILL = `# CoC 7e 检定规则

## 成功档次（百分骰 d100，目标 = 技能值）
- 大成功：出目 01；或技能 ≥ 50 时 01-05
- 极限成功：出目 ≤ 技能值 / 5
- 困难成功：出目 ≤ 技能值 / 2
- 常规成功：出目 ≤ 技能值
- 失败：出目 > 技能值
- 大失败：技能 < 50 时 96-00；技能 ≥ 50 时仅 00（即 100）

## 奖励骰 / 惩罚骰
- 奖励骰：额外掷一个十位骰，取对玩家最有利的结果
- 惩罚骰：额外掷一个十位骰，取对玩家最不利的结果

## 属性检定
- 力量、体质、敏捷、智力、意志、外貌、教育、幸运等属性可直接作为 target 检定。
- 注意：CoC 7e 的常规/困难/极限是技能值的 1 / 1/2 / 1/5，不是其他版本的 1/5 规则改动。`;

const COMBAT_SKILL = `# CoC 7e 战斗规则

## 战斗流程
1. 攻击方声明行动与武器
2. 攻击方掷命中检定（近战用「格斗（斗殴）」等，远程用「射击（手枪/步枪等）」）
3. 防御方可选择闪避（近战可反击）
4. 命中后掷武器伤害 + 伤害加值（DB），扣除护甲
5. 单次伤害 ≥ 最大 HP 的一半 → 重伤

## 伤害加值（DB）表（力量 STR + 体型 SIZ）
| 合计 | DB |
|---|---|
| 2-64 | -2 |
| 65-84 | -1 |
| 85-124 | 0 |
| 125-164 | +1d4 |
| 165-204 | +1d6 |
| 205-284 | +2d6 |
| 285+ | +3d6 |

## 常用武器
- 徒手：1d3 + DB
- 小刀：1d4 + DB
- 猎刀：1d6 + DB
- .38 左轮：1d10
- 霰弹枪：4d6（近距）

## 自动工具
战斗结算请调用 coc_combat_resolve，不要手算命中与伤害。`;

const SANITY_SKILL = `# CoC 7e 理智（SAN）规则

## 理智检定
- 目睹神话生物/恐怖场景/超自然事件时，KP 宣布 SAN 损失格式：
  - 「0/1d3」= 理智检定成功损失 0，失败损失 1d3
  - 「1/1d6+1」= 成功损失 1，失败损失 1d6+1
- 理智检定目标 = 当前 SAN；掷 d100 ≤ 当前 SAN 即成功

## 疯狂
- 单次损失 ≥ 5 SAN → 临时性疯狂（短期失控）
- 单次损失 ≥ 当前 SAN 的 1/5 → 不定性疯狂（长期）
- SAN 归 0 → 永久疯狂，调查员由 KP 接管

## 自动工具
理智检定请调用 coc_sanity_check，自动计算损失与疯狂，更新 SAN。`;

const GROWTH_SKILL = `# CoC 7e 技能成长规则

## 冒险结束成长
1. 调查员在冒险中成功使用过的技能打勾
2. 对每个打勾技能掷 d100
3. 出目 > 当前技能值 → 成长，增加 1d10 点
4. 出目 ≤ 当前技能值 → 未成长

## 自动工具
请调用 coc_skill_growth(player, skill)，自动掷骰并更新人物卡。`;

/**
 * 注册规则域 skills。
 * @param {object} ctx - 真实 Cordis ctx
 */
export function registerRuleSkills(ctx) {
  const skills = ctx.skills;
  if (skills === undefined || typeof skills.register !== "function") {
    console.log("[coc-keeper] ctx.skills 不可用，跳过规则域 Skills 注册");
    return;
  }

  const register = (name, description, content) => {
    skills.register({
      name,
      description,
      content,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: "coc-keeper",
    });
  };

  register("coc-rule-dice", "CoC 7e 检定规则：成功档次、大成功/大失败、奖励骰与惩罚骰。", DICE_SKILL);
  register("coc-rule-combat", "CoC 7e 战斗规则：命中/闪避/伤害加值 DB 表/重伤判定。", COMBAT_SKILL);
  register("coc-rule-sanity", "CoC 7e 理智规则：SAN 损失格式、理智检定与疯狂。", SANITY_SKILL);
  register("coc-rule-growth", "CoC 7e 技能成长规则：冒险结束 d100 成长判定。", GROWTH_SKILL);

  console.log("[coc-keeper] 已注册规则域 Skills：coc-rule-dice / coc-rule-combat / coc-rule-sanity / coc-rule-growth");
}
