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

    // secp256k1 group order / 2, used to reject malleable signatures.
    bytes32 private constant _SECP256K1N_DIV_2 = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 public constant POST_RECEIPT_TYPEHASH = keccak256(
        "PostReceipt(string repoId,string tag,bytes32 commitHash,bytes32 artifactHash,address signer,uint256 nonce,uint256 deadline)"
    );

    // A list of every receipt ever posted. Slot 0 is preserved for compatibility.
    Receipt[] public receipts;

    // A way to look up receipts by Repo ID (hashed)
    mapping(bytes32 => uint256[]) private repoToIds;

    // Revocation state is kept out of the Receipt struct so its ABI and storage layout do not change.
    mapping(uint256 => bool) public revoked;

    // Nonces for EIP-712 relayed receipts.
    mapping(address => uint256) public nonces;

    // Maps a dedupe key to receipt ID + 1 so that 0 means "absent".
    mapping(bytes32 => uint256) private receiptKeyToId;

    // Event emitted so the Website can update in real-time
    event NewReceipt(string indexed repoId, bytes32 indexed commitHash, address indexed signer, uint256 receiptId);

    event ReceiptRevoked(uint256 indexed receiptId, address indexed signer);

    error EmptyArtifactHash();
    error DuplicateReceipt(uint256 existingId);
    error UnknownReceipt(uint256 receiptId);
    error NotSigner(uint256 receiptId);
    error AlreadyRevoked(uint256 receiptId);
    error DeadlineExpired(uint256 deadline);
    error InvalidSignature();

    // --- WRITE FUNCTIONS ---

    function postReceipt(string calldata _repoId, string calldata _tag, bytes32 _commitHash, bytes32 _artifactHash)
        external
        returns (uint256)
    {
        return _post(_repoId, _tag, _commitHash, _artifactHash, msg.sender);
    }

    /**
     * Posts a receipt signed by `_signer` using EIP-712, so a CI key can authorize
     * an anchor without holding gas. The nonce must match `nonces(_signer)`.
     */
    function postReceiptWithSig(
        string calldata _repoId,
        string calldata _tag,
        bytes32 _commitHash,
        bytes32 _artifactHash,
        address _signer,
        uint256 _deadline,
        bytes calldata _signature
    ) external returns (uint256) {
        if (block.timestamp > _deadline) revert DeadlineExpired(_deadline);
        uint256 nonce = nonces[_signer];
        bytes32 structHash = keccak256(
            abi.encode(
                POST_RECEIPT_TYPEHASH,
                keccak256(bytes(_repoId)),
                keccak256(bytes(_tag)),
                _commitHash,
                _artifactHash,
                _signer,
                nonce,
                _deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        if (_recover(digest, _signature) != _signer) revert InvalidSignature();
        nonces[_signer] = nonce + 1;
        return _post(_repoId, _tag, _commitHash, _artifactHash, _signer);
    }

    /**
     * Revokes a receipt. Only the original signer can revoke, and revocation is
     * permanent. Revoked receipts are excluded from `verifyCommit`.
     */
    function revokeReceipt(uint256 _receiptId) external {
        if (_receiptId >= receipts.length) revert UnknownReceipt(_receiptId);
        if (receipts[_receiptId].signer != msg.sender) revert NotSigner(_receiptId);
        if (revoked[_receiptId]) revert AlreadyRevoked(_receiptId);
        revoked[_receiptId] = true;
        emit ReceiptRevoked(_receiptId, msg.sender);
    }

    // --- READ FUNCTIONS ---

    // Explicit receipt count, removing the need to probe storage slot 0.
    function receiptCount() external view returns (uint256) {
        return receipts.length;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("VMRL")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // Get all receipts for a specific repo (for the Explorer page)
    function getRepoReceipts(string calldata _repoId) external view returns (Receipt[] memory) {
        bytes32 repoHash = keccak256(bytes(_repoId));
        uint256[] memory ids = repoToIds[repoHash];

        Receipt[] memory output = new Receipt[](ids.length);

        for (uint256 i = 0; i < ids.length; i++) {
            output[i] = receipts[ids[i]];
        }
        return output;
    }

    function getRepoReceiptCount(string calldata _repoId) external view returns (uint256) {
        return repoToIds[keccak256(bytes(_repoId))].length;
    }

    /**
     * Bounded variant of `getRepoReceipts` so large repositories can be paged
     * instead of looping over every receipt in one call.
     */
    function getRepoReceiptsPaged(string calldata _repoId, uint256 _offset, uint256 _limit)
        external
        view
        returns (Receipt[] memory page, uint256 total)
    {
        uint256[] storage ids = repoToIds[keccak256(bytes(_repoId))];
        total = ids.length;
        if (_offset >= total || _limit == 0) return (new Receipt[](0), total);
        uint256 end = _offset + _limit;
        if (end > total) end = total;
        page = new Receipt[](end - _offset);
        for (uint256 i = _offset; i < end; i++) {
            page[i - _offset] = receipts[ids[i]];
        }
    }

    // Paged access to the full ledger, including receipts with no repo filter.
    function getReceiptsPaged(uint256 _offset, uint256 _limit)
        external
        view
        returns (Receipt[] memory page, uint256 total)
    {
        total = receipts.length;
        if (_offset >= total || _limit == 0) return (new Receipt[](0), total);
        uint256 end = _offset + _limit;
        if (end > total) end = total;
        page = new Receipt[](end - _offset);
        for (uint256 i = _offset; i < end; i++) {
            page[i - _offset] = receipts[i];
        }
    }

    // Check if a specific commit is valid. Revoked receipts are never valid.
    function verifyCommit(string calldata _repoId, bytes32 _commitHash) external view returns (bool, Receipt memory) {
        bytes32 repoHash = keccak256(bytes(_repoId));
        uint256[] memory ids = repoToIds[repoHash];

        for (uint256 i = 0; i < ids.length; i++) {
            if (!revoked[ids[i]] && receipts[ids[i]].commitHash == _commitHash) {
                return (true, receipts[ids[i]]);
            }
        }

        // Return empty receipt if not found
        Receipt memory empty;
        return (false, empty);
    }

    // --- INTERNAL ---

    function _post(
        string calldata _repoId,
        string calldata _tag,
        bytes32 _commitHash,
        bytes32 _artifactHash,
        address _signer
    ) private returns (uint256) {
        if (_artifactHash == bytes32(0)) revert EmptyArtifactHash();

        bytes32 key = keccak256(abi.encode(_signer, _repoId, _commitHash, _artifactHash));
        uint256 existing = receiptKeyToId[key];
        if (existing != 0) revert DuplicateReceipt(existing - 1);

        uint256 newId = receipts.length;

        receipts.push(
            Receipt({
                repoId: _repoId,
                tag: _tag,
                commitHash: _commitHash,
                artifactHash: _artifactHash,
                timestamp: uint64(block.timestamp),
                signer: _signer
            })
        );

        // Index it so we can find it later
        repoToIds[keccak256(bytes(_repoId))].push(newId);
        receiptKeyToId[key] = newId + 1;

        emit NewReceipt(_repoId, _commitHash, _signer, newId);
        return newId;
    }

    function _recover(bytes32 _digest, bytes calldata _signature) private pure returns (address) {
        if (_signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(_signature.offset)
            s := calldataload(add(_signature.offset, 32))
            v := byte(0, calldataload(add(_signature.offset, 64)))
        }
        if (uint256(s) > uint256(_SECP256K1N_DIV_2)) revert InvalidSignature();
        if (v != 27 && v != 28) revert InvalidSignature();
        address recovered = ecrecover(_digest, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }
}
