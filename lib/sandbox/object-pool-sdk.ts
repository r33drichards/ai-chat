import type {
  SandboxBorrowOutput,
  SandboxItem,
  OperationRef,
  OperationStatusOutput,
  OperationStatus,
} from './types';

export interface ObjectPoolSdkConfig {
  baseUrl: string;
  defaultWaitSeconds?: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export class ObjectPoolSdk {
  private baseUrl: string;
  private defaultWaitSeconds: number;
  private pollIntervalMs: number;
  private maxPollAttempts: number;

  constructor(config: ObjectPoolSdkConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.defaultWaitSeconds = config.defaultWaitSeconds ?? 30;
    this.pollIntervalMs = config.pollIntervalMs ?? 2000;
    this.maxPollAttempts = config.maxPollAttempts ?? 1800;
  }

  /**
   * Borrow a sandbox from the pool
   */
  async borrow(params?: {
    sessionId?: string;
    waitSeconds?: number;
  }): Promise<SandboxBorrowOutput> {
    const waitSeconds = params?.waitSeconds ?? this.defaultWaitSeconds;
    const queryParams = new URLSearchParams();

    if (waitSeconds > 0) {
      queryParams.set('wait', waitSeconds.toString());
    }

    if (params?.sessionId) {
      queryParams.set('params', JSON.stringify({ sessionId: params.sessionId }));
    }

    const url = `${this.baseUrl}/borrow${queryParams.toString() ? `?${queryParams}` : ''}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      if (response.status === 503) {
        throw new Error('No sandboxes available in the pool');
      }
      throw new Error(`Failed to borrow sandbox: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as SandboxBorrowOutput;
    return data;
  }

  /**
   * Return a sandbox to the pool
   */
  async return(
    item: SandboxItem,
    borrowToken: string,
    params?: { sessionId?: string }
  ): Promise<OperationRef> {
    const response = await fetch(`${this.baseUrl}/return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item,
        borrow_token: borrowToken,
        params: params ?? null,
      }),
    });

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Invalid borrow token - cannot return sandbox');
      }
      throw new Error(`Failed to return sandbox: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as OperationRef;
  }

  /**
   * Get the status of an async operation
   */
  async getOperationStatus(operationId: string): Promise<OperationStatusOutput> {
    const response = await fetch(`${this.baseUrl}/operations/${operationId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to get operation status: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as OperationStatusOutput;
  }

  /**
   * Wait for an operation to complete
   */
  async waitForOperation(
    operationId: string,
    options?: { timeoutMs?: number }
  ): Promise<OperationStatusOutput> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? this.pollIntervalMs * this.maxPollAttempts;

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getOperationStatus(operationId);

      const statusLower = status.status.toLowerCase() as OperationStatus;
      if (statusLower === 'succeeded' || statusLower === 'failed') {
        return status;
      }

      await this.sleep(this.pollIntervalMs);
    }

    throw new Error(`Operation ${operationId} timed out after ${timeoutMs}ms`);
  }

  /**
   * Return a sandbox and wait for the operation to complete
   */
  async returnAndWait(
    item: SandboxItem,
    borrowToken: string,
    params?: { sessionId?: string },
    options?: { timeoutMs?: number }
  ): Promise<OperationStatusOutput> {
    const operationRef = await this.return(item, borrowToken, params);
    return this.waitForOperation(operationRef.operation_id, options);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance factory
let instance: ObjectPoolSdk | null = null;

export function getObjectPoolSdk(): ObjectPoolSdk {
  if (!instance) {
    const baseUrl = process.env.SANDBOX_POOL_URL;
    if (!baseUrl) {
      throw new Error('SANDBOX_POOL_URL environment variable is not set');
    }
    instance = new ObjectPoolSdk({ baseUrl });
  }
  return instance;
}
