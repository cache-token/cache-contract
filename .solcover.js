module.exports = {
  testCommand: '../node_modules/.bin/truffle test --network coverage',
  compileCommand: '../node_modules/.bin/truffle compile',
  norpc: true,
  deepSkip: true,
  copyPackages: ['openzeppelin-solidity'],
  skipFiles: ['Migrations.sol']
}
