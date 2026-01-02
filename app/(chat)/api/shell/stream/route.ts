import { auth } from '@/app/(auth)/auth';
import { getShellStream } from '@/lib/db/queries';
import { ChatSDKError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/**
 * SSE endpoint for streaming shell output in real-time.
 * Clients subscribe to this endpoint with a stream ID to receive updates.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const streamId = searchParams.get('id');

  if (!streamId) {
    return new ChatSDKError('bad_request:api', 'Missing stream ID').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  // Check if stream exists
  const initialStream = await getShellStream({ id: streamId });
  if (!initialStream) {
    return new ChatSDKError('not_found:database', 'Stream not found').toResponse();
  }

  // Create SSE stream
  const encoder = new TextEncoder();
  let isClientConnected = true;

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial state
      const sendEvent = (data: object) => {
        if (!isClientConnected) return;
        try {
          const eventData = `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(eventData));
        } catch {
          // Client disconnected
          isClientConnected = false;
        }
      };

      // Send initial stream data
      sendEvent({
        type: 'initial',
        data: {
          id: initialStream.id,
          sessionId: initialStream.sessionId,
          command: initialStream.command,
          stdout: initialStream.stdout,
          stderr: initialStream.stderr,
          exitCode: initialStream.exitCode,
          error: initialStream.error,
          done: initialStream.done,
        },
      });

      // If already done, close the stream
      if (initialStream.done) {
        sendEvent({ type: 'done' });
        controller.close();
        return;
      }

      // Poll for updates
      let lastStdoutLength = initialStream.stdout.length;
      let lastStderrLength = initialStream.stderr.length;
      let pollCount = 0;
      const maxPolls = 600; // 5 minutes at 500ms intervals

      const poll = async () => {
        if (!isClientConnected || pollCount >= maxPolls) {
          controller.close();
          return;
        }

        pollCount++;

        try {
          const currentStream = await getShellStream({ id: streamId });

          if (!currentStream) {
            sendEvent({ type: 'error', error: 'Stream not found' });
            controller.close();
            return;
          }

          // Send stdout updates
          if (currentStream.stdout.length > lastStdoutLength) {
            const newStdout = currentStream.stdout.substring(lastStdoutLength);
            sendEvent({ type: 'stdout', data: newStdout });
            lastStdoutLength = currentStream.stdout.length;
          }

          // Send stderr updates
          if (currentStream.stderr.length > lastStderrLength) {
            const newStderr = currentStream.stderr.substring(lastStderrLength);
            sendEvent({ type: 'stderr', data: newStderr });
            lastStderrLength = currentStream.stderr.length;
          }

          // Check if done
          if (currentStream.done) {
            sendEvent({
              type: 'complete',
              data: {
                exitCode: currentStream.exitCode,
                error: currentStream.error,
              },
            });
            sendEvent({ type: 'done' });
            controller.close();
            return;
          }

          // Continue polling
          setTimeout(poll, 500);
        } catch (error) {
          sendEvent({
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          controller.close();
        }
      };

      // Start polling
      setTimeout(poll, 500);
    },
    cancel() {
      isClientConnected = false;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
