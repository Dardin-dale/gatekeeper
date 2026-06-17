const os = require('os');

// Cap parallelism. Jest defaults to (cores - 1) workers; on a high-core box
// (this WSL2 VM reports 32) that spawns ~31 Node processes, each loading
// ts-jest + aws-cdk-lib, which exhausts the VM's memory and hard-crashes WSL.
// Cap at 4 (the suite runs in seconds, so more buys nothing) while still
// scaling DOWN for small CI runners so we never over-subscribe a 2-core box.
const maxWorkers = Math.max(1, Math.min(4, (os.cpus().length || 2) - 1));

module.exports = {
  testEnvironment: 'node',
  maxWorkers,
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  modulePathIgnorePatterns: ['<rootDir>/test/.*\\.js$'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
};