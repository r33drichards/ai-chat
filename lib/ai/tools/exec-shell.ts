import { ModalClient, type Secret } from 'modal';
import { z } from 'zod';
import { tool, type UIMessageStreamWriter } from 'ai';
import type { Session } from 'next-auth';
import {
  createShellStream,
  updateShellStream,
  getShellStream,
} from '@/lib/db/queries';
import type { ChatMessage } from '@/lib/types';

const SANDBOX_HOME = '/sandbox';

// Lazy-initialized Modal client
let modalClient: ModalClient | null = null;

function getModalClient(): ModalClient {
  if (!modalClient) {
    modalClient = new ModalClient();
  }
  return modalClient;
}

function sanitizeVolumeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
}

// CIDR allowlist for network restrictions (GitHub only)
const CIDR_ALLOWLIST = [
  // GitHub core infrastructure
  '192.30.252.0/22',
  '185.199.108.0/22',
  '140.82.112.0/20',
  // GitHub Azure IPs for git/api
  '20.201.28.0/24',
  '20.205.243.0/24',
  '20.87.245.0/24',
  '4.148.0.0/16',
  '20.200.245.0/24',
  '20.233.83.0/24',
];

/**
 * Build the Docker image for the sandbox
 */
function buildSandboxImage(modal: ModalClient) {
  return modal.images
    .fromRegistry('ubuntu:24.04')
    .dockerfileCommands([
      // Avoid interactive prompts
      'ENV DEBIAN_FRONTEND=noninteractive',
      // Base dependencies
      'RUN apt-get update && apt-get install -y --no-install-recommends bash curl git ca-certificates ripgrep',
      // Install Python 3 and pip
      'RUN apt-get install -y --no-install-recommends python3 python3-pip python3-venv',
      // Install Go
      'RUN apt-get install -y --no-install-recommends golang-go',
      // Install GitHub CLI
      'RUN apt-get install -y --no-install-recommends gh',
      // Install Node.js 20 LTS via NodeSource
      'RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs',
      // Cleanup apt cache
      'RUN apt-get clean && rm -rf /var/lib/apt/lists/*',
      // Pre-install package managers
      'RUN npm install -g pnpm yarn || true',
      // Create /sandbox directory
      `RUN mkdir -p ${SANDBOX_HOME}`,
      `ENV HOME=${SANDBOX_HOME} PATH=${SANDBOX_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      // Set working directory to sandbox
      `WORKDIR ${SANDBOX_HOME}`,
    ]);
}

/**
 * Generate a unique stream ID
 */
function generateStreamId(): string {
  return `stream-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Execute a shell command in a Modal sandbox with streaming output
 */
async function execShellInSandboxStreaming({
  command,
  sessionId,
  streamId,
  timeoutMs = 5 * 60 * 1000, // 5 minute default timeout
  appName = 'pgchat-sandbox',
}: {
  command: string;
  sessionId: string;
  streamId: string;
  timeoutMs?: number;
  appName?: string;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxId: string;
}> {
  const modal = getModalClient();

  const app = await modal.apps.fromName(appName, {
    createIfMissing: true,
  });

  const image = buildSandboxImage(modal);
  const homeVolumeName = sanitizeVolumeName(`home-${sessionId}`);

  // Create or get persistent home volume (per session for isolation)
  const homeVolume = await modal.volumes.fromName(homeVolumeName, {
    createIfMissing: true,
  });

  const volumes: Record<string, typeof homeVolume> = {
    [SANDBOX_HOME]: homeVolume,
  };

  // Create sandbox with CIDR allowlist (GitHub only) and resource limits
  const sb = await modal.sandboxes.create(app, image, {
    volumes,
    cidrAllowlist: CIDR_ALLOWLIST,
    // Set sandbox lifetime timeout (same as command timeout)
    timeoutMs,
    // Resource allocation: 0.5 CPU cores and 512 MiB memory
    cpu: 0.5,
    memoryMiB: 512,
  });
  console.log(
    '[Modal] Started Shell Sandbox:',
    sb.sandboxId,
    'with network restrictions',
  );

  let fullStdout = '';
  let fullStderr = '';

  try {
    // Get the github-secret which contains GITHUB_TOKEN
    let secret: Secret | undefined;

    try {
      secret = await modal.secrets.fromName('github-secret', {
        requiredKeys: ['GITHUB_TOKEN'],
      });
      console.log('[Modal] Successfully loaded github-secret');
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.warn('[Modal] Failed to load github-secret:', errorMsg);
      // Try without required keys to see if secret exists at all
      try {
        secret = await modal.secrets.fromName('github-secret');
        console.log('[Modal] Secret exists but may be missing required keys');
      } catch {
        console.warn(
          '[Modal] github-secret does not exist, proceeding without auth',
        );
      }
    }

    // Authenticate gh CLI with the GitHub token if available
    if (secret) {
      const ghAuth = await sb.exec(['gh', 'auth', 'setup-git'], {
        secrets: [secret],
        workdir: SANDBOX_HOME,
      });
      await ghAuth.wait();
      console.log('[Modal] Authenticated gh CLI');
    }

    // Run the shell command directly
    const shellCmd = ['bash', '-c', command];
    console.log('[Modal] Running shell command:', command);

    const shell = await sb.exec(shellCmd, {
      secrets: secret ? [secret] : [],
      workdir: SANDBOX_HOME,
      timeoutMs,
    });

    // Stream stdout and stderr concurrently using ReadableStream readers
    const stdoutReader = shell.stdout.getReader();
    const stderrReader = shell.stderr.getReader();

    // Read from both streams concurrently
    const readStream = async (
      reader: ReadableStreamDefaultReader<string>,
      type: 'stdout' | 'stderr',
    ) => {
      let buffer = '';

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          // ModalReadStream<string> returns strings directly
          buffer += value;

          if (type === 'stdout') {
            fullStdout = buffer;
            await updateShellStream({ id: streamId, stdout: buffer });
          } else {
            fullStderr = buffer;
            await updateShellStream({ id: streamId, stderr: buffer });
          }
        }
      } finally {
        reader.releaseLock();
      }

      return buffer;
    };

    // Start reading both streams
    await Promise.all([
      readStream(stdoutReader, 'stdout'),
      readStream(stderrReader, 'stderr'),
    ]);

    // Wait for command to complete
    const exitCode = await shell.wait();

    console.log('[Modal] Shell command completed with exit code:', exitCode);

    // Update stream with final state
    await updateShellStream({
      id: streamId,
      stdout: fullStdout,
      stderr: fullStderr,
      exitCode,
      done: true,
    });

    if (fullStderr) {
      console.log('[Modal] Shell stderr:', fullStderr.substring(0, 500));
    }

    return {
      stdout: fullStdout,
      stderr: fullStderr,
      exitCode,
      sandboxId: sb.sandboxId,
    };
  } catch (error) {
    // Update stream with error
    await updateShellStream({
      id: streamId,
      error: error instanceof Error ? error.message : 'Unknown error',
      done: true,
    });
    throw error;
  } finally {
    await sb.terminate();
  }
}

interface ExecShellProps {
  session: Session;
  dataStream: UIMessageStreamWriter<ChatMessage>;
  chatId: string;
}

export const execShell = ({ session, dataStream, chatId }: ExecShellProps) =>
  tool({
    description: `Execute a shell command in a secure Modal sandbox with real-time streaming output.
The sandbox has a persistent home directory per session, so you can clone repos and they will persist across tool calls.
Use this for tasks like: cloning repos (git clone), running tests, building code, executing scripts, etc.

Example workflow:
1. Clone a repo: git clone https://github.com/owner/repo
2. Navigate and run commands: cd repo && npm install && npm test

The home directory is ${SANDBOX_HOME} and persists across calls with the same sessionId.
Network access is restricted to GitHub only.

IMPORTANT: This tool returns immediately with a streamId. The command runs asynchronously.
Use the getShellResult tool with the streamId to wait for completion and get the final output.
The UI will show real-time streaming output.`,
    inputSchema: z.object({
      command: z
        .string()
        .describe('The shell command to execute (will be run with bash -c)'),
      sessionId: z
        .string()
        .uuid('Session ID must be a valid UUID')
        .describe(
          'A unique session ID (UUID format) for persistence. Use the same ID across related tool calls to maintain state.',
        ),
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
      sessionId,
      timeoutMs,
    }: {
      command: string;
      sessionId: string;
      timeoutMs?: number;
    }) => {
      // Generate a unique stream ID
      const streamId = generateStreamId();

      // Create the shell stream in the database
      await createShellStream({
        id: streamId,
        sessionId,
        chatId,
        command,
      });

      console.log(
        '[Modal] Starting shell command in sandbox with streaming, streamId:',
        streamId,
      );

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

      // Start execution asynchronously - don't await
      execShellInSandboxStreaming({
        command,
        sessionId,
        streamId,
        timeoutMs,
      }).catch((error) => {
        console.error('[Modal] Error executing shell command in sandbox:', error);
        updateShellStream({
          id: streamId,
          error: error instanceof Error ? error.message : 'Unknown error',
          done: true,
        });
      });

      // Return immediately with streamId
      return {
        status: 'streaming',
        streamId,
        sessionId,
        command,
        message:
          'Command started. Use getShellResult to wait for completion, or the UI will show real-time output.',
      };
    },
  });

interface GetShellResultProps {
  session: Session;
}

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

export const clearSandboxState = tool({
  description:
    'Clear the persistent state (volumes) for a sandbox session. Use this to start fresh with a clean state.',
  inputSchema: z.object({
    sessionId: z
      .string()
      .uuid('Session ID must be a valid UUID')
      .describe('The session ID (UUID format) whose state should be cleared'),
  }),
  execute: async ({ sessionId }: { sessionId: string }) => {
    try {
      const modal = getModalClient();
      const homeVolumeName = sanitizeVolumeName(`home-${sessionId}`);

      try {
        await modal.volumes.delete(homeVolumeName, { allowMissing: true });
        return {
          success: true,
          clearedVolume: homeVolumeName,
          message: `Cleared volume: ${homeVolumeName}`,
        };
      } catch {
        return {
          success: true,
          message: 'No volume found to clear',
        };
      }
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Unknown error clearing sandbox state',
      };
    }
  },
});
