import { ObjectPoolSdk, getObjectPoolSdk } from './object-pool-sdk';
import type {
  SandboxItem,
  BorrowedSandbox,
  ExecResponse,
  LogsResponse,
} from './types';

export interface AgentSessionData {
  sessionId: string;
  item: SandboxItem | null;
  borrowToken: string | null;
  borrowedAt: Date | null;
}

export interface AgentSessionConfig {
  sessionId: string;
  objectPoolSdk?: ObjectPoolSdk;
  onSessionDataChange?: (data: AgentSessionData) => Promise<void>;
  initialData?: AgentSessionData;
}

/**
 * AgentSession manages sandbox lifecycle for a conversation.
 * It provides exec and logs tools that can be used by an AI agent.
 */
export class AgentSession {
  private sessionId: string;
  private objectPoolSdk: ObjectPoolSdk;
  private data: AgentSessionData;
  private onSessionDataChange?: (data: AgentSessionData) => Promise<void>;

  constructor(config: AgentSessionConfig) {
    this.sessionId = config.sessionId;
    this.objectPoolSdk = config.objectPoolSdk ?? getObjectPoolSdk();
    this.onSessionDataChange = config.onSessionDataChange;

    // Initialize data from provided initial data or create new
    this.data = config.initialData ?? {
      sessionId: this.sessionId,
      item: null,
      borrowToken: null,
      borrowedAt: null,
    };
  }

  /**
   * Get current session data
   */
  getData(): AgentSessionData {
    return { ...this.data };
  }

  /**
   * Check if session has an active sandbox
   */
  hasSandbox(): boolean {
    return this.data.item !== null && this.data.borrowToken !== null;
  }

  /**
   * Ensure we have a borrowed sandbox, borrowing one if needed
   */
  async ensureSandbox(): Promise<BorrowedSandbox> {
    if (this.hasSandbox()) {
      return {
        item: this.data.item!,
        borrowToken: this.data.borrowToken!,
        sessionId: this.sessionId,
      };
    }

    // Borrow a new sandbox
    const borrowResult = await this.objectPoolSdk.borrow({
      sessionId: this.sessionId,
    });

    this.data = {
      sessionId: this.sessionId,
      item: borrowResult.item,
      borrowToken: borrowResult.borrow_token,
      borrowedAt: new Date(),
    };

    // Persist the session data change
    if (this.onSessionDataChange) {
      await this.onSessionDataChange(this.data);
    }

    return {
      item: borrowResult.item,
      borrowToken: borrowResult.borrow_token,
      sessionId: this.sessionId,
    };
  }

  /**
   * Execute a command in the sandbox
   */
  async exec(command: string): Promise<ExecResponse> {
    const sandbox = await this.ensureSandbox();

    const response = await fetch(`${sandbox.item.execUrl}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });

    if (!response.ok) {
      throw new Error(`Failed to execute command: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as ExecResponse;
  }

  /**
   * Get logs for a command execution
   */
  async logs(commandId: string, offset = -1, search = '*'): Promise<LogsResponse> {
    const sandbox = await this.ensureSandbox();

    const params = new URLSearchParams({
      offset: offset.toString(),
      search,
    });

    const response = await fetch(
      `${sandbox.item.execUrl}/logs/${commandId}?${params}`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get logs: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as LogsResponse;
  }

  /**
   * Poll for command completion, returning logs progressively
   */
  async waitForCompletion(
    commandId: string,
    options?: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      onProgress?: (logs: LogsResponse) => void;
    }
  ): Promise<LogsResponse> {
    const pollIntervalMs = options?.pollIntervalMs ?? 500;
    const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000;
    const startTime = Date.now();
    let offset = -1;

    while (Date.now() - startTime < timeoutMs) {
      const logsResponse = await this.logs(commandId, offset);

      if (options?.onProgress) {
        options.onProgress(logsResponse);
      }

      if (logsResponse.done) {
        return logsResponse;
      }

      offset = logsResponse.offset;
      await this.sleep(pollIntervalMs);
    }

    throw new Error(`Command ${commandId} timed out after ${timeoutMs}ms`);
  }

  /**
   * Execute a command and wait for it to complete
   */
  async execAndWait(
    command: string,
    options?: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      onProgress?: (logs: LogsResponse) => void;
    }
  ): Promise<{ exec: ExecResponse; logs: LogsResponse }> {
    const execResult = await this.exec(command);
    const logsResult = await this.waitForCompletion(execResult.commandId, options);
    return { exec: execResult, logs: logsResult };
  }

  /**
   * Return the sandbox to the pool
   * Call this when the conversation/session ends
   */
  async releaseSandbox(): Promise<void> {
    if (!this.hasSandbox()) {
      return;
    }

    await this.objectPoolSdk.returnAndWait(
      this.data.item!,
      this.data.borrowToken!,
      { sessionId: this.sessionId }
    );

    this.data = {
      sessionId: this.sessionId,
      item: null,
      borrowToken: null,
      borrowedAt: null,
    };

    if (this.onSessionDataChange) {
      await this.onSessionDataChange(this.data);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
