/**
 * 轻量测试 harness
 *
 * 提供 describe / it / expect 断言，以及测试运行器。
 * 不依赖任何第三方测试框架。
 *
 * 用法：
 *   import { describe, it, expect, run } from "./runner.js";
 *   describe("模块名", () => {
 *     it("测试描述", () => {
 *       expect(1 + 1).toBe(2);
 *     });
 *   });
 *   run();
 */

// ── 断言工具 ──────────────────────────────────────────────

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

class Expect {
  constructor(actual) {
    this.actual = actual;
  }

  toBe(expected) {
    if (this.actual !== expected) {
      throw new AssertionError(
        `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(this.actual)}`
      );
    }
  }

  toEqual(expected) {
    const a = JSON.stringify(this.actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new AssertionError(`期望 ${b}，实际 ${a}`);
    }
  }

  toBeTrue() {
    this.toBe(true);
  }

  toBeFalse() {
    this.toBe(false);
  }

  toBeNull() {
    if (this.actual !== null) {
      throw new AssertionError(`期望 null，实际 ${JSON.stringify(this.actual)}`);
    }
  }

  notToBeNull() {
    if (this.actual === null) {
      throw new AssertionError(`期望不为 null，但实际为 null`);
    }
  }

  toBeUndefined() {
    if (this.actual !== undefined) {
      throw new AssertionError(`期望 undefined，实际 ${JSON.stringify(this.actual)}`);
    }
  }

  notToBeUndefined() {
    if (this.actual === undefined) {
      throw new AssertionError(`期望不为 undefined，但实际为 undefined`);
    }
  }

  toBeGreaterThan(n) {
    if (!(this.actual > n)) {
      throw new AssertionError(`期望 > ${n}，实际 ${this.actual}`);
    }
  }

  toBeGreaterThanOrEqual(n) {
    if (!(this.actual >= n)) {
      throw new AssertionError(`期望 >= ${n}，实际 ${this.actual}`);
    }
  }

  toBeLessThan(n) {
    if (!(this.actual < n)) {
      throw new AssertionError(`期望 < ${n}，实际 ${this.actual}`);
    }
  }

  toBeLessThanOrEqual(n) {
    if (!(this.actual <= n)) {
      throw new AssertionError(`期望 <= ${n}，实际 ${this.actual}`);
    }
  }

  toContain(item) {
    if (!this.actual.includes(item)) {
      throw new AssertionError(
        `期望包含 ${JSON.stringify(item)}，实际 ${JSON.stringify(this.actual)}`
      );
    }
  }

  notToContain(item) {
    if (this.actual.includes(item)) {
      throw new AssertionError(
        `期望不包含 ${JSON.stringify(item)}，但实际包含`
      );
    }
  }

  toHaveLength(n) {
    if (this.actual.length !== n) {
      throw new AssertionError(`期望长度 ${n}，实际 ${this.actual.length}`);
    }
  }

  toMatch(regex) {
    if (!regex.test(this.actual)) {
      throw new AssertionError(`期望匹配 ${regex}，实际 ${JSON.stringify(this.actual)}`);
    }
  }

  toThrow(messagePart) {
    let threw = false;
    let errorMessage = "";
    try {
      this.actual();
    } catch (err) {
      threw = true;
      errorMessage = err.message;
    }
    if (!threw) {
      throw new AssertionError("期望抛出异常，但没有抛出");
    }
    if (messagePart && !errorMessage.includes(messagePart)) {
      throw new AssertionError(
        `期望异常消息包含 "${messagePart}"，实际 "${errorMessage}"`
      );
    }
  }

  notToThrow() {
    let threw = false;
    let errorMessage = "";
    try {
      this.actual();
    } catch (err) {
      threw = true;
      errorMessage = err.message;
    }
    if (threw) {
      throw new AssertionError(`期望不抛出异常，但抛出了 "${errorMessage}"`);
    }
  }
}

export function expect(actual) {
  return new Expect(actual);
}

// ── 测试注册 ──────────────────────────────────────────────

const suites = [];
let currentSuite = null;

export function describe(name, fn) {
  const suite = { name, tests: [] };
  suites.push(suite);
  currentSuite = suite;
  fn();
  currentSuite = null;
}

export function it(name, fn) {
  if (!currentSuite) throw new Error("it() 必须在 describe() 内调用");
  currentSuite.tests.push({ name, fn });
}

// ── Mock 工具 ─────────────────────────────────────────────

/**
 * 固定 Math.random 返回值序列。
 * @param {number[]} values - 0~1 之间的随机值序列
 * @returns {() => void} 恢复函数
 */
export function mockRandom(values) {
  const original = Math.random;
  let index = 0;
  Math.random = () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
  return () => {
    Math.random = original;
  };
}

/**
 * 根据期望骰值生成 Math.random mock。
 * 骰值 = floor(random * sides) + 1
 * 例如：期望 d100 掷出 45，则 random = (45 - 1) / 100 = 0.44
 *
 * @param {Array<{ sides: number, value: number }>} dice - 期望骰面与出目
 * @returns {number[]} mock 用的 random 值序列
 */
export function randomForDice(dice) {
  return dice.map(({ sides, value }) => (value - 1) / sides + 0.0001);
}

// ── 运行器 ────────────────────────────────────────────────

/**
 * 运行所有已注册的测试（支持 async 测试）。
 * @param {object} [opts]
 * @param {boolean} [opts.verbose=false]
 * @returns {Promise<{ passed: number, failed: number, skipped: number, failures: Array }>}
 */
export async function run(opts = {}) {
  const { verbose = false } = opts;
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const suite of suites) {
    if (verbose) console.log(`\n### ${suite.name}`);
    for (const test of suite.tests) {
      try {
        await test.fn();
        passed += 1;
        if (verbose) console.log(`  ✓ ${test.name}`);
      } catch (err) {
        failed += 1;
        failures.push({ suite: suite.name, test: test.name, error: err });
        if (verbose) {
          console.log(`  ✗ ${test.name}`);
          console.log(`    ${err.message}`);
        }
      }
    }
  }

  return { passed, failed, skipped: 0, failures };
}

/**
 * 打印测试结果汇总。
 * @param {{ passed: number, failed: number, skipped: number, failures: Array }} result
 * @param {string} label
 * @returns {number} 退出码（0=通过，1=有失败）
 */
export function summarize(result, label = "测试") {
  console.log(
    `\n[${label}] 通过 ${result.passed}，失败 ${result.failed}，跳过 ${result.skipped}`
  );

  if (result.failures.length > 0) {
    for (const f of result.failures) {
      console.log(`\n✗ [${f.suite}] ${f.test}`);
      console.log(`  ${f.error.stack ?? f.error.message}`);
    }
    return 1;
  }
  return 0;
}