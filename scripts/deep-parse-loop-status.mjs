/**
 * 生成-审核 loop 状态计算（离线验证用）
 *
 * 读取每个剧本目录下的 review.json（第 1 轮审核）与 review2.json（第 2 轮审核），
 * 按既定通过标准计算各轮是否通过：
 *   第 1-2 轮：high=0 && medium=0
 *   第 3 轮：high=0 && medium<=2
 *
 * 用法：
 *   node scripts/deep-parse-loop-status.mjs [slug...]
 *   （不带参数时扫描 artifacts/deep-parse-review 下全部目录）
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const reviewDir = process.argv[2]
  ? join(__dirname, "..", "artifacts", process.argv[2])
  : join(__dirname, "..", "artifacts", "deep-parse-review");

function countSeverity(issues) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const issue of issues ?? []) {
    const severity = String(issue?.severity ?? "low").toLowerCase();
    if (counts[severity] !== undefined) counts[severity] += 1;
  }
  return counts;
}

function passForRound(counts, round) {
  if (round <= 2) return counts.high === 0 && counts.medium === 0;
  return counts.high === 0 && counts.medium <= 2;
}

function loadReview(dir, name) {
  const file = join(dir, name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const baseArg = process.argv[2] ?? null;
const slugs = baseArg !== null && process.argv[3]
  ? process.argv.slice(3)
  : readdirSync(reviewDir).filter((name) => {
      const stat = existsSync(join(reviewDir, name)) && !name.startsWith(".");
      return stat;
    });

for (const slug of slugs) {
  const dir = join(reviewDir, slug);
  const reviews = [
    { round: 1, data: loadReview(dir, "review1.json") ?? loadReview(dir, "review.json"), label: "第1轮" },
    { round: 2, data: loadReview(dir, "review2.json"), label: "第2轮" },
    { round: 3, data: loadReview(dir, "review3.json"), label: "第3轮" },
  ];
  console.log(`${slug}`);
  for (const { round, data, label } of reviews) {
    if (data === null) {
      console.log(`  ${label}: 无审核`);
      continue;
    }
    const counts = countSeverity(data.issues);
    const pass = passForRound(counts, round);
    console.log(`  ${label}: ${pass ? "PASS" : "FAIL"}  high=${counts.high} medium=${counts.medium} low=${counts.low}`);
  }
  console.log("");
}
