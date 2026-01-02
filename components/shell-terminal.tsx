'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Terminal, CheckCircle2, XCircle, Loader2, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ShellTerminalProps {
  streamId: string;
  command: string;
  className?: string;
}

interface ShellStreamState {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
  done: boolean;
}

export function ShellTerminal({
  streamId,
  command,
  className,
}: ShellTerminalProps) {
  const [state, setState] = useState<ShellStreamState>({
    stdout: '',
    stderr: '',
    exitCode: null,
    error: null,
    done: false,
  });
  const [isConnected, setIsConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Connect to SSE endpoint
    const eventSource = new EventSource(`/api/shell/stream?id=${streamId}`);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setIsConnected(true);
    };

    eventSource.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case 'initial':
            setState({
              stdout: message.data.stdout || '',
              stderr: message.data.stderr || '',
              exitCode: message.data.exitCode,
              error: message.data.error,
              done: message.data.done,
            });
            break;

          case 'stdout':
            setState((prev) => ({
              ...prev,
              stdout: prev.stdout + message.data,
            }));
            break;

          case 'stderr':
            setState((prev) => ({
              ...prev,
              stderr: prev.stderr + message.data,
            }));
            break;

          case 'complete':
            setState((prev) => ({
              ...prev,
              exitCode: message.data.exitCode,
              error: message.data.error,
              done: true,
            }));
            break;

          case 'error':
            setState((prev) => ({
              ...prev,
              error: message.error,
              done: true,
            }));
            break;

          case 'done':
            eventSource.close();
            setIsConnected(false);
            break;
        }
      } catch (e) {
        console.error('Failed to parse SSE message:', e);
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [streamId]);

  // Auto-scroll to bottom when output changes
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [state.stdout, state.stderr]);

  const handleCopy = async () => {
    const output = state.stdout + (state.stderr ? `\n${state.stderr}` : '');
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getStatusIcon = () => {
    if (!state.done) {
      return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
    }
    if (state.exitCode === 0) {
      return <CheckCircle2 className="size-4 text-green-500" />;
    }
    return <XCircle className="size-4 text-red-500" />;
  };

  const getStatusText = () => {
    if (!state.done) {
      return 'Running...';
    }
    if (state.error) {
      return `Error: ${state.error}`;
    }
    return `Exit code: ${state.exitCode}`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden bg-zinc-900',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-800 border-b border-zinc-700">
        <div className="flex items-center gap-2">
          <Terminal className="size-4 text-zinc-400" />
          <span className="text-xs font-mono text-zinc-400 truncate max-w-[300px]">
            {command}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 hover:bg-zinc-700 rounded transition-colors"
            title="Copy output"
          >
            {copied ? (
              <Check className="size-3.5 text-green-500" />
            ) : (
              <Copy className="size-3.5 text-zinc-400" />
            )}
          </button>
          <div className="flex items-center gap-1.5">
            {getStatusIcon()}
            <span className="text-xs text-zinc-400">{getStatusText()}</span>
          </div>
        </div>
      </div>

      {/* Output */}
      <pre
        ref={outputRef}
        className="p-3 text-xs font-mono text-zinc-100 overflow-auto max-h-[400px] min-h-[100px] whitespace-pre-wrap break-all"
      >
        {state.stdout}
        {state.stderr && (
          <span className="text-red-400">{state.stderr}</span>
        )}
        {!state.stdout && !state.stderr && !state.done && (
          <span className="text-zinc-500">Waiting for output...</span>
        )}
        {state.done && !state.stdout && !state.stderr && !state.error && (
          <span className="text-zinc-500">Command completed with no output</span>
        )}
      </pre>
    </motion.div>
  );
}
