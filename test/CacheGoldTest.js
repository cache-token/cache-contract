// Contract to test
var CacheGold = artifacts.require('./CacheGold.sol');
var LockedGoldOracle = artifacts.require('./LockedGoldOracle.sol');
const BigNumber = require('bignumber.js');
const BN = require('bn.js');
const truffleAssert = require('truffle-assertions');

// Some async jibber jabber
web3.providers.HttpProvider.prototype.sendAsync = web3.providers.HttpProvider.prototype.send

// Set rounding mode to round down like javascript
BigNumber.config({ ROUNDING_MODE: BigNumber.ROUND_DOWN })

// Some contract constants
const DEFAULT_TRANSFER_FEE = 0.0010;
const DECIMALS = 8;
const TOKEN = new BN(10**DECIMALS)
const SUPPLY_LIMIT = new BN('8133525786').mul(TOKEN);
const DAY = 86400;
const INACTIVE_THRESHOLD_DAYS = 1095;

// ------------- Helper Functions to Advance Block / Block Timestamp --------- //
advanceTimeAndBlock = async (time) => {
    await advanceTime(time);
    await advanceBlock();
    return Promise.resolve(web3.eth.getBlock('latest'));
}

advanceTime = (time) => {
    return new Promise((resolve, reject) => {
        web3.currentProvider.sendAsync({
            jsonrpc: "2.0",
            method: "evm_increaseTime",
            params: [time],
            id: new Date().getTime()
        }, (err, result) => {
            if (err) { return reject(err); }
            return resolve(result);
        });
    });
}

advanceBlock = () => {
    return new Promise((resolve, reject) => {
        web3.currentProvider.sendAsync({
            jsonrpc: "2.0",
            method: "evm_mine",
            id: new Date().getTime()
        }, (err, result) => {
            if (err) { return reject(err); }
            const newBlockHash = web3.eth.getBlock('latest').hash;
            return resolve(newBlockHash)
        });
    });
}

// pretty print a json result for debugging
pprint = (result) => {
    console.log(JSON.stringify(result, null, 4));
}

// Expected storage fees, must pass in non-decimal amount (int/bignum)
// and returns big number like truffle test invocations 
function calcStorageFee(balance, daysSincePaidStorage, daysSinceActivity=0) {
    // Specifically using BigNumber here just for decimal precision
    let amount = new BigNumber(balance);

    // Only pay storge fee up to when inactive threshold is activated
    if (daysSinceActivity >= INACTIVE_THRESHOLD_DAYS) {
        daysSincePaidStorage = daysSincePaidStorage - (daysSinceActivity - INACTIVE_THRESHOLD_DAYS);
    }

    let days_at_rate = new BigNumber((daysSincePaidStorage/365.0).toString());

    let fee = amount.times(days_at_rate).times(0.0025);
    if (amount.minus(fee).toNumber() < 0) {
        return new BN(amount.toFixed(0));
    }
    return new BN(fee.toFixed(0));
}

// Expected inactive fees, must pass in non-decimal amount (int/bignum)
// and returns big number like truffle test invocations 
function calcInactiveFee(currentBalance, daysInactive, snapshotBalance, paidAlready) {
    let balance = new BigNumber(currentBalance);
    let snapshot = new BigNumber(snapshotBalance);
    let inactive = new BigNumber(daysInactive);
    
    // 50 bps or 1 token minimum per year
    let perYear = snapshot.times(0.005);
    if (perYear.minus(TOKEN.toNumber()) <= 0.0) {
        perYear = new BigNumber(TOKEN.toNumber());
    }

    // And get prorated amount due after daysInactive
    owed = perYear.times(inactive.minus(INACTIVE_THRESHOLD_DAYS).div(365.0)).minus(paidAlready);

    if (owed.gt(balance)) {
        return new BN(balance.toFixed(0));
    }

    return new BN(owed.toFixed(0));
}

// Calculate the maximum you could send given the transfer
// basis points and current balance
function calcSendAllBalance(transferBasisPoints, balance) {
    let amount = new BigNumber(balance);
    let transferFeeDecimal = (new BigNumber(transferBasisPoints)).div(10000);
    let divisor = transferFeeDecimal.plus(1);

    // Add a round up to near-est int
    let sendAll = new BigNumber(amount.div(divisor).plus(1).toFixed(0))

    // Now see the transfer fee on that amount
    let transferFee = new BigNumber(sendAll.times(transferFeeDecimal).toFixed(0));

    // Now if the sendAll + transferFee would be greater than balance, subtract 1 from sendAll
    // to fix rounding result
    if (sendAll.plus(transferFee).gt(balance)) {
        sendAll = sendAll.minus(1);
    }
    return new BN(sendAll.toFixed(0))
}

// ------------- Start Test Code --------- //


/*
 * The Mega Ultra Long CacheGold test suite has a lot of redundant tests, but
 * each test case is targeting something specific
 */
contract('CacheGold', function(accounts) {

    console.log("\nAll tests take about 1 minute to complete. Please be patient...");

    // Set up some account info
    const owner = accounts[0];
    const enforcer = owner
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
    var locked_oracle;
    beforeEach(async function() {
      // Make oracle and let the supply be huge
      locked_oracle = await LockedGoldOracle.new();
      await locked_oracle.lockAmount(SUPPLY_LIMIT);
      return CacheGold.new(unbacked_addr,
                           backed_addr,
                           fee_addr,
                           redeem_addr,
                           locked_oracle.address).then(async(inst) => {
        instance = inst;
        await locked_oracle.setCacheContract(instance.address);
      });
    });

    // Make sure total supply is consistent with balances of all accounts
    // WARNING - Not using big number precision, so could have error
    async function assertTotals(instance) {
        let totalSupply = await instance.totalSupply();

        // Sum balance of all accounts
        let actualSupply = new BN(0);
        for (let account of accounts) {
            actualSupply = actualSupply.add(await instance.balanceOfNoFees(account));
        }
        //console.log("Total supply is " + totalSupply + " calculated " + actualSupply);
        assert(totalSupply.eq(actualSupply));
    }

    // Just make sure non-owners can't call protected functions
    it("Test onlyOwner protection", async function () {
       await truffleAssert.reverts(instance.setFeeAddress(fee_addr, {'from': external1}));
       await truffleAssert.reverts(instance.setRedeemAddress(fee_addr, {'from': external1}));
       await truffleAssert.reverts(instance.setBackedAddress(fee_addr, {'from': external1}));
       await truffleAssert.reverts(instance.setUnbackedAddress(fee_addr, {'from': external1}));
       await truffleAssert.reverts(instance.setFeeExempt(external1, {'from': external1}));
       await truffleAssert.reverts(instance.setFeeEnforcer(external1, {'from': external1}));
       await truffleAssert.reverts(instance.unsetFeeExempt(external1, {'from': external1}));
       await truffleAssert.reverts(instance.setOracleAddress(external1, {'from': external1}));
       await truffleAssert.reverts(instance.setStorageFeeGracePeriodDays(10, {'from': external1}));
       await truffleAssert.reverts(instance.setTransferFeeBasisPoints(10, {'from': external1}));
       await truffleAssert.reverts(instance.transferOwnership(external1, {'from': external1}));
       await truffleAssert.reverts(instance.addBackedTokens(TOKEN, {'from': external1}));
    });

    // Only one account is allowed to force paying storage / late fees and it is different
    // from the contract owner, who is going to be a multisig address. We want a single 
    // key address for this so it can make signing transactions in a script without
    // interaction from other multisig participants
    it("Test onlyEnforcer protection", async function () {
        await instance.addBackedTokens(TOKEN);
        await instance.transfer(external1, TOKEN, {'from': backed_addr});
        await advanceTimeAndBlock(366*DAY);
        await truffleAssert.reverts(instance.forcePayFees(external1, {'from': external1}));
        // and enforcer won't fail
        await instance.forcePayFees(external1, {'from': enforcer});

        // Check enforcement on inactive fees
        await advanceTimeAndBlock(365*10*DAY);
        await truffleAssert.reverts(instance.forcePayFees(external1, {'from': external1}));
        await instance.forcePayFees(external1, {'from': enforcer});
    });

    // The LockedGoldOracle prevents minting over a certain amount
    it("Test LockedGoldOracle minting rules",  async function () {
        // Assert pointing to right contract
        let contract = await locked_oracle.cacheContract();
        assert(contract === instance.address);

        // Get amount of gold current locked
        let lockedGold = await locked_oracle.lockedGold();

        // Change it to 1000 grams
        await locked_oracle.unlockAmount(lockedGold.sub(new BN(1000).mul(TOKEN)));

        // Now ensure mint fails on 2000 grams
        await truffleAssert.reverts(instance.addBackedTokens(2000*TOKEN));

        // Minting 1000 is okay
        await instance.addBackedTokens(1000*TOKEN)

        // Now ensure minting 1 more fails
        await truffleAssert.reverts(instance.addBackedTokens(1));
    });

    // Test initialization of addresses for owner / treasury / fee collection
    it("Test setting correct owner and internal addresses", async function () {
        // Change fee address and verify
        assert(await instance.setFeeAddress(fee_addr));
        let new_fee_address = await instance.feeAddress();
        assert.equal(new_fee_address, fee_addr, "The fee address has changed");

        // Change redeem address and verify
        assert(await instance.setRedeemAddress(redeem_addr));
        let new_redeem_address = await instance.redeemAddress();
        assert.equal(new_redeem_address, redeem_addr, "The redeem address has changed");

        // Change backed address and verify
        assert(await instance.setBackedAddress(accounts[7]));
        let new_backed_address = await instance.backedTreasury();
        assert.equal(new_backed_address, accounts[7], "The backed address has changed");

        // Change unbacked address and verify
        assert(await instance.setUnbackedAddress(accounts[8]));
        let new_unbacked_address = await instance.unbackedTreasury();
        assert.equal(new_unbacked_address, accounts[8], "The unbacked address has changed");

        // Change the enforcer address
        assert(await instance.setFeeEnforcer(accounts[9]));
        let new_enforcer = await instance.feeEnforcer();
        assert.equal(new_enforcer, accounts[9], "The enforcer address has changed");

        // Change the oracle address
        assert(await instance.setOracleAddress(accounts[9]));
        let new_oracle = await instance.oracleAddress();
        assert.equal(new_oracle, accounts[9], "The oracle address has changed");

        // Assert these new addresses are set as fee exempt
        assert(await instance.isFeeExempt(accounts[7]));
        assert(await instance.isFeeExempt(accounts[8]));
        assert(await instance.isFeeExempt(accounts[9]));

        // Assert can't set to 0 address
        await truffleAssert.reverts(instance.setFeeAddress(zero_addr));
        await truffleAssert.reverts(instance.setBackedAddress(zero_addr));
        await truffleAssert.reverts(instance.setRedeemAddress(zero_addr));
        await truffleAssert.reverts(instance.setUnbackedAddress(zero_addr));
        await truffleAssert.reverts(instance.setFeeEnforcer(zero_addr));
        await truffleAssert.reverts(instance.setOracleAddress(zero_addr));

        // Can't set some addresses to each other
        await truffleAssert.reverts(instance.setFeeAddress(await instance.unbackedTreasury()));
        await truffleAssert.reverts(instance.setBackedAddress(await instance.unbackedTreasury()));
        await truffleAssert.reverts(instance.setRedeemAddress(await instance.unbackedTreasury()));
        await truffleAssert.reverts(instance.setUnbackedAddress(await instance.backedTreasury()));
        await truffleAssert.reverts(instance.setUnbackedAddress(await instance.feeAddress()));
        await truffleAssert.reverts(instance.setUnbackedAddress(await instance.redeemAddress()));
    });
    
    it("Test total supply and circulation", async function () {
        // Mint some starting tokens to backed treasury
        await instance.addBackedTokens(1250000*TOKEN);

        // Transfer some to unbacked and external
        await instance.transfer(unbacked_addr, TOKEN, {'from': backed_addr});
        await instance.transfer(external1, 2*TOKEN, {'from': backed_addr});

        let balance_unbacked = await instance.balanceOfNoFees(unbacked_addr);
        let balance_external = await instance.balanceOfNoFees(external1);
        let totalSupply = await instance.totalSupply();
        let totalCirculation = await instance.totalCirculation();

        assert.equal(totalSupply, 1250000*TOKEN);
        assert.equal(balance_external, 2*TOKEN);
        assert.equal(totalCirculation, totalSupply - balance_unbacked);
    });

    // Inherited from OpenZeppelin stuff
    it("Test approve methods",  async function () {
        await instance.addBackedTokens(1000*TOKEN)
        await instance.transfer(external1, 10*TOKEN, {'from': backed_addr});

        // Allow external 2 to transfer up to 2 tokens
        assert(await instance.approve(external2, 2*TOKEN, {'from': external1}));
        let approved = await instance.allowance(external1, external2);
        assert.equal(approved, 2*TOKEN);

        // Now do transfer to external 3
       assert(await instance.transferFrom(external1, external3, TOKEN, {'from': external2}));

        let balance1 = await instance.balanceOfNoFees(external1);
        let balance3 = await instance.balanceOfNoFees(external3);
        let expected1 = 10*TOKEN - TOKEN.toNumber() - TOKEN * DEFAULT_TRANSFER_FEE;
        let expected3 = TOKEN.toNumber();
        assert.equal(balance1, expected1, "Balance 1 is unexpected");
        assert.equal(balance3, expected3, "Balance 3 is unexpected");

        // Assert transfer more than approved fails
        await truffleAssert.reverts(instance.transferFrom(external1, external3, 3*TOKEN, {'from': external2}));

        // Now approve more
        assert(await instance.increaseAllowance(external2, TOKEN, {'from': external1}));
        approved = await instance.allowance(external1, external2);
        assert.equal(approved, 2*TOKEN);

        // And remove more
        assert(await instance.decreaseAllowance(external2, TOKEN, {'from': external1}));
        approved = await instance.allowance(external1, external2);
        assert.equal(approved, TOKEN.toNumber());

        // Can't approve on zero addr
        await truffleAssert.reverts(instance.approve(zero_addr, 2*TOKEN, {'from': backed_addr}));
        //await truffleAssert.reverts(instance.approve(external1, 2*TOKEN, {'from': zero_addr}));
        await truffleAssert.reverts(instance.increaseAllowance(zero_addr, 2*TOKEN, {'from': backed_addr}));
        await truffleAssert.reverts(instance.decreaseAllowance(zero_addr, 2*TOKEN, {'from': backed_addr}));
    });


    // Make sure transfer fees are properly calculated
    it("Test simple transfer fees", async function () {
        // Test a normal amount
        let transfer_amount = 51232134000;
        let expected_transfer_fee = Math.floor(transfer_amount * DEFAULT_TRANSFER_FEE);
        // Transfer of normal amount has correct fee
        let actual_fee = await instance.calcTransferFee(external1, transfer_amount);
        assert.equal(actual_fee, expected_transfer_fee, "The transfer fee is not correct");

        // Test an amount sub 1000 (fee should be 0)
        transfer_amount = 999;
        expected_transfer_fee = Math.floor(transfer_amount * DEFAULT_TRANSFER_FEE);
        // Transfer of normal amount has correct fee
        actual_fee = await instance.calcTransferFee(external1, transfer_amount);
        assert.equal(actual_fee, expected_transfer_fee, "The transfer fee is not correct");
    });

    // Test to make sure the storage fees are properly calculated
    it("Test correctly setting the storage fee", async function () {

        // Test all the edge cases on fees
        for (let day of [1, 128, 365, 366, 500, 730, 731, 900, 1095, 1096, 3000]) {
            for (let amount of [1, 50, 75, 100, 333, 1000, 3333, 10000, 100000]) {
                let expected_fee = calcStorageFee(TOKEN*amount, day);
                let actual_fee = await instance.storageFee(TOKEN*amount, day);
                assert(actual_fee.sub(expected_fee).abs().lt(new BN(1)),
                       "The storage fee is not correct on " + day + " days" + " with amount " + amount);
            }
        }

        // Now test some hand calculated fees

        // Test storage fee for 1 day
        let days_since_paid = 1;
        let balance = 8997100000000;
        let expected_fee = calcStorageFee(balance, days_since_paid);
        let actual_fee = await instance.storageFee(balance, days_since_paid);
        assert(actual_fee.sub(expected_fee).abs().lt(new BN(1)), "The storage fee is not correct on " + days_since_paid + " days");

        // Test storage fee for 128 days
        days_since_paid = 128;
        balance = 8997100000000;
        expected_fee = calcStorageFee(balance, days_since_paid);
        actual_fee = await instance.storageFee(balance, days_since_paid);
        assert(actual_fee.sub(expected_fee).abs().lt(new BN(1)), "The storage fee is not correct on " + days_since_paid + " days");

        // Test storage fee for 365 days
        days_since_paid = 365;
        balance = 8997100000000;
        expected_fee = calcStorageFee(balance, days_since_paid);
        actual_fee = await instance.storageFee(balance, days_since_paid);
        assert(actual_fee.sub(expected_fee).abs().lt(new BN(1)), "The storage fee is not correct on " + days_since_paid + " days");

        // Test storage fee for 366 day
        days_since_paid = 366;
        balance = 8997100000000;
        expected_fee = calcStorageFee(balance, days_since_paid);
        actual_fee = await instance.storageFee(balance, days_since_paid);
        assert(actual_fee.sub(expected_fee).abs().lt(new BN(1)), "The storage fee is not correct on " + days_since_paid + " days");

        // Test storage fee for 730
        days_since_paid = 730;
        balance = 8997100000000;
        expected_fee = calcStorageFee(balance, days_since_paid);
        actual_fee = await instance.storageFee(balance, days_since_paid);
        assert(actual_fee.sub(expected_fee).abs().lt(new BN(1)), "The storage fee is not correct on " + days_since_paid + " days");

        // Test storage fee for 731 days
        days_since_paid = 731;
        balance = 8997100000000;
        expected_fee = calcStorageFee(balance, days_since_paid);
        actual_fee = await instance.storageFee(balance, days_since_paid);
        assert(actual_fee.sub(expected_fee).abs().lt(new BN(1)), "The storage fee is not correct on " + days_since_paid + " days");

        // Test storage fee for 1095 days
        days_since_paid = 1095;
        balance = 8997100000000;
        expected_fee = calcStorageFee(balance, days_since_paid);
        actual_fee = await instance.storageFee(balance, days_since_paid);
        assert(actual_fee.sub(expected_fee).abs().lt(new BN(1)), "The storage fee is not correct on " + days_since_paid + " days");

        // Test storage fee for 1096 days
        days_since_paid = 1096;
        balance = 8997100000000;
        expected_fee = calcStorageFee(balance, days_since_paid);
        actual_fee = await instance.storageFee(balance, days_since_paid);
        assert(actual_fee.sub(expected_fee).abs().lt(new BN(1)), "The storage fee is not correct on " + days_since_paid + " days");
    });

    // Make sure minting rules only allow minting when the unbacked treasury is empty
    // and make sure the total are always correct
    it("Test minting of tokens ", async function () {
        // First mint of 5000 tokens should succeed.
        let toMint = 5000 * TOKEN;
        let mintResult = await instance.addBackedTokens(toMint);
        assert.equal(mintResult.logs[0].args.value, toMint, "Unable to mint tokens");
        let backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(backed_balance, toMint, "Incorrect balance");
        await assertTotals(instance);

        // Transfer 2500 tokens to the unbacked_addr should succeed
        let toTransfer = 2500 * TOKEN;
        let transferResult = await instance.transfer(unbacked_addr, toTransfer, {'from': backed_addr});
        assert.equal(transferResult.logs.length, 2);
        assert.equal(transferResult.logs[0].args.from, backed_addr);
        assert.equal(transferResult.logs[0].args.to, unbacked_addr);
        assert.equal(transferResult.logs[0].args.value, toTransfer);
        let unbacked_balance = await instance.balanceOfNoFees(backed_addr);
        backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(unbacked_balance, toTransfer, "Incorrect balance");
        assert.equal(backed_balance, toTransfer, "Incorrect balance");
        await assertTotals(instance);

        // Transfer all balance back to backed_addr should allow more minting
        transferResult = await instance.transfer(backed_addr, toTransfer, {'from': unbacked_addr});
        assert.equal(transferResult.logs.length, 1);
        assert.equal(transferResult.logs[0].args.from, unbacked_addr);
        assert.equal(transferResult.logs[0].args.to, backed_addr);
        assert.equal(transferResult.logs[0].args.value, toTransfer);
        backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(backed_balance, toMint, "Incorrect balance");
        await assertTotals(instance);

        // Should now be able to mint more tokens again
        let toMint2 = 10000 * TOKEN;
        let mintResult2 = await instance.addBackedTokens(toMint2);
        assert.equal(mintResult2.logs[0].args.value, toMint2, "Unable to mint tokens");
        unbacked_balance = await instance.balanceOfNoFees(unbacked_addr);
        backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(unbacked_balance, 0, "Incorrect balance");
        assert.equal(backed_balance, toMint + toMint2, "Incorrect balance");
        await assertTotals(instance);

        //
        // Now test out the compound mint function
        //

        // The first instance should only create new tokens since none
        // are in the unbacked treasury
        let backedTokensToAdd1 = 3000 * TOKEN;
        let addResult = await instance.addBackedTokens(backedTokensToAdd1);
        assert.equal(addResult.logs.length, 2);
        backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(backed_balance, toMint + toMint2 + backedTokensToAdd1, "Incorrect balance");

        // Now transfer 2000 tokens back to unbacked balance
        toTransfer = 2000 * TOKEN;
        transferResult = await instance.transfer(unbacked_addr, toTransfer, {'from': backed_addr});
        unbacked_balance = await instance.balanceOfNoFees(unbacked_addr);
        backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(unbacked_balance, toTransfer, "Incorrect balance");
        assert.equal(backed_balance, toMint + toMint2 + backedTokensToAdd1 - toTransfer, "Incorrect balance");
        await assertTotals(instance);

        // Adding 1000 backed tokens will only transfer from unbacked to backed treasury
        let backedTokensToAdd2 = 1000 * TOKEN;
        addResult = await instance.addBackedTokens(backedTokensToAdd2);
        // Make sure only 1 Transfer event
        assert.equal(addResult.logs.length, 2);
        backed_balance = await instance.balanceOfNoFees(backed_addr);
        unbacked_balance = await instance.balanceOfNoFees(unbacked_addr);
        assert.equal(unbacked_balance, toTransfer - backedTokensToAdd2, "Incorrect balance");
        assert.equal(backed_balance, toMint + toMint2 + backedTokensToAdd1 + backedTokensToAdd2 - toTransfer,
                     "Incorrect balance");
        await assertTotals(instance);

        // Now add 4000 more backed tokens and make sure it does a transfer and a mint event
        let backedTokensToAdd3 = 4000 * TOKEN;
        addResult = await instance.addBackedTokens(backedTokensToAdd3);
        // Make sure 2 Transfer events (unbacked -> backed, and mint)
        assert.equal(addResult.logs.length, 3);
        backed_balance = await instance.balanceOfNoFees(backed_addr);
        unbacked_balance = await instance.balanceOfNoFees(unbacked_addr);
        assert.equal(unbacked_balance, 0, "Incorrect balance");
        assert.equal(backed_balance, toMint + toMint2 + backedTokensToAdd1 + backedTokensToAdd2 - toTransfer + backedTokensToAdd3,
                     "Incorrect balance");
        await assertTotals(instance);

    });

    // Make sure no one can transfer tokens to the unbacked treasury
    it("Test transfer restrictions", async function () {
        // Mint some starting tokens to backed treasury
        await instance.addBackedTokens(15000*TOKEN);

        // Transfer from backed treasury to external account
        await instance.transfer(external1, 4000*TOKEN, {'from': backed_addr});
        external_balance = await instance.balanceOfNoFees(external1);
        assert.equal(external_balance, 4000*TOKEN, "Incorrect balance, bad transfer");

        // Transfer tokens to fee and redeem address
        await instance.transfer(fee_addr, 10*TOKEN, {'from': backed_addr});
        await instance.transfer(redeem_addr, 10*TOKEN, {'from': backed_addr});

        // Make sure external account cannot transfer to unbacked treasury
        await truffleAssert.reverts(instance.transfer(unbacked_addr, TOKEN, {'from': external1}));
        // Fee address cannot transfer to unbacked
        await truffleAssert.reverts(instance.transfer(unbacked_addr, TOKEN, {'from': fee_addr}));
        // Backed address can transfer to unbacked
        assert(await instance.transfer(unbacked_addr, TOKEN, {'from': backed_addr}));
        // Redeem address can transfer to unbacked
        assert(await instance.transfer(unbacked_addr, TOKEN, {'from': redeem_addr}));
        // Redeem address can transfer to backed
        assert(await instance.transfer(backed_addr, TOKEN, {'from': redeem_addr}));

        // Make sure unbacked treasury cannot transfer to external address
        await truffleAssert.reverts(instance.transfer(external1, TOKEN, {'from': unbacked_addr}));

        // Redeem can't transfer to external
        await truffleAssert.reverts(instance.transfer(external1, TOKEN, {'from': redeem_addr}));

        // unbacked treasury can transfer to backed treasury
        assert(await instance.transfer(backed_addr, TOKEN, {'from': unbacked_addr}));

        // External cannot transfer to backed
        await truffleAssert.reverts(instance.transfer(backed_addr, 1000*TOKEN, {'from': external1}));
        // Fee cannot transfer to backed
        await truffleAssert.reverts(instance.transfer(backed_addr, 1000*TOKEN, {'from': fee_addr}));

        // Cannot send to 0 address
        await truffleAssert.reverts(instance.transfer(zero_addr, TOKEN, {'from': external1}));

        // Cannt send from 0 address
        //await truffleAssert.reverts(instance.transfer(external1, TOKEN, {'from': zero_addr}));

        // Cannot send less than available balance
        await truffleAssert.reverts(instance.transfer(external2, 9000*TOKEN, {'from': external1}));

        await advanceTimeAndBlock(DAY);

        // Cannot transfer on exact balance if storage fees are due
        await truffleAssert.reverts(instance.transfer(external2, 4000*TOKEN, {'from': external1}));
    });

    // Test the cap on the token supply
    it("Test max cap on token supply", async function () {

        // Put locked gold amount over limit
        await locked_oracle.lockAmount(1000);

        // Minting too much fails
        await truffleAssert.reverts(instance.addBackedTokens(SUPPLY_LIMIT.add(new BN('1'))));

        // Mint some starting tokens to backed treasury
        let result = await instance.addBackedTokens(5000*TOKEN);
        let backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(backed_balance, 5000*TOKEN, "Incorrect balance");

        // Mint up to Supply CAP, should be fine
        let toMint = SUPPLY_LIMIT.sub(new BN(5000*TOKEN));
        await instance.addBackedTokens(toMint);
        backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert(backed_balance.eq(SUPPLY_LIMIT), "Incorrect balance");

        // Minting 1 more token should fail
        await truffleAssert.reverts(instance.addBackedTokens(1));

        // Transfer some tokens and make sure it still fails
        let toTransfer = new BN('41239415612341234');
        await instance.transfer(external1, toTransfer, {'from': backed_addr});
        external_balance = await instance.balanceOfNoFees(external1);
        assert(external_balance.eq(toTransfer), "Incorrect balance, bad transfer");

        // Minting 1 more token should fail
        await truffleAssert.reverts(instance.addBackedTokens(1));
    });

    // Test the storage fees can be foribly collected after 365 days
    it("Test force paying storage fees", async function () {
        // Mint some starting tokens to backed treasury
        let result = await instance.addBackedTokens(1250000*TOKEN);
        let backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(backed_balance, 1250000*TOKEN, "Incorrect balance");

        // Transfer them to external accounts
        await instance.transfer(external1, 1000*TOKEN, {'from': backed_addr});
        external_balance = await instance.balanceOfNoFees(external1);
        assert.equal(external_balance, 1000*TOKEN, "Incorrect balance, bad transfer");

        // Advance the block time a day and verify you can't force collect storage fees
        await advanceTimeAndBlock(DAY);
        await truffleAssert.reverts(instance.forcePayFees(external1));

        // Advance blocktime a year and force storage fee works
        await advanceTimeAndBlock(365*DAY);
        result = await instance.forcePayFees(external1);
        assert.equal(result.logs.length, 1);
        external_balance = await instance.balanceOfNoFees(external1);

        // Fee on 366 days is 30 basis points
        let expected_fee = calcStorageFee(1000*TOKEN, 366);
        let expected_balance = new BN(1000*TOKEN).sub(expected_fee);
        assert(external_balance.eq(expected_balance), "Incorrect balance, bad storage fee");

        // Assert fee address got correct balance
        let fee_address_balance = await instance.balanceOfNoFees(fee_addr);
        assert(fee_address_balance.eq(expected_fee), "Incorrect fee collection balance");

        // Trying to force pay on an overdue address with no fees refunds tx
        // Send 0.00000001 tokens to address
        await instance.transfer(external3, 1, {'from': backed_addr});
        await advanceTimeAndBlock(400*DAY);

        // Force pay will fail since there is no collectable fee
        await truffleAssert.reverts(instance.forcePayFees(external3));

        // Can't force pay on zero addr
        await truffleAssert.reverts(instance.forcePayFees(zero_addr));

        // Can't force pay on addr with no balance
        await truffleAssert.reverts(instance.forcePayFees(external2));
    });
    
    it("Test pay storage fees", async function () {

        // Mint some starting tokens to backed treasury
        let result = await instance.addBackedTokens(1250000*TOKEN);
        let backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(backed_balance, 1250000*TOKEN, "Incorrect balance");

        // Transfer them to external accounts
        let initialBalance1 = 100000 * TOKEN;
        await instance.transfer(external1, initialBalance1, {'from': backed_addr});
        external_balance = await instance.balanceOfNoFees(external1);
        assert.equal(external_balance, initialBalance1, "Incorrect balance, bad transfer");

        // Assert no storage fee immediately after transfer
        let daysSincePaidStorageFee = await instance.daysSincePaidStorageFee(external1);
        assert.equal(daysSincePaidStorageFee, 0);
        let storage_fee_expected = await instance.calcStorageFee(external1);
        assert.equal(storage_fee_expected, 0);

        // Test paying once per every 30 days, 12 mul
        for (let i=0; i < 12; i++) {
            //console.log("Paying Storage Fee for Month " + (i+1))
            await advanceTimeAndBlock(DAY*30);
            result = await instance.payStorageFee({'from': external1});
            // assert always a transfer in the tx
            assert.equal(result.logs.length, 1);
        }
        external_balance = await instance.balanceOfNoFees(external1);
        let fee_balance = await instance.balanceOfNoFees(fee_addr);

        // There can be some floating point error, but based on other calcs should be similar
        // to the values below
        assert.equal(external_balance.add(fee_balance).toNumber(), 100000 * TOKEN);

        // Make sure all the accounts add up to total still
        await assertTotals(instance);

        // Calculated from python program
        let expected_balance = new BN('9975370313074')
        let expected_fees = new BN('24629686932')

        // Allow error of up to 0.00000100 tokens
        assert(external_balance.sub(expected_balance).abs().lt(new BN(100)));
        assert(fee_balance.sub(expected_fees).abs().lt(new BN(100)));

        // Now transfer less than token to external2 and test storage fees
        // for small amounts
        let initialBalance2 = new BN(0.99 * TOKEN);
        await instance.transfer(external2, initialBalance2, {'from': backed_addr});

        // Make sure all the accounts add up to total still
        await assertTotals(instance);

        // Make sure daysSincePaidStorageFee and calcStorageFee is 0 for 
        // account that has never received coins
        daysSincePaidStorageFee = await instance.daysSincePaidStorageFee(external3);
        assert.equal(daysSincePaidStorageFee, 0);
        storageFee = await instance.calcStorageFee(external3);
        assert.equal(storageFee, 0);
    });
    
    it("Test storage fee grace period is saved per address", async function() {
        // Mint some starting tokens to backed treasury
        await instance.addBackedTokens(15000*TOKEN);

        // Transfer from backed treasury to external account
        await instance.transfer(external1, 4000*TOKEN, {'from': backed_addr});
        let external_balance = await instance.balanceOfNoFees(external1);
        assert.equal(external_balance, 4000*TOKEN, "Incorrect balance, bad transfer");

        // Assert storgae fee grace period is 0
        let storageFeeGracePeriod = await instance.storageFeeGracePeriodDays();
        assert.equal(storageFeeGracePeriod, 0);

        // Change it to 30 days
        await instance.setStorageFeeGracePeriodDays(30);
        storageFeeGracePeriod = await instance.storageFeeGracePeriodDays();
        assert.equal(storageFeeGracePeriod, 30);

        // Now perform a transfer to another external address
        await instance.transfer(external2, 4000*TOKEN, {'from': backed_addr});
        external_balance = await instance.balanceOfNoFees(external2);
        assert.equal(external_balance, 4000*TOKEN, "Incorrect balance, bad transfer");

        // Advance 30 days
        await advanceTimeAndBlock(DAY*30);

        // External 1 address should have 30 days worth of storage fees
        // owed, because that was what was set when the transfer
        // was received, while External 2 should have no fee set, because
        // the transfer happened after the storage fee was changed
        let storageFee1 = await instance.calcStorageFee(external1);
        assert(storageFee1.gt(0));
        let storageFee2 = await instance.calcStorageFee(external2);
        assert(storageFee2.eq(new BN(0)));

        // Changing grace period to 15 days should not affect the
        // grace period of external1 or external2
        await instance.setStorageFeeGracePeriodDays(15);
        let storageFee1After = await instance.calcStorageFee(external1);
        let storageFee2After = await instance.calcStorageFee(external2);
        assert(storageFee1.eq(storageFee1After));
        assert(storageFee2.eq(storageFee2After));

        // Now pay the storage fee, assert it's zero after
        await instance.payStorageFee({'from': external1});
        storageFee = await instance.calcStorageFee(external1);
        assert(storageFee.eq(new BN(0)));

        // Advance 5 days and assert that both addresseses now
        // have to pay storage fees, because their initial period is over
        await advanceTimeAndBlock(DAY*5);
        storageFee1 = await instance.calcStorageFee(external1);
        assert(storageFee1.gt(new BN(0)));
        storageFee2 = await instance.calcStorageFee(external2);
        assert(storageFee2.gt(new BN(0)));

        // Pay storage fee on external2 and make sure grace period doesn't restart
        await instance.payStorageFee({'from': external2});
        // Advance 15 days
        await advanceTimeAndBlock(DAY*15);
        storageFee = await instance.calcStorageFee(external2);
        assert(storageFee.gt(new BN(0)));

    });

    // Make sure there are no transfer or storage fees on protected addresses
    it("Test there are no transfer and storage fees on internal accounts", async function () {

        // Mint some starting tokens to backed treasury
        let result = await instance.addBackedTokens(1250000*TOKEN);
        let backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(backed_balance, 1250000*TOKEN, "Incorrect balance");
        let fee_balance = await instance.balanceOfNoFees(fee_addr);
        assert.equal(fee_balance, 0, "Should not collect fees");

        // Send tokens to unbacked treasury and assert no fees
        await instance.transfer(unbacked_addr, TOKEN, {'from': backed_addr});
        let unbacked_balance = await instance.balanceOfNoFees(unbacked_addr);
        fee_balance = await instance.balanceOfNoFees(fee_addr);
        assert.equal(fee_balance, 0, "Should not collect fees");

        // Send tokens to contract owner and assert no fees
        await instance.transfer(owner, TOKEN, {'from': backed_addr});
        fee_balance = await instance.balanceOfNoFees(fee_addr);
        assert.equal(fee_balance, 0, "Should not collect fees");

        // Send tokens from owner to redeem addr and assert no fees
        await instance.transfer(redeem_addr, TOKEN, {'from': owner});
        fee_balance = await instance.balanceOfNoFees(fee_addr);
        assert.equal(fee_balance, 0, "Should not collect fees");

        // Fill all addresses again
        await instance.transfer(fee_addr, TOKEN, {'from': backed_addr});
        await instance.transfer(owner, TOKEN, {'from': backed_addr});
        await instance.transfer(unbacked_addr, TOKEN, {'from': backed_addr});

        // Move chain forward
        await advanceTimeAndBlock(DAY*90);

        // Make sure storage fee calculation on all addresses is 0
        let storageFee = await instance.calcStorageFee(owner);
        assert.equal(storageFee, 0, "Bad storage fee for owner");
        storageFee = await instance.calcStorageFee(backed_addr);
        assert.equal(storageFee, 0, "Bad storage fee for backed addr");
        storageFee = await instance.calcStorageFee(unbacked_addr);
        assert.equal(storageFee, 0, "Bad storage fee for unbacked addr");
        storageFee = await instance.calcStorageFee(fee_addr);
        assert.equal(storageFee, 0, "Bad storage fee for fee addr");

        // Transfer to external address
        await instance.transfer(external1, TOKEN, {'from': backed_addr});
        await advanceTimeAndBlock(DAY*90);

        // Assert the storage fee is greater than 0
        assert((await instance.calcStorageFee(external1)) > 0, "Bad storage fee for external1");

        // Exempt the address and assert fees are back to 0
        await instance.setFeeExempt(external1);
        assert.equal((await instance.calcStorageFee(external1)), 0, "Bad storage fee for external1");

        // Unexempt and turn fees back on
        await instance.unsetFeeExempt(external1);
        assert((await instance.calcStorageFee(external1)) > 0, "Bad storage fee for external1");

    });

    it("Test storage and transfer fees on real looking transfers", async function () {

        // Mint some starting tokens to backed treasury
        let result = await instance.addBackedTokens(1250000*TOKEN);
        let backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(backed_balance, 1250000*TOKEN, "Incorrect balance");

        // Distribute tokens to external accounts
        await instance.transfer(external1, 10*TOKEN, {'from': backed_addr});
        await instance.transfer(external2, 20*TOKEN, {'from': backed_addr});
        await instance.transfer(external3, 30*TOKEN, {'from': backed_addr});

        // Assert no storage fees yet
        assert.equal(await instance.calcStorageFee(external1), 0, "Unexpected storage fee");
        assert.equal(await instance.calcStorageFee(external2), 0, "Unexpected storage fee");
        assert.equal(await instance.calcStorageFee(external3), 0, "Unexpected storage fee");

        // Initially start with 0 storage fee and only transfer fee
        // sending 5 tokens from account 1 to account 2
        result = await instance.transfer(external2, 5*TOKEN, {'from': external1});
        // Two transfer events occured (the regular transfer and the fee)
        assert.equal(result.logs.length, 2);
        let external1_balance = await instance.balanceOfNoFees(external1);
        let external2_balance = await instance.balanceOfNoFees(external2);
        let fee_balance = await instance.balanceOfNoFees(fee_addr);
        let expected_fee = (5*TOKEN)*0.001;
        let expected_balance1 = 10*TOKEN - 5*TOKEN - expected_fee;

        // External2 account should just receive the full balance
        assert.equal(external2_balance, 25*TOKEN, "External 2 did no receive full balance");
        // External1 has sent amount - transfer fee
        assert.equal(external1_balance, expected_balance1, "External 1 balance not expected");
        // And fee addr just collected fees
        assert.equal(fee_balance, expected_fee, "Fee balance not expected");

        // Advance the chain 90 days and then transfer from account 2 to account 3
        // which should cause transfer and storage fee on full balance of 25 tokens
        // to trigger and a transfer fee on the 10 tokens being transferred
        //
        // Account 3 receiving should trigger a storage fee on the original 30 tokens
        await advanceTimeAndBlock(DAY*90);

        // Calculated expected storage fees beforehand to make sure consistent from those
        // actually applied
        let calc_stor_fee_2 = await instance.calcStorageFee(external2);
        let calc_stor_fee_3 = await instance.calcStorageFee(external3);
        let expected_storage_fee_2 = calcStorageFee(25*TOKEN, 90);
        let expected_storage_fee_3 = calcStorageFee(30*TOKEN, 90);
        assert(calc_stor_fee_2.eq(expected_storage_fee_2), "Storage fee incorrect for external 2");
        assert(calc_stor_fee_3.eq(expected_storage_fee_3), "Storage fee incorrect for external 3");

        // Now do the transfer
        result = await instance.transfer(external3, 10*TOKEN, {'from': external2});
        // Should trigger 3 transfer events.
        // From account 2 -> 3
        // From account 2 -> fee address
        // From account 3 -> fee address
        assert.equal(result.logs.length, 3);
        external2_balance = await instance.balanceOfNoFees(external2);
        let external3_balance = await instance.balanceOfNoFees(external3);
        let fee_balance_new = await instance.balanceOfNoFees(fee_addr);
        let expected_transfer_fee = (10*TOKEN) * 0.001;
        let expected_new_fee_balance = (expected_fee +
                                        expected_storage_fee_2.toNumber() +
                                        expected_storage_fee_3.toNumber() +
                                        expected_transfer_fee);
        expected_balance2 = Math.floor(25*TOKEN - 10*TOKEN - expected_storage_fee_2 - expected_transfer_fee);
        expected_balance3 = Math.floor(30*TOKEN + 10*TOKEN - expected_storage_fee_3);
        assert.equal(external2_balance, expected_balance2,  "External 2 balance not expected");
        assert.equal(external3_balance, expected_balance3,  "External 3 balance not expected");
        assert.equal(fee_balance_new, expected_new_fee_balance, "Fee balance not expected");

        // Verify transferring to backed treasury only induces fees for the sender
        await advanceTimeAndBlock(DAY*90);

        // Verify expected storage fee
        calc_stor_fee_3 = await instance.calcStorageFee(external3);
        expected_storage_fee_3 = calcStorageFee(expected_balance3, 90);
        assert(calc_stor_fee_3.eq(expected_storage_fee_3), "Storage fee incorrect for external 3");

        // Exec transfer
        result = await instance.transfer(redeem_addr, 10*TOKEN, {'from': external3});
        assert.equal(result.logs.length, 2);
        external3_balance = await instance.balanceOfNoFees(external3);
        fee_balance_new = await instance.balanceOfNoFees(fee_addr);
        redeem_balance = await instance.balanceOfNoFees(redeem_addr);

        // Calc expected values
        expected_transfer_fee = Math.floor(10*TOKEN * 0.001);
        expected_balance3 = Math.floor(expected_balance3 -
                                       10*TOKEN -
                                       expected_storage_fee_3.toNumber() -
                                       expected_transfer_fee);
        expected_new_fee_balance = expected_new_fee_balance + expected_storage_fee_3.toNumber() + expected_transfer_fee;

        // Still good!
        assert.equal(external3_balance, expected_balance3,  "External 3 balance not expected");
        assert.equal(fee_balance_new, expected_new_fee_balance, "Fee balance not expected");
        assert.equal(redeem_balance, 10*TOKEN, "Redeem addr balance not expected");
    });

    it("Test simulate transfers", async function () {

        // Mint some starting tokens to backed treasury
        let result = await instance.addBackedTokens(1250000*TOKEN);
        let backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(backed_balance, 1250000*TOKEN, "Incorrect balance");

        // Distribute tokens to external accounts
        await instance.transfer(external2, 20*TOKEN, {'from': backed_addr});
        await instance.transfer(external3, 30*TOKEN, {'from': backed_addr});

        // Advance the chain 90 days and then simulate transfer from account 2 to account 3
        // which should cause transfer and storage fee on full balance of 25 tokens
        // to trigger and a transfer fee on the 10 tokens being transferred
        //
        // Account 3 receiving should trigger a storage fee on the original 30 tokens
        await advanceTimeAndBlock(DAY*90);

        // Calculated expected storage fees beforehand to make sure consistent from those
        // actually applied
        let expected_storage_fee_2 = calcStorageFee(20*TOKEN, 90);
        let expected_storage_fee_3 = calcStorageFee(30*TOKEN, 90);
        let expected_transfer_fee = (10*TOKEN) * 0.001;
        let expected_balance2 = Math.floor(20*TOKEN -
                                           10*TOKEN -
                                           expected_storage_fee_2.toNumber() -
                                           expected_transfer_fee);

        let expected_balance3 = Math.floor(30*TOKEN +
                                           10*TOKEN -
                                           expected_storage_fee_3.toNumber());

        // Simulate transfer
        result = await instance.simulateTransfer(external2, external3, 10*TOKEN);
        assert(result[0].eq(expected_storage_fee_2), "External 2 storage fee not expected");
        assert(result[1].eq(expected_storage_fee_3), "External 3 storage fee not expected");
        assert.equal(result[2], expected_transfer_fee, "External 2 transfer fee not expected");
        assert.equal(result[3], expected_balance2, "External 2 balance not expected");
        assert.equal(result[4], expected_balance3, "External 3 balance not expected");

        // Test simulate transfer to self to pay storage fee
        result = await instance.simulateTransfer(external2, external2, 10*TOKEN);
        expected_balance2 = Math.floor(20*TOKEN - expected_storage_fee_2.toNumber());
        assert(result[0].eq(expected_storage_fee_2), "External 2 storage fee not expected");
        assert.equal(result[1].toNumber(), 0, "Storage fee to self not expected");
        assert.equal(result[2].toNumber(), 0, "Transfer fee to self not expected");
        assert.equal(result[3], expected_balance2, "External 2 balance not expected");
        assert.equal(result[4], expected_balance2, "External 2 balance not expected");

        // Make sure simulate more than balance fails
        await truffleAssert.reverts(instance.simulateTransfer(external2, external3, 100*TOKEN));
    });

    // There should only be a storage fee and no transfer fee when
    // sending coins to self
    it("Test no transfer fee when sending to self", async function () {

        // Mint some starting tokens to backed treasury
        let result = await instance.addBackedTokens(1250000*TOKEN);
        let backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(backed_balance, 1250000*TOKEN, "Incorrect balance");

        // Distribute tokens to external accounts
        await instance.transfer(external1, 10*TOKEN, {'from': backed_addr});

        // Move 555 days into the future
        await advanceTimeAndBlock(DAY*555);

        let expected_fee = calcStorageFee(10*TOKEN, 555);
        let calc_fee = await instance.calcStorageFee(external1);
        assert(calc_fee.sub(expected_fee).abs().lt(new BN(1)), "The storage fee is not correct on 555 days");

        // Have user transfer to self to trigger storage fee, but excluding transfer fee
        await instance.transfer(external1, 5*TOKEN, {'from': external1});
        let external_balance = await instance.balanceOfNoFees(external1);
        let expected_balance = (10*TOKEN - expected_fee);
        assert.equal(external_balance, expected_balance);

        // Move 666 days into the future
        await advanceTimeAndBlock(DAY*666);

        // Make sure calculated fee is expected
        expected_fee = calcStorageFee(external_balance, 666);
        calc_fee = await instance.calcStorageFee(external1);
        assert(calc_fee.sub(expected_fee).abs().lte(new BN(1)), "The storage fee is not correct on 666 days");

        // Make sure you can 0 transfer to yourself and pay storage fee
        await instance.transfer(external1, 0, {'from': external1});
        external_balance = await instance.balanceOfNoFees(external1);
        expected_balance = (expected_balance - expected_fee);
        assert(calc_fee.sub(expected_fee).abs().lte(new BN(1)), "The storage fee is not correct on 666 days");
    });

    it("Test reset storage fee clock on small amounts", async() => {
        await instance.addBackedTokens(10*TOKEN)
        await instance.transfer(external1, TOKEN, {'from': backed_addr});

        // Get max sendable balance of external1
        let sendable = await instance.balanceOf(external1);

        // Send all but 10 tokens to an another address
        await instance.transfer(external2, sendable.sub(new BN(10)), {'from': external1});

        // Advance the blockchain one year
        await advanceTimeAndBlock(365*DAY);

        // The storage fee after 1 year should still be 0 because the balance is so small
        let storageFee = await instance.calcStorageFee(external1);
        assert(storageFee.eq(new BN(0)));
 
        // If receiving new tokens, it should reset the storage fee clock because
        // we don't want a persist an unpaid storage fee on negligible amounts
        await instance.transfer(external1, TOKEN, {'from': backed_addr});

        // Assert days since paid reset to 0 even though no storage fee was really paid
        let daysSincePaid = await instance.daysSincePaidStorageFee(external1);
        assert(daysSincePaid.eq(new BN(0)));
    });
    
    it("Test fees with dust amounts", async() => {
        await instance.addBackedTokens(1000*TOKEN)

        // Send 0.00000010 tokens to address and see how it affects 
        // storage and transfer fee
        await instance.transfer(external1, 10, {'from': backed_addr});
        await instance.transfer(external2, 1000, {'from': backed_addr});

        // Assert transfer fee on 0.00000005 tokens is 0
        transfer_fee =  await instance.calcTransferFee(external1, 5);
        assert(transfer_fee.eq(new BN(0)));
        
        // Assert transfer fee on 0.00000999 is 0
        transfer_fee =  await instance.calcTransferFee(external2, 999);
        assert(transfer_fee.eq(new BN(0)));
        
        // Assert transfer fee on 0.00001000 is 0.00000001 token
        transfer_fee =  await instance.calcTransferFee(external2, 1000);
        assert(transfer_fee.eq(new BN(1)));

        // Advance a year
        await advanceTimeAndBlock(365*DAY);

        // Assert storage fees on 0.00000010 is 0
        storage_fee = await instance.calcStorageFee(external1);
        assert(storage_fee.eq(new BN(0)));
        
        // Assert storage fee on 0.00001000 is rounded down to 0.00000002
        // (fee is 25 basis points)
        storage_fee = await instance.calcStorageFee(external2);
        assert(storage_fee.eq(new BN(2)));
        
        // Advance a year
        await advanceTimeAndBlock(365*DAY);

        // Assert storage fee on 0.00001000 for 2 years is 0.00000005
        // (fee is 25 basis points)
        storage_fee = await instance.calcStorageFee(external2);
        assert(storage_fee.eq(new BN(5)));

        // Make sure sendAllAmount is expected
        send_all_amount = await instance.calcSendAllBalance(external2);
        send_all_calc = calcSendAllBalance(10, 995);
        assert(send_all_amount.eq(send_all_calc));

    });

    it("Test inactive fees", async() => {
        await instance.addBackedTokens(5000*TOKEN)
        await instance.transfer(external1, 2000*TOKEN, {'from': backed_addr});
        
        // At a day before INACTIVE_THRESHOLD_DAYS there should be no inactive fees
        await advanceTimeAndBlock((INACTIVE_THRESHOLD_DAYS - 1) * DAY);
        inactiveFee = await instance.calcInactiveFee(external1);
        assert(inactiveFee.eq(new BN(0)));

        // At INACTIVE_THRESHOLD_DAYS, you can mark the account inactive and 
        // it will record the snapshot balance
        await advanceTimeAndBlock(DAY);

        // The storage fee should be 25 bps on 3 years, for 2000 tokens this is
        // 5 tokens, leaving balance of 1975
        storageFee = await instance.calcStorageFee(external1);
        storageFeeCalc = calcStorageFee(2000*TOKEN, INACTIVE_THRESHOLD_DAYS);
        assert(storageFee.eq(storageFeeCalc));

        await truffleAssert.reverts(instance.setAccountInactive(external1, {'from': backed_addr}));
        await instance.setAccountInactive(external1);

        // After setting account inactive the storage fee should be paid, with balance
        // deducted and storage fee reset to day
        balance = await instance.balanceOfNoFees(external1);
        assert(balance.eq(new BN(2000*TOKEN).sub(storageFee)));
        storageFee = await instance.calcStorageFee(external1);
        assert(storageFee.eq(new BN(0)));
        
        // Inactive fee should still be 0 on first day marked inactive
        inactiveFee = await instance.calcInactiveFee(external1);
        assert.equal(inactiveFee.toNumber(), 0);

        // Move forward one year and...
        // 1. The storage fee should still be 0
        // 2. The days since paid storage fee should be 0
        // 3. The inactive fee should be 50 basis points on 1095 tokens, which is 5.475 tokens
        await advanceTimeAndBlock(DAY*365);

        // The account should show 6 years of inactivity
        daysInactive = await instance.daysSinceActivity(external1);
        assert(daysInactive.eq(new BN(INACTIVE_THRESHOLD_DAYS+365)));

        // Inactive fee should be on one year of inactivity
        inactiveFee = await instance.calcInactiveFee(external1);
        inactiveFeeCalc = calcInactiveFee(balance, INACTIVE_THRESHOLD_DAYS + 365, balance, 0);
        assert(inactiveFee.eq(inactiveFeeCalc));

        // Storage fee should still be zero
        storageFee = await instance.calcStorageFee(external1);
        assert(storageFee.eq(new BN(0)));

        // Assert non-fee enforcer can't force collection
        await truffleAssert.reverts(instance.forcePayFees(external1, {'from': backed_addr}));

        // Collect inactive fee
        await instance.forcePayFees(external1);
        external_balance = await instance.balanceOfNoFees(external1);
        expected_balance = balance.sub(inactiveFee);
        assert(external_balance.eq(expected_balance));

        // Now inactive fee owed should be 0
        inactiveFee = await instance.calcInactiveFee(external1);
        assert(inactiveFee.eq(new BN(0)));
        
        // Advance 199 more years should just show remaining balance
        await advanceTimeAndBlock(365*199*DAY);
        inactiveFee = await instance.calcInactiveFee(external1);
        assert(inactiveFee.eq(external_balance));

        // Now pay and assert totals
        await instance.forcePayFees(external1);
        external_balance = await instance.balanceOfNoFees(external1);
        assert.equal(external_balance.toNumber(), 0);
        fee_balance = await instance.balanceOfNoFees(fee_addr);
        assert.equal(fee_balance.toNumber(), 2000*TOKEN);
        inactiveFee = await instance.calcInactiveFee(external1);
        assert(inactiveFee.eq(new BN(0)));

        // Assert can't pay inactive fees on zero address
        await truffleAssert.reverts(instance.forcePayFees(zero_addr));

        // Assert can't force paying inactive fees on address with no balance
        await truffleAssert.reverts(instance.forcePayFees(external3));

        // Assert can't set account inactive early
        await instance.transfer(external3, 1000*TOKEN, {'from': backed_addr});
        await truffleAssert.reverts(instance.setAccountInactive(external3));
        
        // Assert fee exempt address can't be marked inactive
        await advanceTimeAndBlock(INACTIVE_THRESHOLD_DAYS * DAY);
        await truffleAssert.reverts(instance.setAccountInactive(backed_addr));

        // Can now pay fees on external3
        await instance.forcePayFees(external3);

        // Second call should refund gas since no fees are due
        await truffleAssert.reverts(instance.forcePayFees(external3));
    });

    it("Test advanced inactive fees and reactivation", async() => {
        await instance.addBackedTokens(5000*TOKEN)
        await instance.transfer(external1, 2000*TOKEN, {'from': backed_addr});
        
        // At INACTIVE_THRESHOLD_DAYS + 1 year, 
        // can force collect storage fees and inactive fees
        await advanceTimeAndBlock((INACTIVE_THRESHOLD_DAYS + 365) * DAY );
        inactiveFee = await instance.calcInactiveFee(external1);
        snapshotBalance = new BN(2000*TOKEN).sub(calcStorageFee(2000*TOKEN, INACTIVE_THRESHOLD_DAYS));
        inactiveFeeCalc = calcInactiveFee(snapshotBalance,
                                          INACTIVE_THRESHOLD_DAYS + 365,
                                          snapshotBalance,
                                          0);
        assert(inactiveFee.eq(inactiveFeeCalc));
        storageFee = await instance.calcStorageFee(external1);
        storageFeeCalc = calcStorageFee(2000*TOKEN, INACTIVE_THRESHOLD_DAYS);
        assert(storageFee.eq(storageFeeCalc));

        // Collect that inactive fee and verify ending balances are expected
        // 2000 * TOKEN - storage fee for INACTIVE_THRESHOLD_DAYS - inactive fee for 1 year
        await instance.forcePayFees(external1);
        external_balance = await instance.balanceOfNoFees(external1);
        expected_balance = new BN(2000*TOKEN).sub(storageFeeCalc).sub(inactiveFeeCalc);
        assert(external_balance.eq(expected_balance));

        // Advance two years. 
        await advanceTimeAndBlock(365*2*DAY);

        // 1. The storage fee should still be zero
        storageFee = await instance.calcStorageFee(external1);
        assert(storageFee.eq(new BN(0)));

        // 2. The inactive fee should be 50 bps on snapshotBalance for two years,
        // which is 1.0% (or divide by 100)
        inactiveFee = await instance.calcInactiveFee(external1);
        inactiveFeeCalc = snapshotBalance.div(new BN(100));
        assert(inactiveFee.eq(inactiveFeeCalc));

        // 3. The sendAllBalance function should report this correctly
        // balance - owed inactive fees - transfer fee 
        sendAll = await instance.calcSendAllBalance(external1)
        expectedSendAll =  new BigNumber(external_balance.sub(inactiveFee).toString()).div(1.001).toFixed(0);
        assert(sendAll.sub(new BN(expectedSendAll)).abs().lte(new BN(1)));

        // 4. Reactiving account can actually send this entire balance
        await instance.transfer(external2, sendAll, {'from': external1});
        balance1 = await instance.balanceOfNoFees(external1);
        assert(balance1.eq(new BN(0)));
        balance2 = await instance.balanceOfNoFees(external2);
        assert(balance2.eq(sendAll));

        // Advance a year, make sure neither account is inactive
        await advanceTimeAndBlock(365*DAY);
        assert(!await instance.isInactive(external1));
        assert(!await instance.isInactive(external2));

        // Fees owed should only be storage fees
        storageFee = await instance.calcStorageFee(external2);
        inactiveFee = await instance.calcInactiveFee(external2);
        assert(storageFee.gt(new BN(0)));
        assert(inactiveFee.eq(new BN(0)));

        // Advance 204 years and entire balance should owed
        await advanceTimeAndBlock(365*204*DAY);
        storageFee = await instance.calcStorageFee(external2);
        inactiveFee = await instance.calcInactiveFee(external2);
        assert(storageFee.add(inactiveFee).eq(sendAll));

        // Force paying storage fees in between doesn't mess with inactive fees?
        await instance.forcePayFees(external2);
        assert((await instance.balanceOfNoFees(external2)).eq(new BN(0)));
    });

    it("Test inactive fees on small and dust collection", async() => {
        await instance.addBackedTokens(5000*TOKEN)
        await instance.transfer(external1, 10*TOKEN, {'from': backed_addr});

        // The minimum inactive fee is 1 token per year, so should only take
        // 10 years (after set inactive to clear this account)
        await advanceTimeAndBlock((INACTIVE_THRESHOLD_DAYS + 365*10) * DAY);
        storageFee = await instance.calcStorageFee(external1);
        inactiveFee = await instance.calcInactiveFee(external1);
        assert(storageFee.add(inactiveFee).eq(new BN(10*TOKEN)));
        
        // Assert sendAllBalance is shown as 0
        assert((await instance.calcSendAllBalance(external1)).eq(new BN(0)));
        // And collecting trends to zero
        await instance.forcePayFees(external1);
        assert((await instance.balanceOfNoFees(external1)).eq(new BN(0)));
        
        // Sending tiny amount to account should be collectable after
        // INACTIVE_THRESHOLD_DAYS + 1 year
        await instance.transfer(external2, 100, {'from': backed_addr});
        await advanceTimeAndBlock((INACTIVE_THRESHOLD_DAYS + 365) * DAY);
        assert((await instance.calcSendAllBalance(external2)).eq(new BN(0)));
        await instance.forcePayFees(external2);
        assert((await instance.balanceOfNoFees(external2)).eq(new BN(0)));
    });

    it("Test advanced storage grace period with inactive fees", async() => {
        await instance.addBackedTokens(5000*TOKEN)
        
        // Set storage fee grace period to a year
        await instance.setStorageFeeGracePeriodDays(365);
        let storageFeeGracePeriod = await instance.storageFeeGracePeriodDays();
        assert.equal(storageFeeGracePeriod, 365);

        // Have account receive 10 tokens and go inactive for INACTIVE_THRESHOLD_DAYS + 1 year
        await instance.transfer(external1, 10*TOKEN, {'from': backed_addr});
        await advanceTimeAndBlock((INACTIVE_THRESHOLD_DAYS + 365) * DAY);
        storageFee = await instance.calcStorageFee(external1);
        inactiveFee = await instance.calcInactiveFee(external1);

        // Storage fee should be on INACTIVE_THRESHOLD_DAYS - 1 year, because there 
        // was a 1 year grace period on storage fees, and inactive fees take over 
        storageFeeCalc = calcStorageFee(10*TOKEN, INACTIVE_THRESHOLD_DAYS - 365);
        assert(storageFee.eq(storageFeeCalc));

        // Inactive fee should be on one year. Because account only has 10 tokens, it
        // will hit the min inactive fee threshold of 1 token, so 1 token should be owed
        assert(inactiveFee.eq(TOKEN));
    });

    it("Test forgetting to collect inactive fee then user reactivates", async() => {
        await instance.addBackedTokens(5000*TOKEN)
        
        // User receives 100 tokens and forgets about it
        await instance.transfer(external1, 100*TOKEN, {'from': backed_addr});

        // INACTIVE_THRESHOLD_DAYS + 5 years pass
        await advanceTimeAndBlock((INACTIVE_THRESHOLD_DAYS + 365*5) * DAY);

        // User decides to send coins to another account. 
        // We should automatically collect:
        // 1. INACTIVE_THRESHOLD_DAYS worth of storage fees
        // 2. 5 years of inactive fees. (Should be 5 tokens because 50 bps threshold does not meet 1 token minimum)
        expectedStorageFees = calcStorageFee(100*TOKEN, INACTIVE_THRESHOLD_DAYS);
        expectedSnapshotBalance = new BN(100*TOKEN).sub(expectedStorageFees);
        expectedInactiveFees = calcInactiveFee(expectedSnapshotBalance,
                                               INACTIVE_THRESHOLD_DAYS + 365*5,
                                               expectedSnapshotBalance,
                                               0);
        expectedSendable = new BN(100*TOKEN).sub(expectedStorageFees).sub(expectedInactiveFees);
        storageFee = await instance.calcStorageFee(external1);
        inactiveFee = await instance.calcInactiveFee(external1);
        assert(storageFee.eq(expectedStorageFees));
        assert(inactiveFee.eq(expectedInactiveFees));

        // Now send 5 Tokens to another account and assert the storage
        // and inactive fees are autodeducted
        await instance.transfer(external2, 5*TOKEN, {'from': external1});
        balanceAfter = await instance.balanceOfNoFees(external1);
        transferFee = new BN(5*TOKEN).div(new BN(1000));
        assert(balanceAfter.eq(new BN(95*TOKEN).sub(storageFee).sub(inactiveFee).sub(transferFee)));
    });

    it("Test force paying storage fees does not invalidate inactive fees", async() => {
        await instance.addBackedTokens(5000*TOKEN)
        
        // User receives 100 tokens and forgets about it
        await instance.transfer(external1, 1000*TOKEN, {'from': backed_addr});

        // Each year until INACTIVE_THRESHOLD_DAYS we can force collection of storage
        for (let i = 0; i < (INACTIVE_THRESHOLD_DAYS/365 -1); i++) {
            await advanceTimeAndBlock(365*DAY);
            await instance.forcePayFees(external1);
        }

        // Been in active for year less than INACTIVE_THRESHOLD_DAYS
        await advanceTimeAndBlock(365*DAY);
        daysInactive = await instance.daysSinceActivity(external1);
        assert(daysInactive.eq(new BN(INACTIVE_THRESHOLD_DAYS)));

        // Calling forcePayFees now 
        await instance.forcePayFees(external1);

        // Now the account should be marked inactive
        assert(await instance.isInactive(external1));
    });

    it("Test inactive fee edge case", async() => {
        await instance.addBackedTokens(5000*TOKEN)
        
        // Give two addresses 100 tokens
        await instance.transfer(external1, 100*TOKEN, {'from': backed_addr});
        await instance.transfer(external2, 100*TOKEN, {'from': backed_addr});

        // After INACTIVE_THRESHOLD_DAYS + 5 years, they should both owe
        // storage and inactive fees
        await advanceTimeAndBlock((INACTIVE_THRESHOLD_DAYS + 365*5) * DAY);
        storageFee1 = await instance.calcStorageFee(external1);
        inactiveFee1 = await instance.calcInactiveFee(external1);
        storageFee2 = await instance.calcStorageFee(external1);
        inactiveFee2 = await instance.calcInactiveFee(external1);
        assert(storageFee1.eq(storageFee2));
        assert(inactiveFee1.eq(inactiveFee2));

        // Neither account is marked inactive currently. If external1 makes a transfer
        // of 10 token to external2 to final state should be
        // Account1: 100 - storage fees - inactive fees - transfer fee - 10
        // Account2: 100 - storage fees - inactive fees + 10
        // 
        // with 3 Transfer Events 2 Inactive Events, and 1 ReActivateEvent
        await instance.transfer(external2, 10*TOKEN, {'from': external1});
        expectedBalance1 = new BN(100*TOKEN).sub(storageFee1).sub(inactiveFee1).sub(new BN(10*TOKEN)).sub(TOKEN.div(new BN(100)));
        expectedBalance2 = new BN(110*TOKEN).sub(storageFee1).sub(inactiveFee1);
        balance1 = await instance.balanceOfNoFees(external1);
        balance2 = await instance.balanceOfNoFees(external2);
        assert(balance1.eq(expectedBalance1));
        assert(balance2.eq(expectedBalance2));

        // Assert account 2 is marked inactive and account 1 is active
        assert(await instance.isInactive(external2));
        assert(!await instance.isInactive(external1));
    });
    it("Test receiving coins during inactive period", async() => {
        await instance.addBackedTokens(5000*TOKEN)
        await instance.transfer(external1, 1000*TOKEN, {'from': backed_addr});

        // At INACTIVE_THRESHOLD_DAYS, mark account inactive
        await advanceTimeAndBlock(INACTIVE_THRESHOLD_DAYS * DAY);
        await instance.forcePayFees(external1);
        assert(await instance.isInactive(external1));

        // Balance should be 1000 - 25 bps on INACTIVE_THRESHOLD_DAYS years
        // with no inactive fee yet
        balance = await instance.balanceOfNoFees(external1);
        balanceExpected = new BN(1000*TOKEN).sub(calcStorageFee(1000*TOKEN, INACTIVE_THRESHOLD_DAYS));
        assert(balance.eq(balanceExpected));

        // The inactive fee will be 50 bps of the balanceSnapshot at this point
        inactiveFeePerYear = balance.div(new BN(200));

        // If we send equivalent to 10x the inactive fee, it should take 10 years
        // longer for the balance to clear
        await instance.transfer(external1, inactiveFeePerYear.mul(new BN(10)), {'from': backed_addr});
        
        // There should have been no fees paid, since the account was just marked inactive
        // and owed storage fees were paid
        balance = await instance.balanceOfNoFees(external1);
        balanceExpected = balanceExpected.add(inactiveFeePerYear.mul(new BN(10)));
        assert(balance.eq(balanceExpected));

        // Advance 200 years, and the balance left should the total balance of coins left
        // after the account was marked inactive
        await advanceTimeAndBlock(365 * 200 * DAY);
        await instance.forcePayFees(external1);
        balance = await instance.balanceOfNoFees(external1);
        balanceExpected = inactiveFeePerYear.mul(new BN(10));
        assert(balance.eq(balanceExpected));

        // In another 10 years the balance should clear
        await advanceTimeAndBlock(365 * 200 * DAY);
        await instance.forcePayFees(external1);
        balance = await instance.balanceOfNoFees(external1);
        assert(balance.eq(new BN(0)));
    });

    it("Test keeping account active", async() => {
        await instance.addBackedTokens(5000*TOKEN)
        await instance.transfer(external1, TOKEN, {'from': backed_addr});

        // Have account stay active by making an approve transaction every so often
        for (let i=0; i < 10; i++) {
            await advanceTimeAndBlock(365 * DAY);
            await instance.approve(external3, 1, {'from': external1});
        }

        // 10 years have passed, but the account is still not inactive and owes 10 
        // years worth of storage fees
        assert(!await instance.isInactive(external1));
        storageFee = await instance.calcStorageFee(external1);
        storageFeeCalc = calcStorageFee(TOKEN, 365 * 10);

        assert(storageFee.eq(storageFeeCalc));
        inactiveFee = await instance.calcInactiveFee(external1);
        assert(inactiveFee.eq(new BN(0)));

        // After 400 years, the storage fee should consume entire balance
        // try it out!
        for (let i=0; i < 400; i++) {
            await advanceTimeAndBlock(365 * DAY);
            await instance.approve(external3, 1, {'from': external1});
        }
        assert(!await instance.isInactive(external1));
        storageFee = await instance.calcStorageFee(external1);
        assert(storageFee.eq(TOKEN));
        inactiveFee = await instance.calcInactiveFee(external1);
        assert(inactiveFee.eq(new BN(0)));

        // Even if we go another INACTIVE_THRESHOLD_DAYS without activity 
        // the account won't be able to go inactive because
        // there is no balance left after storage fees
        await advanceTimeAndBlock(INACTIVE_THRESHOLD_DAYS * DAY);
        inactiveFee = await instance.calcInactiveFee(external1);
        assert(inactiveFee.eq(new BN(0)));
        await truffleAssert.reverts(instance.setAccountInactive(external1));

        // Now collect entire storage fee
        await instance.forcePayFees(external1);
        balance = await instance.balanceOfNoFees(external1);
        assert(balance.eq(new BN(0)));
        assert(!(await instance.isInactive(external1)));
    });

    it("Test changing transfer fee", async function () {
        let currentTransferFee = await instance.transferFeeBasisPoints();
        assert.equal(currentTransferFee, 10);

        // Trying to change it over the MAX_TRANSFER_BASIS_POINTS should fail
        await truffleAssert.reverts(instance.setTransferFeeBasisPoints(11));

        // Transfer some tokens to external address
        let amount = new BN(123456789)
        await instance.addBackedTokens(15000*TOKEN);
        await instance.transfer(external1, amount, {'from': backed_addr});

        // Make sure the transfer fee we calculate in floating point matches
        // the contract
        let sendAllContract = await instance.calcSendAllBalance(external1);
        let sendAllCalc = calcSendAllBalance(currentTransferFee.toNumber(), amount);
        assert(sendAllContract.eq(sendAllCalc));

        // Now try it for all basis points with changing balance
        for (let i=0; i < 10; i++) {
            // console.log("Testing transfer fee for " + i + " basis points");
            await instance.setTransferFeeBasisPoints(i);
            sendAllContract = await instance.calcSendAllBalance(external1);
            sendAllCalc = calcSendAllBalance(i, amount);
            // console.log("Contract said " + sendAllContract.toString() + " calculated " + sendAllCalc.toString());
            assert(sendAllContract.eq(sendAllCalc));
        }
    });

    it("Test force collection of storage fees on a contract address", async function() {
        await instance.addBackedTokens(1000*TOKEN)

        // Send tokens to contract address will fail
        await truffleAssert.reverts(instance.transfer(instance.address, 10*TOKEN, {'from': backed_addr}));

        // Can send tokens to another contract
        await instance.transfer(locked_oracle.address, 10*TOKEN, {'from': backed_addr})
        assert.equal(await instance.balanceOfNoFees(locked_oracle.address), 10*TOKEN);

        // Await 1 years and verify you can force pay storage fee
        await advanceTimeAndBlock(DAY*365);

        let storageFee = await instance.calcStorageFee(locked_oracle.address);
        let expectedFee = calcStorageFee(10*TOKEN, 365);
        assert.equal(storageFee.sub(expectedFee), 0);
        await instance.forcePayFees(locked_oracle.address);
        assert((await instance.balanceOf(fee_addr)).eq(storageFee));
    });

    // Someone trying to cheat the storage fees may try to transfer tokens
    // every day before the interest period kicks in (1 day), however the
    // contract is programmed intelligently in that it won't reset the storage
    // fee timer unless fees were actually paid during a transfer.
    it("Test cheating storage fee schedule", async function () {
        await instance.addBackedTokens(10000*TOKEN);
        await instance.transfer(external1, 5000*TOKEN, {'from': backed_addr});

        // 6 hours
        const QUARTER_DAY = 60*60*6;
        await advanceTimeAndBlock(QUARTER_DAY);

        // Storage fee after 23 hours should be 0 dollars
        let storage_fee = await instance.calcStorageFee(external1);

        assert.equal(storage_fee, 0, "Storage fee should be 0");

        // A cheater should try to do a small transfer every day to avoid
        // paying storage fees
        let time_passed_since_paid = QUARTER_DAY;
        let last_day = 0;
        for (let i = 0; i < 20; i++) {
            // Transfer 0.0000001 tokens every day to try to avoid paying
            // the storage fee
            let passed = Math.floor(time_passed_since_paid / DAY);
            storage_fee = await instance.calcStorageFee(external1);
            // Should only pay fees when the day has increased
            if (passed > 0) {
                time_passed_since_paid = 0;
                assert(storage_fee.gt(new BN(0)), "Should owe storage fees when day has passed");
            } else {
                assert(storage_fee.eq(new BN(0)), "Storage fee should be 0");
            }
            await instance.transfer(external2, 1, {'from': external1});
            await advanceTimeAndBlock(QUARTER_DAY);
            time_passed_since_paid += QUARTER_DAY;
        }
    });
    
    it("Test calcSendAllBalance",  async function () {

        // Mint some starting tokens to backed treasury
        let result = await instance.addBackedTokens(1250000*TOKEN);
        let backed_balance = await instance.balanceOfNoFees(backed_addr);
        assert.equal(backed_balance, 1250000*TOKEN, "Incorrect balance");

        // Distribute tokens to external account
        await instance.transfer(external2, 10*TOKEN, {'from': backed_addr});

        // Move 555 days into the future
        await advanceTimeAndBlock(DAY*555);

        // Calcuate the amount needed to send entire balance to another address
        let amount = await instance.calcSendAllBalance(external2);
        let expected_amount = new BN(((10*TOKEN) - calcStorageFee(10*TOKEN, 555).toNumber())/1.001);
        assert(amount.sub(expected_amount).abs().lte(new BN(1)), "Not the expected amount");

        // Now try to actually send all balance
        await instance.transfer(redeem_addr, amount, {'from': external2});
        let final_balance = await instance.balanceOfNoFees(external2);
        assert(final_balance == 0);

        // Check zero address
        await truffleAssert.reverts(instance.calcSendAllBalance(zero_addr));

        // Send tokens to fee address and assert the send all balance is everything
        await instance.setFeeExempt(external3);
        await instance.transfer(external3, TOKEN, {'from': backed_addr});
        await advanceTimeAndBlock(DAY*555);
        let externalbalance1 = await instance.balanceOfNoFees(external3);
        let externalbalance2 = await instance.balanceOf(external3);
        let send_all = await instance.calcSendAllBalance(external3);
        assert.equal(externalbalance1.toNumber(), externalbalance2.toNumber());
        assert.equal(externalbalance1.toNumber(), send_all.toNumber());
        assert.equal(externalbalance1.toNumber(), TOKEN);
    });

    it("Test advance transfer simulations", async function () {
        // Mint some starting tokens to backed treasury
        let supply = new BN((TOKEN*12500000).toString());
        let result = await instance.addBackedTokens(supply);

        // Transfer entire amount to addr1
        await instance.transfer(external1, supply, {'from': backed_addr});
        assert((await instance.balanceOfNoFees(external1)).eq(supply));

        // Test all the edge cases on fees
        let daysPassedReceived = -1;
        for (let day of [1, 365, 366, 730, 731, 1095]) {
            for (let amount of [1, 50, 100, 1000, 10000, 100000]) {

                daysPassedReceived += day;

                // hack to make external2 never hit inactive limit
                await instance.approve(external3, 1, {'from': external2});

                await advanceTimeAndBlock(day*DAY);

                amount = new BN(amount * TOKEN);
                
                // console.log("Transfer " + amount + " with " + day + " days passed.")
                let daysSinceActive1 = await instance.daysSinceActivity(external1);
                let daysSinceActive2 = await instance.daysSinceActivity(external2);
                // console.log("Days passed received " + daysPassedReceived);
                // console.log("Days inactive external1 " + daysSinceActive1.toString());
                // console.log("Days inactive external2 " + daysSinceActive2.toString());

                // Simulate a transfer for amount
                let simulateResult = await instance.simulateTransfer(external1, external2, amount);
                let beforeBalanceFrom = await instance.balanceOfNoFees(external1);
                let beforeBalanceTo = await instance.balanceOfNoFees(external2);

                // console.log("Balances before: " + beforeBalanceFrom.toString() + " " + beforeBalanceTo.toString());

                // Check contract calculation vs javascript calculation
                let expectedStorageFeeFrom = simulateResult[0];
                let expectedStorageFeeTo = simulateResult[1];
                let expectedTransferFee = simulateResult[2];
                let expectedFinalBalanceFrom = simulateResult[3];
                let expectedFinalBalanceTo = simulateResult[4];

                // console.log(expectedStorageFeeFrom.toString(),
                //             expectedStorageFeeTo.toString(),
                //             expectedTransferFee.toString(),
                //             expectedFinalBalanceFrom.toString(),
                //             expectedFinalBalanceTo.toString());

                let contractCalcStorageFeeFrom = await instance.calcStorageFee(external1);
                let contractCalcStorageFeeTo = await instance.calcStorageFee(external2);
                // console.log(expectedStorageFeeTo.toString() + " vs " + contractCalcStorageFeeTo.toString());
                assert(expectedStorageFeeFrom.eq(contractCalcStorageFeeFrom),
                       "Conflicting storage fee calc from");
                assert(expectedStorageFeeTo.eq(contractCalcStorageFeeTo),
                       "Conflicting storage fee calc to");

                let calcStorageFeeFrom = calcStorageFee(beforeBalanceFrom, day, daysSinceActive1);
                let calcStorageFeeTo = calcStorageFee(beforeBalanceTo, daysPassedReceived, daysSinceActive2);
                let calcTransferFee = new BN(amount * DEFAULT_TRANSFER_FEE);
                let calcFinalBalanceFrom = beforeBalanceFrom.sub(amount).sub(calcStorageFeeFrom).sub(calcTransferFee);
                let calcFinalBalanceTo = beforeBalanceTo.add(amount).sub(calcStorageFeeTo);

                // console.log(calcStorageFeeFrom.toString(),
                //             calcStorageFeeTo.toString(),
                //             calcTransferFee.toString(),
                //             calcFinalBalanceFrom.toString(),
                //             calcFinalBalanceTo.toString());

                assert(expectedStorageFeeFrom.sub(calcStorageFeeFrom).abs().lte(new BN(1)),
                       "Bad storage fee calculation from");
                assert(expectedStorageFeeTo.sub(calcStorageFeeTo).abs().lte(new BN(1)),
                       "Bad storage fee calculation to");
                assert(expectedTransferFee.sub(calcTransferFee).abs().lte(new BN(1)),
                       "Bad transfer fee calculation");
                assert(expectedFinalBalanceFrom.sub(calcFinalBalanceFrom).abs().lte(new BN(1)),
                       "Bad final balance calculation from");
                assert(expectedFinalBalanceTo.sub(calcFinalBalanceTo).abs().lte(new BN(1)),
                       "Bad final balance calculation to");

                // Now actually do the transfer and observer the final balances
                await instance.transfer(external2, amount, {'from': external1});
                let afterBalanceFrom = await instance.balanceOfNoFees(external1);
                let afterBalanceTo = await instance.balanceOfNoFees(external2);
                assert(afterBalanceFrom.eq(expectedFinalBalanceFrom),
                       "Expected from balance does not match acutal");
                assert(afterBalanceTo.eq(expectedFinalBalanceTo),
                       "Expected from balance does not match acutal");

                if (calcStorageFeeTo.gt(new BN(0))) {
                    daysPassedReceived = 0;
                }
                
            }
        }

        // Finally assert that the totals are still matching
        await assertTotals(instance);
    });

    it("Test advanced calcSendAllBalance",  async function () {

        // Mint some starting tokens to backed treasury
        let result = await instance.addBackedTokens(SUPPLY_LIMIT);
        let backed_balance = await instance.balanceOfNoFees(backed_addr);
        let final_balance = new BN(0);
        assert(backed_balance.eq(SUPPLY_LIMIT), "Incorrect balance");

        // Test all the edge cases on fees
        for (let day of [1, 365, 366, 730, 731, 1095]) { 
            for (let tokens of [1, 50, 123, 1234, 12345, 123456]) {
                for (let basisPoints of [1, 3, 5, 7, 9]) {

                    // Set basis points for transfer fee
                    await instance.setTransferFeeBasisPoints(basisPoints);

                    // Send certain amount of tokens
                    let amount = new BN(tokens * TOKEN);
                    await instance.transfer(external2, amount.sub(final_balance), {'from': backed_addr});
                    
                    // hack to make external2 never hit inactive limit
                    await instance.approve(external3, 1, {'from': external2});

                    //console.log("Transfer " + amount + " tokens with " + day + " days passed and " + basisPoints + " basis points.")
                    // Advance time
                    await advanceTimeAndBlock(day*DAY);
                    

                    // Calcuate the amount needed to send entire balance to another address
                    let calc_sendall = await instance.calcSendAllBalance(external2);
                    let expected_amount = calcSendAllBalance(basisPoints, amount.sub(calcStorageFee(amount, day)));
                    //console.log("Contract says " + calc_sendall.toString() + " and calculated " + expected_amount.toString());
                    assert(calc_sendall.sub(expected_amount).abs().lte(new BN(2)), "Not the expected amount");

                    // Now try to actually send all balance
                    await instance.transfer(redeem_addr, calc_sendall, {'from': external2});
                    final_balance = await instance.balanceOfNoFees(external2);
                    balance_w_fees = await instance.balanceOf(external2);
                    //console.log("Final balance is " + final_balance);
                    assert(final_balance.lte(new BN(1)));
                    assert(balance_w_fees.lte(new BN(0)));
                }
            }
        }
    });
});
