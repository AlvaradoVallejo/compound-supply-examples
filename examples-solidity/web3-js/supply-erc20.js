/**
 * @fileoverview Script to simulate the process of supplying an ERC20 token (like DAI) 
 * to the Compound Protocol via a custom smart contract on a local Hardhat fork.
 * * Pre-requisite: Run 'npx hardhat run scripts/deploy.js --network localhost' 
 * and set up a .env file with a PRIVATE_KEY.
 */
require('dotenv').config(); // Load environment variables from .env file

const Web3 = require('web3');
const { toBN, toWei, fromWei, toHex } = Web3.utils;

// --- CONFIGURATION ---
const NODE_URL = 'http://localhost:8545';
// NOTE: CRITICAL SECURITY FIX: Fetch private key from environment variables.
const privateKey = process.env.PRIVATE_KEY; 

if (!privateKey) {
  throw new Error("PRIVATE_KEY not found in .env file. Please set it up.");
}

// Contract Addresses (Use Mainnet addresses for the fork)
const MY_CONTRACT_ADDRESS = '0x0Bb909b7c3817F8fB7188e8fbaA2763028956E30';
const UNDERLYING_ADDRESS = '0x6b175474e89094c44da98b954eedeac495271d0f'; // DAI
const CTOKEN_ADDRESS = '0x5d3a536e4d6dbd6114cc1ead35777bab948e3643'; // cDAI

// Token details (Should ideally be fetched dynamically, but hardcoded for local fork reliability)
const ASSET_NAME = 'DAI'; 
const UNDERLYING_DECIMALS = 18; 
const CTOKEN_DECIMALS = 8; // cTokens typically have 8 decimals

const AMOUNT_TO_SUPPLY_BASE = 10; // 10 tokens

// --- WEB3 SETUP ---
const web3 = new Web3(NODE_URL);

// Add the wallet to the Web3 object
web3.eth.accounts.wallet.add(privateKey);
const MY_WALLET_ADDRESS = web3.eth.accounts.wallet[0].address;

// Transaction base settings
const TX_CONFIG = {
  from: MY_WALLET_ADDRESS,
  gasLimit: toHex(500000),
  // On a local fork, gasPrice can usually be set low or omitted to use the default.
  // Using a hardcoded value is often unnecessary/problematic. We keep the original for robustness.
  gasPrice: toHex(20000000000) 
};

// --- CONTRACT ABIS ---
// Use only necessary function signatures (minimizing the ABI size) or fetch from artifacts.
const MyContractAbi = require('../../artifacts/contracts/MyContracts.sol/MyContract.json').abi;
const MyContract = new web3.eth.Contract(MyContractAbi, MY_CONTRACT_ADDRESS);

// Minimal ERC20 ABI for essential functions
const MinimalErc20Abi = [
  {"constant":true,"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"constant":false,"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"wad","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"constant":false,"inputs":[{"internalType":"address","name":"dst","type":"address"},{"internalType":"uint256","name":"wad","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}
];
const UnderlyingToken = new web3.eth.Contract(MinimalErc20Abi, UNDERLYING_ADDRESS);

// Minimal cToken ABI for essential functions
const MinimalCTokenAbi = [
  {"constant":false,"inputs":[{"internalType":"uint256","name":"redeemTokens","type":"uint256"}],"name":"redeem","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"constant":false,"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOfUnderlying","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"constant":true,"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
];
const CToken = new web3.eth.Contract(MinimalCTokenAbi, CTOKEN_ADDRESS);

// --- HELPER FUNCTION ---
/**
 * Converts a human-readable amount to the token's smallest unit (Wei/Juice)
 * @param {number} amount - The human-readable amount (e.g., 10)
 * @param {number} decimals - The token's decimal places (e.g., 18)
 * @returns {string} - The amount in the smallest unit (as a hexadecimal string)
 */
const toTokenUnit = (amount, decimals) => {
    // Calculate the value as a BigNumber/string to prevent floating point issues
    const value = toBN(amount).mul(toBN(10).pow(toBN(decimals)));
    return toHex(value);
};

// --- MAIN EXECUTION LOGIC ---
const main = async function() {
  const contractIsDeployed = (await web3.eth.getCode(MY_CONTRACT_ADDRESS)) !== '0x';

  if (!contractIsDeployed) {
    throw Error('MyContract is not deployed! Deploy it by running the deploy script.');
  }

  // Calculate the amount in token's smallest unit
  const amountToSupply = toTokenUnit(AMOUNT_TO_SUPPLY_BASE, UNDERLYING_DECIMALS);
  
  console.log(`\n--- STARTING DEFI INTERACTION ---\n`);
  console.log(`1. Transferring ${AMOUNT_TO_SUPPLY_BASE} ${ASSET_NAME} from my wallet to MyContract (${MY_CONTRACT_ADDRESS})...`);

  // Step 1: Transfer underlying ERC20 (DAI) to the intermediary contract
  let transferResult = await UnderlyingToken.methods.transfer(
    MY_CONTRACT_ADDRESS,
    amountToSupply
  ).send(TX_CONFIG);

  console.log(`[Status] Transfer successful. MyContract now holds the ${ASSET_NAME}.`);
  
  // OPTIONAL: If the contract logic requires the MyContract to approve Compound before calling mint/supply,
  // this approval step should be added here, though often Compound's Comptroller handles this via transferFrom from the caller.
  // The original code bypasses this by first transferring to the contract.
  
  // Step 2: MyContract calls supplyErc20ToCompound, which internally calls Compound's cToken.mint()
  console.log(`\n2. MyContract is now calling Compound to mint c${ASSET_NAME}...`);
  let supplyResult = await MyContract.methods.supplyErc20ToCompound(
    UNDERLYING_ADDRESS,
    CTOKEN_ADDRESS,
    amountToSupply 
  ).send(TX_CONFIG);

  console.log(`[Status] Supplied ${ASSET_NAME} to Compound via MyContract.`);

  // --- CHECK BALANCES ---
  
  // Get supplied underlying balance (not fully trustable on all forks, but good check)
  let balanceOfUnderlyingWei = await CToken.methods
    .balanceOfUnderlying(MY_CONTRACT_ADDRESS).call();
  let balanceOfUnderlying = fromWei(balanceOfUnderlyingWei.toString(), 'ether');
  console.log(`\n[Balance] ${ASSET_NAME} supplied to Compound (Underlying Balance): ${balanceOfUnderlying}`);

  // Get cToken balance in the contract
  let cTokenBalanceWei = await CToken.methods.balanceOf(MY_CONTRACT_ADDRESS).call();
  // Use CTOKEN_DECIMALS (8) for correct formatting
  let cTokenBalance = cTokenBalanceWei / (10 ** CTOKEN_DECIMALS); 
  console.log(`[Balance] MyContract's c${ASSET_NAME} Token Balance: ${cTokenBalance}`);

  // --- REDEEM LOGIC ---
  
  // Calculate cToken amount to redeem (use the full balance)
  const cTokenAmountToRedeem = toTokenUnit(cTokenBalance, CTOKEN_DECIMALS);
  const redeemType = true; // true for `redeem` (by cToken amount)

  console.log(`\n3. Redeeming ${cTokenBalance} c${ASSET_NAME} for ${ASSET_NAME} via MyContract...`);
  let redeemResult = await MyContract.methods.redeemCErc20Tokens(
    cTokenAmountToRedeem,
    redeemType,
    CTOKEN_ADDRESS
  ).send(TX_CONFIG);
  
  // Check the Compound error code (first return value in the MyLog event)
  const compoundErrorCode = redeemResult.events.MyLog.returnValues[1];
  if (compoundErrorCode !== '0') {
    throw new Error(`Redeem Error Code: ${compoundErrorCode}. Check Compound protocol error codes.`);
  }

  // --- FINAL BALANCE CHECK ---
  let finalCTokenBalanceWei = await CToken.methods.balanceOf(MY_CONTRACT_ADDRESS).call();
  let finalCTokenBalance = finalCTokenBalanceWei / (10 ** CTOKEN_DECIMALS);
  console.log(`[Final Balance] MyContract's c${ASSET_NAME} Token Balance after redeem: ${finalCTokenBalance}`);
  console.log(`\n--- TRANSACTION SUCCESSFUL ---`);
}

main().catch((err) => {
  console.error('\n*** Execution Error ***');
  console.error(err);
  // Terminate the process on error
  process.exit(1); 
});
