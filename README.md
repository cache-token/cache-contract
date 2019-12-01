# CacheGold Contract

## Overview
This repository contains the CacheGold contract; an ERC20 compatible token in which 1 token represents 1 gram of pure physical gold. A full description can be found in the [token documentation](https://github.com/cache-token/docs/blob/master/TOKEN_OVERVIEW.md).

A copy of our contract audit can be found [here](https://github.com/cache-token/docs/blob/master/CACHE_Gold_Audit_Zerotrust.pdf).

### Install Dependencies
With node v8 or higher installed..
```bash
npm install
```

Truffle is installed by default to `./node_modules/.bin/truffle`, but it can also be installed globally
```
npm uninstall -g truffle
npm install -g truffle
```

We are using the latest 5.x version (Currently 5.0.24)

### Development Dependencies

`ganache` : Is used to run a local version of the ethereum blockchain for dev testing. You can download a release [here](https://github.com/trufflesuite/ganache/releases)

## Developing Contract

### Compile Contract
```
truffle compile
# or
npm run compile
```

### Run Contract Tests
```
truffle test
# or 
npm run test
```

### Deploy To Localhost with Ganache Running
```
npm run deploy-dev
```

### Deploy To Ethereum Testnet
Need to fill in variables in [.env](./.env)

```
npm run deploy-ropsten
```

### Viewing the hash of deployed contracts
```
truffle network
```

### Run Code Coverage Tests
```
npm run coverage
```

Spits out a report to the `./coverage` which can be served as a static site
