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
