'use strict';

const suites = [
  { name: 'core', suite: require('./test-agent-core') },
  { name: 'registry', suite: require('./test-agent-registry') },
  { name: 'stdio', suite: require('./test-agent-stdio') }
];

(async () => {
  let passed = 0;
  for (const { name, suite } of suites) {
    try {
      await suite.run();
    } catch (error) {
      error.message = `[${name}] ${error.message}`;
      throw error;
    }
    passed += 1;
  }
  console.log(`[agent-test] ${passed}/${suites.length} suites passed`);
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
