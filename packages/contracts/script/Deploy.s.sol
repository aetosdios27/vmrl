// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {VMRL} from "../src/VMRL.sol";

/// @notice Deploys the VMRL receipt ledger.
/// @dev Usage: PRIVATE_KEY=0x... forge script script/Deploy.s.sol:DeployVMRL \
///      --rpc-url <RPC> --broadcast [--verify --etherscan-api-key <KEY>]
contract DeployVMRL is Script {
    function run() external returns (VMRL deployed) {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(privateKey);
        deployed = new VMRL();
        vm.stopBroadcast();
        console2.log("VMRL deployed at", address(deployed));
        console2.log("Chain ID", block.chainid);
    }
}
