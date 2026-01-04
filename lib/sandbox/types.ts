import type { components } from './generated/api';

// Re-export base API types
export type BorrowOutput = components['schemas']['BorrowOutput'];
export type ReturnInput = components['schemas']['ReturnInput'];
export type OperationRef = components['schemas']['OperationRef'];
export type OperationStatusOutput = components['schemas']['OperationStatusOutput'];
export type StatsResponse = components['schemas']['StatsResponse'];

// Sandbox-specific item type
export interface SandboxItem {
  execUrl: string;
  id: string;
}

// Typed borrow output for sandbox
export interface SandboxBorrowOutput {
  item: SandboxItem;
  borrow_token: string;
}

// Typed return input for sandbox
export interface SandboxReturnInput {
  item: SandboxItem;
  borrow_token: string;
  params?: {
    sessionId?: string;
    [key: string]: unknown;
  };
}

// Borrowed sandbox data with session context
export interface BorrowedSandbox {
  item: SandboxItem;
  borrowToken: string;
  sessionId: string;
}

// Exec command request
export interface ExecRequest {
  command: string;
}

// Exec command response
export interface ExecResponse {
  commandId: string;
  status: 'started' | 'completed' | 'error';
  exitCode?: number;
  error?: string;
}

// Logs request parameters
export interface LogsParams {
  commandId: string;
  offset?: number;
  search?: string;
}

// Logs response
export interface LogsResponse {
  logs: string;
  offset: number;
  done: boolean;
  exitCode?: number;
}

// Operation status
export type OperationStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed';
