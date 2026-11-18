import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { ModelDescriptor } from './types/plugin';

export type PassportEvidenceSource = 'declared' | 'discovered' | 'measured';

export interface PassportClaim<T> {
  value: T;
  source: PassportEvidenceSource;
  observedAt: number;
  evidence: string;
}

export interface ModelPassportClaims {
  contextWindow?: PassportClaim<number>;
  maxOutputTokens?: PassportClaim<number>;
  supportsThinking?: PassportClaim<boolean>;
  supportsTools?: PassportClaim<boolean>;
  supportsStreaming?: PassportClaim<boolean>;
  isFree?: PassportClaim<boolean>;
  contextOverflowAt?: PassportClaim<number>;
}

export interface ModelPassport {
  schemaVersion: 1;
  id: string;
  providerId: string;
  generatedAt: number;
  claims: ModelPassportClaims;
  availability?: PassportClaim<{ healthy: boolean; latencyMs: number; error?: string }>;
  digest: string;
  signature: {
    algorithm: 'Ed25519';
    keyId: string;
    publicKey: string;
    value: string;
  };
}

export interface PassportSigner {
  keyId: string;
  publicKey: string;
  sign(payload: string): string;
}

export interface AvailabilityObservation {
  healthy: boolean;
  latencyMs: number;
  observedAt?: number;
  evidence?: string;
  error?: string;
}

export interface ModelPassportStore {
  get(id: string): ModelPassport | undefined;
  list(): ModelPassport[];
  observe(model: ModelDescriptor, providerId: string, observedAt?: number): ModelPassport;
  recordAvailability(id: string, observation: AvailabilityObservation): ModelPassport;
  recordCapabilityClaim(
    id: string,
    name: keyof ModelPassportClaims,
    claim: PassportClaim<unknown>
  ): ModelPassport;
  verify(id: string): boolean;
}

type UnsignedPassport = Omit<ModelPassport, 'digest' | 'signature'>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digestPayload(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function unsigned(passport: ModelPassport): UnsignedPassport {
  const { digest: _digest, signature: _signature, ...record } = passport;
  return record;
}

function signedPassport(record: UnsignedPassport, signer: PassportSigner): ModelPassport {
  const payload = stableStringify(record);
  return {
    ...record,
    digest: digestPayload(payload),
    signature: {
      algorithm: 'Ed25519',
      keyId: signer.keyId,
      publicKey: signer.publicKey,
      value: signer.sign(payload),
    },
  };
}

export function createPassportSigner(dataDir: string): PassportSigner {
  const keyPath = join(dataDir, 'model-passport-key.json');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  let privateKey: string;
  let publicKey: string;
  if (existsSync(keyPath)) {
    const stored = JSON.parse(readFileSync(keyPath, 'utf8')) as {
      privateKey: string;
      publicKey: string;
    };
    privateKey = stored.privateKey;
    publicKey = stored.publicKey;
  } else {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    writeFileSync(keyPath, JSON.stringify({ privateKey, publicKey }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Windows may not expose POSIX modes; ACLs remain an operator concern.
    }
  }

  const keyId = digestPayload(publicKey).slice(0, 16);
  const privateKeyObject = createPrivateKey(privateKey);
  return {
    keyId,
    publicKey,
    sign(payload: string): string {
      return sign(null, Buffer.from(payload), privateKeyObject).toString('base64');
    },
  };
}

export function verifyPassport(passport: ModelPassport): boolean {
  try {
    const payload = stableStringify(unsigned(passport));
    if (digestPayload(payload) !== passport.digest) return false;
    if (digestPayload(passport.signature.publicKey).slice(0, 16) !== passport.signature.keyId) {
      return false;
    }
    return verify(
      null,
      Buffer.from(payload),
      createPublicKey(passport.signature.publicKey),
      Buffer.from(passport.signature.value, 'base64')
    );
  } catch {
    return false;
  }
}

export function passportFromDescriptor(
  model: ModelDescriptor,
  providerId: string,
  signer: PassportSigner,
  observedAt = Date.now()
): ModelPassport {
  const source = model.catalogSource ?? 'declared';
  const evidence = model.catalogEvidence ?? `${providerId}.listModels`;
  const claim = <T>(value: T): PassportClaim<T> => ({ value, source, observedAt, evidence });
  const claims: ModelPassportClaims = {};

  if (model.contextWindow !== undefined) claims.contextWindow = claim(model.contextWindow);
  if (model.maxOutputTokens !== undefined) claims.maxOutputTokens = claim(model.maxOutputTokens);
  if (model.supportsThinking !== undefined) claims.supportsThinking = claim(model.supportsThinking);
  if (model.supportsTools !== undefined) claims.supportsTools = claim(model.supportsTools);
  if (model.supportsStreaming !== undefined) claims.supportsStreaming = claim(model.supportsStreaming);
  if (model.isFree !== undefined) claims.isFree = claim(model.isFree);

  const record: UnsignedPassport = {
    schemaVersion: 1,
    id: model.id,
    providerId: model.providerId ?? providerId,
    generatedAt: observedAt,
    claims,
  };
  return signedPassport(record, signer);
}

export function createModelPassportStore(
  filePath: string,
  signer: PassportSigner
): ModelPassportStore {
  const passports = new Map<string, ModelPassport>();

  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { passports?: ModelPassport[] };
      for (const passport of parsed.passports ?? []) {
        if (
          passport.signature.keyId === signer.keyId &&
          passport.signature.publicKey === signer.publicKey &&
          verifyPassport(passport)
        ) {
          passports.set(passport.id, passport);
        }
      }
    } catch {
      // Keep corrupt storage untouched for operator recovery. A later explicit
      // mutation replaces it atomically with the valid in-memory records.
    }
  }

  function persist(): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tempPath = `${filePath}.tmp`;
    const payload = {
      schemaVersion: 1,
      passports: Array.from(passports.values()).sort((a, b) => a.id.localeCompare(b.id)),
    };
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Windows may not expose POSIX modes.
    }
  }

  return {
    get(id: string): ModelPassport | undefined {
      return passports.get(id);
    },
    list(): ModelPassport[] {
      return Array.from(passports.values()).sort((a, b) => a.id.localeCompare(b.id));
    },
    observe(model: ModelDescriptor, providerId: string, observedAt = Date.now()): ModelPassport {
      const current = passports.get(model.id);
      if (current && current.generatedAt > observedAt) return current;
      const passport = passportFromDescriptor(model, providerId, signer, observedAt);
      // Measured evidence outranks a catalogue refresh; never downgrade it.
      for (const [name, claim] of Object.entries(current?.claims ?? {})) {
        if (claim?.source === 'measured') {
          (passport.claims as Record<string, unknown>)[name] = claim;
        }
      }
      passports.set(passport.id, passport);
      persist();
      return passport;
    },
    recordAvailability(id: string, observation: AvailabilityObservation): ModelPassport {
      const current = passports.get(id);
      if (!current) throw new Error(`No passport exists for model: ${id}`);
      const observedAt = observation.observedAt ?? Date.now();
      if (current.availability && current.availability.observedAt > observedAt) return current;
      const record: UnsignedPassport = {
        ...unsigned(current),
        generatedAt: Math.max(current.generatedAt, observedAt),
        availability: {
          value: {
            healthy: observation.healthy,
            latencyMs: observation.latencyMs,
            ...(observation.error ? { error: observation.error } : {}),
          },
          source: 'measured',
          observedAt,
          evidence: observation.evidence ?? 'explicit basic probe',
        },
      };
      const passport = signedPassport(record, signer);
      passports.set(id, passport);
      persist();
      return passport;
    },
    recordCapabilityClaim(id, name, claim) {
      const current = passports.get(id);
      if (!current) throw new Error(`No passport exists for model: ${id}`);
      const existing = current.claims[name];
      if (existing && existing.source === 'measured' &&
          JSON.stringify(existing.value) === JSON.stringify(claim.value)) {
        return current;
      }
      const record: UnsignedPassport = {
        ...unsigned(current),
        generatedAt: Math.max(current.generatedAt, claim.observedAt),
        claims: {
          ...current.claims,
          [name]: claim,
        },
      };
      const passport = signedPassport(record, signer);
      passports.set(id, passport);
      persist();
      return passport;
    },
    verify(id: string): boolean {
      const passport = passports.get(id);
      return !!passport &&
        passport.signature.keyId === signer.keyId &&
        passport.signature.publicKey === signer.publicKey &&
        verifyPassport(passport);
    },
  };
}

const processStores = new Map<string, ModelPassportStore>();

export function getGlobalModelPassportStore(dataDir = process.env.DATA_DIR || 'data'): ModelPassportStore {
  const filePath = join(dataDir, 'model-passports.json');
  let store = processStores.get(filePath);
  if (!store) {
    store = createModelPassportStore(filePath, createPassportSigner(dataDir));
    processStores.set(filePath, store);
  }
  return store;
}



