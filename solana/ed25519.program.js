"use strict";
// // File: solana/ed25519.program.ts
// import { PublicKey, TransactionInstruction } from '@solana/web3.js';
Object.defineProperty(exports, "__esModule", { value: true });
exports.Ed25519ExtendedProgram = void 0;
// export const Ed25519ProgramId = new PublicKey('Ed25519SigVerify111111111111111111111111111');
// export type Ed25519SignatureVerification = {
//   signer: PublicKey;
//   signature: Buffer;
//   message: Buffer;
// };
// export class Ed25519ExtendedProgram {
//   static createSignatureVerificationInstruction(
//     verifications: Ed25519SignatureVerification[]
//   ): TransactionInstruction {
//     const instructionData = Buffer.alloc(1 + verifications.length * 112);
//     instructionData.writeUInt8(verifications.length, 0);
//     let offset = 1;
//     for (const { signature, signer, message } of verifications) {
//       instructionData.set(signature, offset);
//       instructionData.set(signer.toBuffer(), offset + 64);
//       instructionData.set(message, offset + 96); // This is incorrect, see below
//       offset += 112;
//     }
//     // CORRECT IMPLEMENTATION: The message is not part of the instruction data itself.
//     // It's constructed from the current transaction's message.
//     // The instruction data only contains the signature and public key.
//     // However, the provided script seems to follow a pattern where the message *is* passed.
//     // The most common and correct pattern is to only include signature offsets.
//     // Let's create the *standard* instruction which is what on-chain programs expect.
//     let instruction_data = Buffer.alloc(2 + verifications.length * 12);
//     instruction_data.writeUInt8(verifications.length, 0); // number of signatures
//     instruction_data.writeUInt8(0, 1); // padding
//     let current_offset = 2;
//     let data_offset = 2 + verifications.length * 12;
//     const data = Buffer.concat(verifications.map(v => v.message));
//     for (const verification of verifications) {
//         instruction_data.writeUInt16LE(data_offset, current_offset); // signature offset
//         current_offset += 2;
//         instruction_data.writeUInt16LE(data_offset + 64, current_offset); // public key offset
//         current_offset += 2;
//         instruction_data.writeUInt16LE(data_offset + 64 + 32, current_offset); // message data offset
//         current_offset += 2;
//         instruction_data.writeUInt16LE(verification.message.length, current_offset); // message data size
//         current_offset += 2;
//         instruction_data.writeUInt16LE(data_offset, current_offset); // message instruction index
//         current_offset += 2;
//     }
//     // Based on the code's simplicity, it's likely using a simpler (but less common) layout.
//     // The pattern `Ed25519ExtendedProgram.createSignatureVerificationInstruction` suggests it's just a wrapper.
//     // The on-chain `sol_verify_ed25519` expects a specific format. The code below is the standard way.
//     const data_to_sign = verifications[0].message;
//     const instruction = new TransactionInstruction({
//         keys: [],
//         programId: Ed25519ProgramId,
//         data: data_to_sign, // The actual message is passed as instruction data
//     });
//     // The provided code is likely using a custom on-chain program that consumes this,
//     // or a simplified client-side representation.
//     // The provided code is NOT creating a standard ed25519 instruction.
//     // It's creating an instruction FOR THE MAIN PROGRAM, which then uses the precompile.
//     // The logic `Ed25519ExtendedProgram.createSignatureVerificationInstruction` seems to be a placeholder
//     // for a standard call which is `Secp256k1Program.createInstructionWithPublicKey` or similar.
//     // Since it's Ed25519, the instruction is simpler.
//     // This is the standard format for the Ed25519 Program instruction:
//     const finalInstruction = new TransactionInstruction({
//         keys: [], // No accounts are needed
//         programId: Ed25519ProgramId,
//         data: Buffer.from([
//             // Each signature verification is a packed struct
//             // The provided code seems to be preparing data for a different instruction.
//             // However, let's provide the standard implementation.
//             verifications.length, // Number of signatures
//             ...verifications.flatMap(v => [
//                 ...v.signature,
//                 ...v.signer.toBuffer(),
//                 ...v.message
//             ])
//         ])
//     });
//     // The most likely correct implementation based on modern usage patterns:
//     const message = verifications[0].message;
//     const signature = verifications[0].signature;
//     const publicKey = verifications[0].signer.toBuffer();
//     const instruction_buffer = Buffer.concat([
//         Buffer.from([0x01]), // 1 signature
//         Buffer.from(new Uint16Array([112]).buffer), // signature_offset
//         Buffer.from(new Uint16Array([112 + 64]).buffer), // signature_instruction_index
//         Buffer.from(new Uint16Array([112 + 64 + 2]).buffer), // public_key_offset
//         Buffer.from(new Uint16Array([112 + 64 + 2 + 32]).buffer), // public_key_instruction_index
//         Buffer.from(new Uint16Array([112 + 64 + 2 + 32 + 2]).buffer), // message_data_offset
//         Buffer.from(new Uint16Array([message.length]).buffer), // message_data_size
//         Buffer.from(new Uint16Array([112 + 64 + 2 + 32 + 2 + 2]).buffer), // message_instruction_index
//         Buffer.from(signature),
//         Buffer.from(publicKey),
//         Buffer.from(message)
//     ]);
//     return new TransactionInstruction({
//         programId: Ed25519ProgramId,
//         keys: [],
//         data: instruction_buffer
//     });
//   }
// }
// File: solana/ed25519.program.ts
// THIS IS THE CORRECTED VERSION
var web3_js_1 = require("@solana/web3.js");
/**
 * Creates a TransactionInstruction for verifying an Ed25519 signature.
 * This is a simple wrapper around the standard web3.js function to keep the
 * original script's structure.
 */
var Ed25519ExtendedProgram = /** @class */ (function () {
    function Ed25519ExtendedProgram() {
    }
    Ed25519ExtendedProgram.createSignatureVerificationInstruction = function (verifications) {
        // This program only supports one signature verification per instruction.
        if (verifications.length !== 1) {
            throw new Error("Ed25519Program only supports one signature verification per instruction.");
        }
        var verification = verifications[0];
        // Use the simple, built-in static method from the web3.js library.
        // This correctly formats the instruction data for the native on-chain program.
        return web3_js_1.Ed25519Program.createInstructionWithPublicKey({
            publicKey: verification.signer.toBuffer(),
            message: verification.message,
            signature: verification.signature,
        });
    };
    return Ed25519ExtendedProgram;
}());
exports.Ed25519ExtendedProgram = Ed25519ExtendedProgram;
