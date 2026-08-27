/**
 * 关键点/物品自动落地（确定性启发式）单元测试
 */
import { describe, it, expect, run, summarize } from "../runner.js";
import {
  autoTrackInventory,
  revealKeyPointsFromNarration,
} from "../../lib/shared/chat/index.js";

describe("关键点自动揭示", () => {
  it("叙述完整出现未揭示关键点标题时揭示", () => {
    const keyPoints = [
      { id: "kp-1", title: "墨渊", desc: "屋顶的墨色深渊", revealed: false },
      { id: "kp-2", title: "十二字咒文", desc: "四组三字", revealed: false },
    ];
    const changed = revealKeyPointsFromNarration(keyPoints, "你看到屋顶上有一片墨渊在缓慢旋转。");
    expect(changed).toBe(1);
    expect(keyPoints[0].revealed).toBeTrue();
    expect(keyPoints[1].revealed).toBeFalse();
  });

  it("不误揭示未出现的标题", () => {
    const keyPoints = [{ id: "kp-1", title: "鬼影", desc: "", revealed: false }];
    const changed = revealKeyPointsFromNarration(keyPoints, "你走进空无一人的书房。");
    expect(changed).toBe(0);
    expect(keyPoints[0].revealed).toBeFalse();
  });

  it("忽略长度不足 2 的标题", () => {
    const keyPoints = [{ id: "kp-1", title: "墨", desc: "", revealed: false }];
    const changed = revealKeyPointsFromNarration(keyPoints, "墨迹在纸上晕开。");
    expect(changed).toBe(0);
  });

  it("标题带动作前缀（发现墨渊）也能通过正文命中", () => {
    const keyPoints = [{ id: "kp-1", title: "发现墨渊", desc: "", revealed: false }];
    const changed = revealKeyPointsFromNarration(keyPoints, "墨渊正在屋顶上缓缓旋转。");
    expect(changed).toBe(1);
    expect(keyPoints[0].revealed).toBeTrue();
  });

  it("标题为「A与B」时，正文同时出现 A、B 即命中", () => {
    const keyPoints = [{ id: "kp-1", title: "发现日记与手稿", desc: "", revealed: false }];
    const changed = revealKeyPointsFromNarration(keyPoints, "抽屉里有一本日记和四张手稿。");
    expect(changed).toBe(1);
    expect(keyPoints[0].revealed).toBeTrue();
  });

  it("标题带事件后缀（委托到来）也能通过核心词命中", () => {
    const keyPoints = [{ id: "kp-1", title: "委托到来", desc: "", revealed: false }];
    const changed = revealKeyPointsFromNarration(keyPoints, "艾茜向你们说明了这份委托，请你们调查宅邸怪事。");
    expect(changed).toBe(1);
    expect(keyPoints[0].revealed).toBeTrue();
  });
});

describe("物品自动入栏", () => {
  it("从叙述中提取获得的实体物品", () => {
    const flat = {
      characters: [
        { name: "伊芙琳", aiControlled: false, inventory: [] },
      ],
    };
    const added = autoTrackInventory(flat, "艾茜从衣袋里取出一把备用钥匙递给你。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("备用钥匙");
    expect(flat.characters[0].inventory).toContain("备用钥匙");
  });

  it("不把抽象概念误入物品栏", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你得到了一条重要线索。");
    expect(added).toHaveLength(0);
    expect(flat.characters[0].inventory).toHaveLength(0);
  });

  it("已存在的物品不重复入栏", () => {
    const flat = {
      characters: [
        { name: "伊芙琳", aiControlled: false, inventory: ["手稿"] },
      ],
    };
    const added = autoTrackInventory(flat, "你拿起手稿。");
    expect(added).toHaveLength(0);
    expect(flat.characters[0].inventory).toHaveLength(1);
  });

  it("把字句提取持有物品，并套用别名（四张原稿→手稿）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你把四张原稿按顺序装入随身文件夹。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("手稿");
    expect(flat.characters[0].inventory).toContain("手稿");
  });

  it("把字句清理叠词数量（原稿一张张→手稿），不误收证物袋", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你将四张原稿一张张放进新的证物袋。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("手稿");
    expect(flat.characters[0].inventory).toContain("手稿");
    expect(flat.characters[0].inventory).notToContain("证物袋");
  });

  it("拒绝介词短语（纸从它熟悉的位置）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "纸从它熟悉的位置滑落出来。");
    expect(added).toHaveLength(0);
    expect(flat.characters[0].inventory).toHaveLength(0);
  });

  it("把字句+提/挎动词（黄铜汽灯/结实麻绳）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你把黄铜汽灯提在手里，又将结实麻绳挎在肩头。");
    expect(added).toHaveLength(2);
    expect(flat.characters[0].inventory).toContain("黄铜汽灯");
    expect(flat.characters[0].inventory).toContain("结实麻绳");
  });

  it("将字句+随身携带", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "你将四张原稿随身携带。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("手稿");
  });

  it("状态式持有（结实麻绳盘好斜挎过肩）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "结实麻绳盘好斜挎过肩，绳结压在肩胛侧。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("结实麻绳");
  });

  it("容器内容（装有四张原稿的文件夹）", () => {
    const flat = {
      characters: [{ name: "伊芙琳", aiControlled: false, inventory: [] }],
    };
    const added = autoTrackInventory(flat, "装有四张原稿的文件夹贴着身侧。");
    expect(added).toHaveLength(1);
    expect(added[0]).toBe("手稿");
  });

  it("清理旧版垃圾条目并保留正常物品", () => {
    const flat = {
      characters: [
        { name: "伊芙琳", aiControlled: false, inventory: ["原稿一张张", "纸从它熟悉的位置", "手稿"] },
      ],
    };
    const added = autoTrackInventory(flat, "你把黄铜汽灯提在左手。");
    expect(added).toHaveLength(1);
    expect(flat.characters[0].inventory).toContain("手稿");
    expect(flat.characters[0].inventory).toContain("黄铜汽灯");
    expect(flat.characters[0].inventory).notToContain("原稿一张张");
    expect(flat.characters[0].inventory).notToContain("纸从它熟悉的位置");
  });
});

const result = await run({ verbose: true });
process.exit(summarize(result, "state-autolanding 单元测试"));
