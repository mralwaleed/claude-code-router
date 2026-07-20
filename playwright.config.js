/** @type {import('@playwright/test').PlaywrightTestConfig} */
export default {
  testDir: "./tests/e2e",
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
  },
  reporter: [["list"]],
};
