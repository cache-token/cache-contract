// Contract to test
var LockedGoldOracle = artifacts.require('./LockedGoldOracle.sol');
var CacheGold = artifacts.require('./CacheGold.sol');

const BigNumber = require('bignumber.js');
const BN = require('bn.js');
const truffleAssert = require('truffle-assertions');

// Set rounding mode to round down like javascript
BigNumber.config({ ROUNDING_MODE: 1 })

// pretty print a json result
pprint = (result) => {
    console.log(JSON.stringify(result, null, 4));
}

const DECIMALS = 8;
const TOKEN = new BN(10**DECIMALS)

contract('LockedGoldOracle', function(accounts) {

    // Set up some account info
    const owner = accounts[0];
    const unbacked_addr = accounts[1];
    const backed_addr = accounts[2];
    const fee_addr = accounts[3];
    const redeem_addr = accounts[4];
    const external1 = accounts[5];
    const external2 = accounts[6];
    const external3 = accounts[7];
    const zero_addr = '0x0000000000000000000000000000000000000000';

    // Reset the contract instance on each run
    var instance;
    var cache;
    beforeEach(function() {
        return LockedGoldOracle.new().then(function(inst) {
            instance = inst;
            CacheGold.new(unbacked_addr, 
                          backed_addr,
                          fee_addr,
                          redeem_addr,
                          inst.address).then(async(_cache) => {
                cache = _cache;
                await inst.setCacheContract(cache.address);
            });
        });
    });

    it("Test balance settings", async function () {
        
        // lock 1000 grams and verify
        await instance.lockAmount(1000);
        let balance = await instance.lockedGold();
        assert.equal(balance.toNumber(), 1000);
        
        // lock another 1000 grams and verify
        await instance.lockAmount(1000);
        balance = await instance.lockedGold();
        assert.equal(balance.toNumber(), 2000);
        
        // unlock 500 grams and verify
        await instance.unlockAmount(500);
        balance = await instance.lockedGold();
        assert.equal(balance.toNumber(), 1500);

        // Try to unlock too much
        await truffleAssert.fails(instance.unlockAmount(5000));
    });

    it("More advanced balance tests", async function () {
        // Try to mint 1100 grams should fail
        await truffleAssert.reverts(cache.addBackedTokens(1100*TOKEN));
        
        // lock 1000 grams and verify
        await instance.lockAmount(1000*TOKEN);
        let lockedGold = await instance.lockedGold();
        assert.equal(lockedGold.toNumber(), 1000*TOKEN);

        // Try to mint 1100 grams should fail
        await truffleAssert.reverts(cache.addBackedTokens(1100*TOKEN));

        // Try to mint 1000 should be fine
        await cache.addBackedTokens(1000*TOKEN);
        let totalCirculation = await cache.totalCirculation();
        assert.equal(totalCirculation.toNumber(), 1000*TOKEN);

        // Now trying unlock 100 grams should fail because it 
        // would mean more tokens in circulation than locked
        await truffleAssert.reverts(instance.unlockAmount(100*TOKEN));

        // Move 200 tokens to unbacked treasury
        await cache.transfer(unbacked_addr, 200*TOKEN, {'from': backed_addr});

        // Try again and make sure it passes
        await instance.unlockAmount(100*TOKEN);
        await instance.unlockAmount(100*TOKEN);
        lockedGold = await instance.lockedGold();
        assert.equal(lockedGold.toNumber(), 800*TOKEN);
    });
    
    it("Verify owner rights", async function () {
        await truffleAssert.fails(instance.lockAmount(100, {'from': accounts[1]}));
    });
    
});
