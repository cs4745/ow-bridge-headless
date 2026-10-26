import { createHash } from 'node:crypto';

export const CONVERSATION_IDLE_TTL = 30 * 60 * 1000;
export const MAX_IDLE_CONVERSATIONS = 32;

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const messageKey = (message, images = []) => hash({ message, images });
const normalizedReply = message => ({ role: 'assistant', content: message.content ?? '',
  ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) });

function history(request) {
  const messages = JSON.parse(request.text);
  const keys = messages.map((message, index) => messageKey(message,
    (request.images || []).filter(image => image.filename.startsWith(`message-${index + 1}-image-`))));
  return { messages, keys };
}
function waitFor(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Match only explicit client conversation IDs and exact history prefixes. Never infer
// identity from a shared opening prompt: two separate chats may start identically.
export class Conversations {
  constructor(discard) {
    this.discard = discard; this.entries = new Map(); this.queues = new Map();
    this.cleanups = new Set(); this.closed = false;
  }
  release(key) {
    const entry = this.entries.get(key);
    this.entries.delete(key); // Remove before asynchronous deletion so it cannot be leased again.
    const task = Promise.resolve().then(() => this.discard(entry.session.id));
    this.cleanups.add(task);
    task.then(() => this.cleanups.delete(task), () => this.cleanups.delete(task));
    return task;
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.closed || !this.entries.size) return;
    const expires = Math.min(...[...this.entries.values()].map(entry => entry.expires));
    this.timer = setTimeout(() => this.prune(), Math.max(0, expires - Date.now()));
    this.timer.unref?.();
  }
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries)
      if (entry.expires <= now) this.release(key);
    // Entries are reinserted on completion: oldest idle entry is first.
    while (this.entries.size > MAX_IDLE_CONVERSATIONS) this.release(this.entries.keys().next().value);
    this.schedule();
  }
  run(request, signal, complete) {
    const key = request.conversationKey;
    const previous = this.queues.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      if (this.closed) throw new Error('OpenCode service is stopping');
      this.prune();
      const incoming = history(request);
      const signature = hash([request.model.id, request.variant, request.system, request.tools, request.chatOnly, request.choice, request.forced, request.parallel]);
      let entry = this.entries.get(key);
      const continues = entry?.signature === signature && incoming.keys.length > entry.expected.length
        && entry.expected.every((value, index) => incoming.keys[index] === value);
      if (entry && !continues) { await this.release(key); entry = null; }
      const offset = entry?.expected.length || 0;
      const lease = { session: entry?.session, toolCalls: entry?.toolCalls, text: JSON.stringify(incoming.messages.slice(offset)),
        images: (request.images || []).filter(image => Number(/^message-(\d+)-/.exec(image.filename)?.[1]) > offset) };
      this.entries.delete(key); // Active requests are never eligible for idle eviction.
      this.schedule();
      try {
        const result = await complete(lease);
        signal?.throwIfAborted();
        if (!this.closed && lease.reusable) {
          this.entries.set(key, { expires: Date.now() + CONVERSATION_IDLE_TTL, session: lease.session, signature, toolCalls: result.choices[0].message.tool_calls?.map(call => ({ id: call.id, function: { name: call.function.name } })),
            expected: [...incoming.keys, messageKey(normalizedReply(result.choices[0].message))] });
          this.prune();
        } else if (lease.reusable) await this.discard(lease.session.id);
        return result;
      } catch (error) {
        // complete() cleans failed sessions; a cancellation after completion also needs cleanup.
        if (lease.reusable) await this.discard(lease.session.id);
        throw error;
      }
    });
    this.queues.set(key, task);
    task.finally(() => { if (this.queues.get(key) === task) this.queues.delete(key); }).catch(() => {});
    return waitFor(task, signal);
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const key of this.entries.keys()) this.release(key);
    await Promise.allSettled([...this.cleanups]);
  }
}
