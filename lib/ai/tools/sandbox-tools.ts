import { z } from 'zod';
import { tool, type UIMessageStreamWriter } from 'ai';
import type { Session } from 'next-auth';
import {
  AgentSession,
  type AgentSessionData,
} from '@/lib/sandbox';
import {
  getSandboxSessionByChatId,
  upsertSandboxSession,
  createShellStream,
  updateShellStream,
  getShellStream,
} from '@/lib/db/queries';
import type { ChatMessage } from '@/lib/types';

/**
 * Generate a unique stream ID for tracking shell execution
 */
function generateStreamId(): string {
  return `stream-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Load or create an AgentSession for the given chat
 */
async function getAgentSession(chatId: string): Promise<AgentSession> {
  // Try to load existing session from database
  const existingSession = await getSandboxSessionByChatId({ chatId });

  let initialData: AgentSessionData | undefined;
  if (existingSession?.sandboxId && existingSession?.execUrl && existingSession?.borrowToken) {
    initialData = {
      sessionId: existingSession.sessionId,
      item: {
        id: existingSession.sandboxId,
        execUrl: existingSession.execUrl,
      },
      borrowToken: existingSession.borrowToken,
      borrowedAt: existingSession.borrowedAt,
    };
  }

  const sessionId = existingSession?.sessionId ?? chatId;

  return new AgentSession({
    sessionId,
    initialData,
    onSessionDataChange: async (data) => {
      await upsertSandboxSession({
        sessionId: data.sessionId,
        chatId,
        sandboxId: data.item?.id ?? null,
        execUrl: data.item?.execUrl ?? null,
        borrowToken: data.borrowToken,
        borrowedAt: data.borrowedAt,
      });
    },
  });
}

interface ExecShellProps {
  session: Session;
  dataStream: UIMessageStreamWriter<ChatMessage>;
  chatId: string;
}

/**
 * Execute a shell command in a sandbox from the object pool
 */
export const execShell = ({ session, dataStream, chatId }: ExecShellProps) =>
  tool({
    description: `Execute a shell command in a secure sandbox with real-time streaming output.
The sandbox is borrowed from a pool and persists for the duration of this conversation.
Use this for tasks like: running tests, building code, executing scripts, installing packages, etc.

Available tools: Node.js 20, Python 3, Go, npm, pnpm, yarn, pip, ripgrep, gh (GitHub CLI), and common shell utilities.

IMPORTANT: This tool returns immediately with a streamId. The command runs asynchronously.
Use the getShellResult tool with the streamId to wait for completion and get the final output.
The UI will show real-time streaming output.`,
    inputSchema: z.object({
      command: z
        .string()
        .describe('The shell command to execute (will be run with bash -c)'),
      timeoutMs: z
        .number()
        .min(1000)
        .max(10 * 60 * 1000)
        .optional()
        .describe(
          'Timeout in milliseconds (default: 5 minutes, max: 10 minutes)',
        ),
    }),
    execute: async ({
      command,
      timeoutMs = 5 * 60 * 1000,
    }: {
      command: string;
      timeoutMs?: number;
    }) => {
      const streamId = generateStreamId();
      const sessionId = chatId;

      // Create the shell stream in the database
      await createShellStream({
        id: streamId,
        sessionId,
        chatId,
        command,
      });

      console.log('[Sandbox] Starting shell command, streamId:', streamId);

      // Notify the UI about the new shell stream
      dataStream.write({
        type: 'data-shellStreamId',
        data: streamId,
        transient: true,
      });

      dataStream.write({
        type: 'data-shellCommand',
        data: command,
        transient: true,
      });

      // Start execution asynchronously
      (async () => {
        try {
          const agentSession = await getAgentSession(chatId);

          // Execute the command
          const execResult = await agentSession.exec(command);
          console.log('[Sandbox] Command started:', execResult.commandId);

          // Poll for logs and stream them
          let offset = -1;
          let lastStdout = '';
          let lastStderr = '';

          const startTime = Date.now();
          while (Date.now() - startTime < timeoutMs) {
            const logsResult = await agentSession.logs(execResult.commandId, offset);

            // Update stream with new output
            if (logsResult.logs !== lastStdout) {
              lastStdout = logsResult.logs;
              await updateShellStream({ id: streamId, stdout: lastStdout });
            }

            if (logsResult.done) {
              console.log('[Sandbox] Command completed with exit code:', logsResult.exitCode);
              await updateShellStream({
                id: streamId,
                stdout: logsResult.logs,
                exitCode: logsResult.exitCode ?? 0,
                done: true,
              });
              break;
            }

            offset = logsResult.offset;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }

          // Check for timeout
          if (Date.now() - startTime >= timeoutMs) {
            await updateShellStream({
              id: streamId,
              error: 'Command timed out',
              done: true,
            });
          }
        } catch (error) {
          console.error('[Sandbox] Error executing shell command:', error);
          await updateShellStream({
            id: streamId,
            error: error instanceof Error ? error.message : 'Unknown error',
            done: true,
          });
        }
      })();

      // Return immediately with streamId
      return {
        status: 'streaming',
        streamId,
        command,
        message:
          'Command started. Use getShellResult to wait for completion, or the UI will show real-time output.',
      };
    },
  });

interface GetShellResultProps {
  session: Session;
}

/**
 * Wait for a shell command to complete and get the result
 */
export const getShellResult = ({ session }: GetShellResultProps) =>
  tool({
    description: `Wait for a shell command to complete and get the result.
Use this after calling execShell to wait for the command to finish and retrieve the output.
The streamId is returned by execShell when you start a command.`,
    inputSchema: z.object({
      streamId: z.string().describe('The stream ID returned by execShell'),
      timeoutMs: z
        .number()
        .min(1000)
        .max(10 * 60 * 1000)
        .optional()
        .describe(
          'Maximum time to wait in milliseconds (default: 5 minutes)',
        ),
    }),
    execute: async ({
      streamId,
      timeoutMs = 5 * 60 * 1000,
    }: {
      streamId: string;
      timeoutMs?: number;
    }) => {
      const startTime = Date.now();

      // Poll until done or timeout
      while (Date.now() - startTime < timeoutMs) {
        const stream = await getShellStream({ id: streamId });

        if (!stream) {
          return {
            success: false,
            error: 'Stream not found. It may have expired or never existed.',
            streamId,
          };
        }

        if (stream.done) {
          return {
            success: stream.exitCode === 0,
            streamId,
            exitCode: stream.exitCode,
            stdout: stream.stdout,
            stderr: stream.stderr || null,
            error: stream.error || null,
          };
        }

        // Wait a bit before polling again
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Timeout
      const stream = await getShellStream({ id: streamId });
      return {
        success: false,
        error: 'Timeout waiting for command to complete',
        streamId,
        stdout: stream?.stdout || '',
        stderr: stream?.stderr || '',
      };
    },
  });

interface ClearSandboxStateProps {
  chatId: string;
}

/**
 * Clear the sandbox state and return it to the pool
 */
export const clearSandboxState = ({ chatId }: ClearSandboxStateProps) =>
  tool({
    description:
      "Release the current sandbox back to the pool and clear session state. Use this to start fresh with a new sandbox.",
    inputSchema: z.object({}),
    execute: async (): Promise<{
      success: boolean;
      message?: string;
      error?: string;
    }> => {
      try {
        const agentSession = await getAgentSession(chatId);

        if (!agentSession.hasSandbox()) {
          return {
            success: true,
            message: 'No sandbox was active',
          };
        }

        await agentSession.releaseSandbox();

        return {
          success: true,
          message: 'Sandbox released back to pool',
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Unknown error releasing sandbox',
        };
      }
    },
  });
