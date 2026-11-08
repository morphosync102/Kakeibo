// Software WebAuthn authenticator for tests (design §8.1): real ES256 keys
// (node:crypto), real CBOR attestation objects ("none") and real assertion
// signatures, so @simplewebauthn/server verifies them without mocks.
// Synthetic values only. Not a test file itself (node --test runs it as empty).
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64u = bytes => Buffer.from(bytes).toString('base64url');

// --- minimal CBOR encoder (unsigned/negative ints, byte/text strings, maps)
function head(major, length) {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
    if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(length, 1);
    return b;
}

export function cbor(value) {
    if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
    if (typeof value === 'string') {
        const bytes = Buffer.from(value, 'utf8');
        return Buffer.concat([head(3, bytes.length), bytes]);
    }
    if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
    if (value instanceof Map) {
        const parts = [head(5, value.size)];
        for (const [k, v] of value) parts.push(cbor(k), cbor(v));
        return Buffer.concat(parts);
    }
    throw new Error(`cbor: unsupported ${typeof value}`);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

function counterBytes(counter) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(counter, 0);
    return b;
}

// One passkey (credential) held by the software authenticator
export function createSoftPasskey({ rpID, userId, counter = 0, synced = true }) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credentialId = randomBytes(16);
    const cose = cbor(new Map([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
    ]));
    const rpIdHash = () => createHash('sha256').update(rpID).digest();
    const syncFlags = synced ? FLAG_BE | FLAG_BS : 0;
    const passkey = {
        id: b64u(credentialId),
        rpID,
        userId,
        counter,
        cosePublicKey: b64u(cose),

        // navigator.credentials.create() as @simplewebauthn/browser returns it
        register({ challenge, origin, uv = true, rpIdOverride, type = 'webauthn.create' }) {
            const flags = FLAG_UP | (uv ? FLAG_UV : 0) | FLAG_AT | syncFlags;
            const idLength = Buffer.alloc(2);
            idLength.writeUInt16BE(credentialId.length, 0);
            const authData = Buffer.concat([
                rpIdOverride ? createHash('sha256').update(rpIdOverride).digest() : rpIdHash(),
                Buffer.from([flags]),
                counterBytes(passkey.counter),
                Buffer.alloc(16), // aaguid
                idLength,
                credentialId,
                cose,
            ]);
            const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
            const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
            return {
                id: passkey.id,
                rawId: passkey.id,
                type: 'public-key',
                response: {
                    clientDataJSON: b64u(clientDataJSON),
                    attestationObject: b64u(attestationObject),
                    transports: ['internal', 'hybrid'],
                },
                clientExtensionResults: {},
                authenticatorAttachment: 'platform',
            };
        },

        // navigator.credentials.get() as @simplewebauthn/browser returns it.
        // The counter advances by `step` (0 = synced passkey that always says 0).
        assert({ challenge, origin, uv = true, userHandle = userId, step = 0, counterOverride, rpIdOverride, type = 'webauthn.get' }) {
            passkey.counter += step;
            const flags = FLAG_UP | (uv ? FLAG_UV : 0) | syncFlags;
            const authData = Buffer.concat([
                rpIdOverride ? createHash('sha256').update(rpIdOverride).digest() : rpIdHash(),
                Buffer.from([flags]),
                counterBytes(counterOverride ?? passkey.counter),
            ]);
            const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
            const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), privateKey);
            return {
                id: passkey.id,
                rawId: passkey.id,
                type: 'public-key',
                response: {
                    clientDataJSON: b64u(clientDataJSON),
                    authenticatorData: b64u(authData),
                    signature: b64u(signature),
                    ...(userHandle === null ? {} : { userHandle: b64u(Buffer.from(userHandle, 'utf8')) }),
                },
                clientExtensionResults: {},
                authenticatorAttachment: 'platform',
            };
        },
    };
    return passkey;
}
