# 测试夹具说明

## `scenarios/`（已入库）

D 阶段深度解析链路使用的真实剧本夹具，被 `tests/unit/deep-parse-fixtures.test.mjs` 引用：

- `两面不是人v2.1.pdf` + `.txt`
- `观止-见世之蝶.docx`
- `淡焱无生-对流.docx`
- `盲愚之眼_瓦上狸奴译.pdf` + `.txt`

## `hidden_scenarios/`（本地评测用，不入库）

隐藏门禁/可选长剧本的原始 PDF，体积较大（0.6–11 MB），且不参与自动化测试，
因此通过 `.gitignore` 排除。需要复跑这些剧本时，按下面的目录结构放入本地即可：

```
tests/fixtures/hidden_scenarios/
├── 2001：太空漫游.pdf
├── Tim-无心漫谈 (2)/
│   └── XVIII——无心漫谈.pdf
├── 星影泠—坍圮之梦12.10修改版.pdf
└── 星孩v1.0/
    └── 星孩v1.0（无插图版）.pdf
```

复跑方式：

```sh
# 1) 先用 docx-extract 提取文本（或手动准备 original.txt）
node scripts/run-deep-parse-loop.mjs <场景目录>
```

门禁评测结果见 `DEVLOG.md` 的「隐藏新剧本最终门禁」章节。
