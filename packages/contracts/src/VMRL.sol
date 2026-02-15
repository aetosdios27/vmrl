// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract VMRL {
    // Defines what a "Code Receipt" looks like
    struct Receipt {
        string repoId; // e.g. "user/project-name"
        string tag; // e.g. "v1.0.2"
        bytes32 commitHash; // The Git Commit SHA
        bytes32 artifactHash; // SHA-256 of the built binary (optional)
        uint64 timestamp; // When it was anchored
        address signer; // Who posted it
    }

    // A list of every receipt ever posted
    Receipt[] public receipts;

    // A way to look up receipts by Repo ID (hashed)
    mapping(bytes32 => uint256[]) private repoToIds;

    // Event emitted so the Website can update in real-time
    event NewReceipt(
        string indexed repoId,
        bytes32 indexed commitHash,
        address indexed signer,
        uint256 receiptId
    );

    // --- WRITE FUNCTIONS ---

    function postReceipt(
        string calldata _repoId,
        string calldata _tag,
        bytes32 _commitHash,
        bytes32 _artifactHash
    ) external {
        uint256 newId = receipts.length;

        receipts.push(
            Receipt({
                repoId: _repoId,
                tag: _tag,
                commitHash: _commitHash,
                artifactHash: _artifactHash,
                timestamp: uint64(block.timestamp),
                signer: msg.sender
            })
        );

        // Index it so we can find it later
        bytes32 repoHash = keccak256(bytes(_repoId));
        repoToIds[repoHash].push(newId);

        emit NewReceipt(_repoId, _commitHash, msg.sender, newId);
    }

    // --- READ FUNCTIONS ---

    // Get all receipts for a specific repo (for the Explorer page)
    function getRepoReceipts(
        string calldata _repoId
    ) external view returns (Receipt[] memory) {
        bytes32 repoHash = keccak256(bytes(_repoId));
        uint256[] memory ids = repoToIds[repoHash];

        Receipt[] memory output = new Receipt[](ids.length);

        for (uint256 i = 0; i < ids.length; i++) {
            output[i] = receipts[ids[i]];
        }
        return output;
    }

    // Check if a specific commit is valid
    function verifyCommit(
        string calldata _repoId,
        bytes32 _commitHash
    ) external view returns (bool, Receipt memory) {
        bytes32 repoHash = keccak256(bytes(_repoId));
        uint256[] memory ids = repoToIds[repoHash];

        for (uint256 i = 0; i < ids.length; i++) {
            if (receipts[ids[i]].commitHash == _commitHash) {
                return (true, receipts[ids[i]]);
            }
        }

        // Return empty receipt if not found
        Receipt memory empty;
        return (false, empty);
    }
}
