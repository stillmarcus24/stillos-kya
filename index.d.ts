export type KyaVerdict = 'CLEAR' | 'REVIEW' | 'BLOCK' | 'UNKNOWN';

export interface KyaCounterparty {
  name?: string;
  wallet?: string;
}

export interface KyaOptions {
  agent?: string;
  endpoint?: string;
  apiKey?: string;
  xPayment?: string;
  timeoutMs?: number;
  /** PREFERRED: a payment-capable fetch (e.g. x402-fetch's wrapFetchWithPayment). StillOS code never touches your key or signer. */
  fetch?: typeof fetch;
  /** A viem account / signer object. Your key stays inside it. */
  account?: unknown;
  /** Alias for `account`. */
  signer?: unknown;
  /** LEGACY: raw hex private key or a viem account. Supported for backward compatibility; prefer `fetch` or `account`. */
  wallet?: string | unknown;
  /** Max USD to auto-pay per call when a payer is configured (default 0.5). */
  maxUsd?: number;
}

/** Machine-readable error codes. Branch on these, never on message text. */
export type KyaErrorCode =
  | 'PAYMENT_REQUIRED'
  | 'PAYMENT_CAPABILITY_MISSING'
  | 'PAYMENT_CONSTRUCTION_FAILED'
  | 'PAYMENT_REJECTED'
  | 'PAYMENT_UNSUPPORTED'
  | 'BAD_402'
  | 'BAD_REQUEST'
  | 'SERVER_ERROR';

export const CODES: Record<KyaErrorCode, KyaErrorCode>;

/** Flat, stable description of what the server wants paid. Present on any 402. */
export interface KyaPaymentDescriptor {
  mechanism: 'x402';
  scheme: string | null;
  network: string | null;
  asset: string | null;
  asset_name: string | null;
  pay_to: string | null;
  amount_usd: number | null;
  amount_base_units: string | null;
  resource: string | null;
  max_timeout_seconds: number | null;
}

export interface KyaRemediation {
  action: 'configure_payment_capability';
  accepted: string[];
  note: string;
  free_tier_alternative: string;
}

/** Does this runtime have what it needs to construct an x402 payment? Never throws. */
export function paymentCapability(): {
  available: boolean;
  deps: Record<string, boolean>;
  reason: string | null;
};

/** One 402, one payment, one retry. Bounded, never a loop. */
export const MAX_PAYMENT_RETRIES: number;

/** Thrown (not returned) on HTTP 402/4xx/5xx -- check .paymentRequired to distinguish "pay to continue" from a real failure. */
export class KyaHttpError extends Error {
  status: number;
  paymentRequired: boolean;
  price: number | null;
  accepts: unknown[] | null;
  raw: unknown;
  /** Machine-readable cause. Branch on this. */
  code: KyaErrorCode;
  /** Amount/asset/network/recipient. Non-null on any 402. Never contains secrets. */
  payment: KyaPaymentDescriptor | null;
  /** Exact configuration action required. Non-null on any 402. */
  remediation: KyaRemediation | null;
}

export interface KyaReceipt {
  hash: string;
  signature: string;
  verify: string;
}

export interface KyaResult {
  verdict: KyaVerdict;
  allowed: boolean;
  review: boolean;
  blocked: boolean;
  checks: Record<string, unknown> | null;
  signed: boolean;
  receipt: KyaReceipt | null;
  toll: { amount_usd: number; network: string } | null;
  raw: unknown;
}

export interface KyaGateOptions extends KyaOptions {
  extract?: (req: unknown) => KyaCounterparty;
  blockOnReview?: boolean;
  failOpen?: boolean;
}

/** Run a Know-Your-Agent counterparty trust check. */
export function kya(counterparty: string | KyaCounterparty, opts?: KyaOptions): Promise<KyaResult>;

/** Express middleware: gate a route/transaction on a KYA verdict. */
export function kyaGate(opts?: KyaGateOptions): (req: any, res: any, next: any) => Promise<void>;

export const DEFAULT_ENDPOINT: string;
