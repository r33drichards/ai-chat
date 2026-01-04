# Sandbox Object Pool Integration

This module provides sandbox management using an object pool pattern via the [ip-allocator-webserver](https://github.com/r33drichards/ip-allocator-webserver).

## Configuration

### Environment Variables

```bash
# Required: URL of your ip-allocator-webserver instance
SANDBOX_POOL_URL=http://localhost:8080

# Optional: Database connection (already configured in main app)
POSTGRES_URL=postgres://...
```

### Database Migration

After adding the schema, run migrations:

```bash
pnpm db:generate
pnpm db:migrate
```

This creates the `SandboxSession` table for persisting sandbox state across requests.

## ip-allocator-webserver Setup

### 1. Deploy the allocator

```bash
git clone https://github.com/r33drichards/ip-allocator-webserver
cd ip-allocator-webserver
cargo build --release
```

### 2. Configure subscribers

Create a `config.toml` with borrow/return subscribers that handle sandbox lifecycle:

```toml
# Called when a sandbox is borrowed
[borrow.subscribers.attach-snapshot]
post = "http://your-sandbox-controller/borrow"
mustSuceed = true
async = true

# Called when a sandbox is returned
[return.subscribers.create-snapshot]
post = "http://your-sandbox-controller/return"
mustSuceed = true
async = true
```

### 3. Submit sandbox items to the pool

Each sandbox item needs an `execUrl` and `id`:

```bash
curl -X POST http://localhost:8080/submit \
  -H "Content-Type: application/json" \
  -d '{
    "item": {
      "id": "sandbox-1",
      "execUrl": "http://sandbox-1.internal:8080"
    }
  }'
```

## Subscriber Implementation

Your sandbox controller needs to implement these webhook endpoints:

### Borrow Subscriber

Called when a sandbox is borrowed. Should attach the session's snapshot to the VM.

```
POST /borrow
Content-Type: application/json

{
  "item": {
    "id": "sandbox-1",
    "execUrl": "http://sandbox-1.internal:8080"
  },
  "params": {
    "sessionId": "chat-uuid-123"
  }
}
```

Implementation should:
1. Check if a snapshot exists for this `sessionId`
2. If yes: attach/mount that snapshot to the sandbox VM
3. If no: mount a blank/fresh snapshot
4. Return `{"status": "succeeded"}` when ready

### Return Subscriber

Called when a sandbox is returned to the pool. Should save the session's state.

```
POST /return
Content-Type: application/json

{
  "item": {
    "id": "sandbox-1",
    "execUrl": "http://sandbox-1.internal:8080"
  },
  "params": {
    "sessionId": "chat-uuid-123"
  }
}
```

Implementation should:
1. Create/update a snapshot from the current VM state
2. Associate snapshot with the `sessionId`
3. Detach and clean up the VM for the next user
4. Return `{"status": "succeeded"}` when complete

## Sandbox Exec API

Each sandbox VM must expose these HTTP endpoints:

### Execute Command

```
POST /exec
Content-Type: application/json

{
  "command": "echo hello"
}

Response:
{
  "commandId": "cmd-123",
  "status": "started"
}
```

### Get Logs

```
GET /logs/{commandId}?offset=-1&search=*

Response:
{
  "logs": "hello\n",
  "offset": 6,
  "done": true,
  "exitCode": 0
}
```

## Usage in Code

### Using AgentSession directly

```typescript
import { AgentSession } from '@/lib/sandbox';

const session = new AgentSession({
  sessionId: chatId,
  onSessionDataChange: async (data) => {
    // Persist to database
    await upsertSandboxSession({
      sessionId: data.sessionId,
      chatId,
      sandboxId: data.item?.id,
      execUrl: data.item?.execUrl,
      borrowToken: data.borrowToken,
      borrowedAt: data.borrowedAt,
    });
  },
});

// Execute a command
const result = await session.execAndWait('npm test');
console.log(result.logs.logs);

// When done with the session
await session.releaseSandbox();
```

### Using the AI Tools

The `sandbox-tools.ts` provides AI SDK compatible tools:

```typescript
import { execShell, getShellResult, clearSandboxState } from '@/lib/ai/tools/sandbox-tools';

// In your streamText call
const tools = {
  execShell: execShell({ session, dataStream, chatId }),
  getShellResult: getShellResult({ session }),
  clearSandboxState: clearSandboxState({ chatId }),
};
```

## Switching from Modal

To switch from the Modal-based `exec-shell.ts` to the pool-based `sandbox-tools.ts`:

1. Update your tool imports in the chat route:

```typescript
// Before
import { execShell, getShellResult, clearSandboxState } from '@/lib/ai/tools/exec-shell';

// After
import { execShell, getShellResult, clearSandboxState } from '@/lib/ai/tools/sandbox-tools';
```

2. Set the `SANDBOX_POOL_URL` environment variable

3. Deploy your sandbox pool infrastructure

## Architecture

```
┌─────────────┐     ┌───────────────────┐     ┌─────────────────┐
│   AI Chat   │────▶│  ip-allocator     │────▶│  Sandbox VMs    │
│   (Next.js) │     │  (object pool)    │     │  (exec API)     │
└─────────────┘     └───────────────────┘     └─────────────────┘
      │                     │                         │
      │                     │ webhooks                │
      │                     ▼                         │
      │             ┌───────────────────┐            │
      │             │ Sandbox Controller │◀───────────┘
      │             │ (snapshot mgmt)    │
      │             └───────────────────┘
      │                     │
      ▼                     ▼
┌─────────────┐     ┌───────────────────┐
│  PostgreSQL │     │  Snapshot Storage │
│  (sessions) │     │  (VM state)       │
└─────────────┘     └───────────────────┘
```

## Troubleshooting

### "SANDBOX_POOL_URL environment variable is not set"

Set the environment variable pointing to your ip-allocator-webserver:

```bash
export SANDBOX_POOL_URL=http://localhost:8080
```

### "No sandboxes available in the pool"

Submit sandbox items to the pool or check that VMs are healthy:

```bash
# Check pool stats
curl http://localhost:8080/admin/stats

# List available items
curl http://localhost:8080/admin/items
```

### "Invalid borrow token"

The borrow token has expired or the session was already returned. The session will automatically borrow a new sandbox on the next exec call.
