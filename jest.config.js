/** ts-jest + node 环境。inline tsconfig（commonjs/esModuleInterop/ES2020）避开主/渲染 tsconfig 的
 *  noEmit/bundler 设置，仅用于测试编译。测试文件不进 dist（tsconfig.main.json 已 exclude __tests__）。 */
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  // `sing-box check` 门需要**随包内核**（resources/<平台>/sing-box，66–74MB、已 gitignore），默认 `npm test` 与 CI
  // 测试 job 都没有它。故把该门移出默认测试集，改由 `npm run test:core-gate` 单独跑——该 script 已接进
  // package:* / dist:* 链（这些链先跑 fetch:core，核在那里恒存在），有真实执行位置而非只写在文档里。
  // 门本身「核缺失即硬 fail、绝不静默 skip」的语义不变：它只在核确定存在的链路上被调用，故不需要（也没有）
  // 任何环境变量豁免开关——豁免只会变成关门的后门。
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/src/main/services/__tests__/singbox-check-gate\\.test\\.ts$',
    // Xray sidecar 真核门：同上，需随包 xray + sing-box 二进制，由 test:core-gate 执行。
    '<rootDir>/src/main/services/__tests__/xray-check-gate\\.test\\.ts$',
    '<rootDir>/src/main/services/__tests__/xray-runtime-e2e\\.test\\.ts$',
  ],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2020',
          esModuleInterop: true,
          allowJs: false,
          strict: true,
          skipLibCheck: true,
          isolatedModules: false,
          resolveJsonModule: true,
        },
      },
    ],
  },
};
