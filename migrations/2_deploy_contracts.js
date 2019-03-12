var CacheGold = artifacts.require("./CacheGold.sol");
var LockedGoldOracle = artifacts.require("./LockedGoldOracle.sol");

// Load account keys
require('dotenv').config();

module.exports = function(deployer, network, accounts) {

    console.log("Migration Info...");
    console.log("Network: " + network);
    console.log("Accounts:\n" + JSON.stringify(accounts, null, 4));
    var oracle;


    // Deploy oracle first then token contract
    if (network === 'test' || 
        network === 'local' || 
        network === 'development' ||
        network === 'coverage') {
        deployer.then(function() {
            return LockedGoldOracle.new();
        }).then(function(lgo) {
            oracle = lgo;
            console.log("Deployed Locked Gold Oracle to " + oracle.address);
            return CacheGold.new(accounts[1],
                                 accounts[2],
                                 accounts[3],
                                 accounts[4],
                                 oracle.address);
        }).then(async(cache) => {
            console.log("Deployed CacheGold to " + cache.address);
            await oracle.setCacheContract(cache.address);
        });
    } else if (network === 'ropsten') {
        deployer.then(function() {
          return LockedGoldOracle.new();
        }).then(function(lgo) {
            oracle = lgo;
            console.log("Deployed Locked Gold Oracle to " + oracle.address);
            return CacheGold.new(process.env.UNBACKED_ADDR,
                                 process.env.BACKED_ADDR,
                                 process.env.FEE_ADDR,
                                 process.env.REDEEM_ADDR,
                                 oracle.address)
        }).then(async(cache) => {
            console.log("Deployed CacheGold to " + cache.address);
            await oracle.setCacheContract(cache.address);
        });
    } else {
        console.log("No deploy configured yet for this network...");
        process.exit();
    }
}
