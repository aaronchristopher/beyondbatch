import { setTimeout as delay } from 'node:timers/promises';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGES = 1000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_RETRY_MS = 60_000;
const MESSAGE_FIELDS = ['id', 'parentFolderId', 'changeKey', 'receivedDateTime', 'sentDateTime',
  'lastModifiedDateTime', 'internetMessageId', 'conversationId', 'subject', 'from', 'sender',
  'toRecipients', 'ccRecipients', 'isDraft', 'hasAttachments', 'webLink'];
const FOLDER_FIELDS = ['id', 'displayName', 'parentFolderId', 'childFolderCount',
  'totalItemCount', 'unreadItemCount', 'isHidden'];
const CONTENT_FIELDS = [...MESSAGE_FIELDS, 'body', 'uniqueBody', 'internetMessageHeaders'];

/** Safe errors intentionally omit provider bodies, tokens, and opaque cursor URLs. */
export class GraphReadError extends Error {
  constructor(code, message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'GraphReadError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

function fail(code, message, details) {
  throw new GraphReadError(code, message, details);
}

function guid(value, label) {
  if (typeof value !== 'string' || !GUID.test(value)) {
    fail('INVALID_CONFIG', `${label} must be an Entra object GUID.`);
  }
  return value.toLowerCase();
}

function folderIdentifier(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 ||
      /[\x00-\x20\x7f?#%:\\]/.test(value) || /(^|\/)\.{1,2}(\/|$)/.test(value)) {
    fail('INVALID_FOLDER', 'A valid opaque folder identifier is required.');
  }
  return value;
}

function decodeSegment(value) {
  try { return decodeURIComponent(value); } catch {
    fail('UNSAFE_GRAPH_URL', 'Graph cursor contains an invalid path encoding.');
  }
}

/** Validate resource identity without rewriting the opaque query or token. */
function validateUrl(raw, mailboxId, folderId, kind) {
  if (typeof raw !== 'string' || raw.length > 16_384 || /[\x00-\x20\x7f\\]/.test(raw)) {
    fail('UNSAFE_GRAPH_URL', 'Graph cursor is invalid.');
  }
  // Reject ambiguous authority syntax and path normalization before URL parsing.
  const match = /^https:\/\/graph\.microsoft\.com(\/[^?#]*)(?:\?[^#]*)?$/.exec(raw);
  if (!match) fail('UNSAFE_GRAPH_URL', 'Graph cursor origin is not approved.');
  let parsed;
  try { parsed = new URL(raw); } catch {
    fail('UNSAFE_GRAPH_URL', 'Graph cursor is invalid.');
  }
  if (parsed.origin !== GRAPH_ORIGIN || parsed.username || parsed.password || parsed.hash ||
      parsed.pathname !== match[1]) fail('UNSAFE_GRAPH_URL', 'Graph cursor is not canonical.');
  const parts = match[1].split('/').slice(1);
  if (parts[0] !== 'v1.0' || parts[1]?.toLowerCase() !== 'users' ||
      decodeSegment(parts[2] ?? '').toLowerCase() !== mailboxId) {
    fail('UNSAFE_GRAPH_URL', 'Graph cursor is outside the approved mailbox.');
  }
  if (kind === 'folders') {
    const root = !folderId && parts.length === 4 && parts[3].toLowerCase() === 'mailfolders';
    const child = folderId && parts.length === 6 && parts[3].toLowerCase() === 'mailfolders' &&
      decodeSegment(parts[4]) === folderId && parts[5].toLowerCase() === 'childfolders';
    if (!root && !child) {
      fail('UNSAFE_GRAPH_URL', 'Graph cursor changes the folder collection.');
    }
  } else if (kind === 'message') {
    if (parts.length !== 5 || parts[3].toLowerCase() !== 'messages' || decodeSegment(parts[4]) !== folderId) {
      fail('UNSAFE_GRAPH_URL', 'Graph request changes the approved message or operation.');
    }
  } else {
    // Graph may return the documented mailfolders('opaque-id') OData form.
    const odata = /^mailfolders\('(.+)'\)$/i.exec(parts[3] ?? '');
    const actualFolder = odata ? decodeSegment(odata[1]).replaceAll("''", "'") : decodeSegment(parts[4] ?? '');
    const validPath = odata
      ? parts.length === 6 && parts[4].toLowerCase() === 'messages' && parts[5] === 'delta'
      : parts.length === 7 && parts[3]?.toLowerCase() === 'mailfolders' &&
        parts[5].toLowerCase() === 'messages' && parts[6] === 'delta';
    if (!validPath || actualFolder !== folderId) {
      fail('UNSAFE_GRAPH_URL', 'Graph cursor changes the approved folder or operation.');
    }
  }
  const keys = new Set();
  const permittedFields = kind === 'folders' ? FOLDER_FIELDS : kind === 'message' ? CONTENT_FIELDS : MESSAGE_FIELDS;
  for (const [name, value] of parsed.searchParams) {
    const key = name.toLowerCase();
    if (keys.has(key)) fail('UNSAFE_GRAPH_URL', 'Graph cursor repeats a query option.');
    keys.add(key);
    if (key === '$select') {
      if (!value || value.split(',').some(field => !permittedFields.includes(field))) {
        fail('UNSAFE_GRAPH_URL', 'Graph cursor requests an unsupported projection.');
      }
    } else if (key === '$top') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000) {
        fail('UNSAFE_GRAPH_URL', 'Graph cursor page size is invalid.');
      }
    } else if (!['$skiptoken', '$deltatoken', '$skip'].includes(key)) {
      fail('UNSAFE_GRAPH_URL', 'Graph cursor includes an unsupported query option.');
    }
  }
  return raw;
}

function retryDelay(response, attempt) {
  const header = response.headers.get('retry-after');
  if (header && header.length < 128) {
    const milliseconds = /^\d+$/.test(header)
      ? Number(header) * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
  }
  return Math.min(MAX_INLINE_RETRY_MS, 1000 * (2 ** attempt) + Math.floor(Math.random() * 250));
}

async function readJson(response) {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    fail('RESPONSE_TOO_LARGE', 'Graph response exceeds the processing limit.');
  }
  if (!response.body) fail('INVALID_GRAPH_PAGE', 'Graph returned no response body.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail('RESPONSE_TOO_LARGE', 'Graph response exceeds the processing limit.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    fail('INVALID_GRAPH_PAGE', 'Graph returned invalid JSON.');
  }
}

function projectRecord(item, kind) {
  if (!item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.id !== 'string' || !item.id || item.id.length > 4096) {
    fail('INVALID_GRAPH_PAGE', 'Graph returned an invalid record.');
  }
  const result = {};
  const participant = value => {
    if (!value || typeof value !== 'object' || !value.emailAddress ||
        typeof value.emailAddress.address !== 'string') {
      fail('INVALID_GRAPH_PAGE', 'Graph returned an invalid participant.');
    }
    const emailAddress = { address: value.emailAddress.address };
    if (typeof value.emailAddress.name === 'string') emailAddress.name = value.emailAddress.name;
    return { emailAddress };
  };
  for (const key of kind === 'folders' ? FOLDER_FIELDS : MESSAGE_FIELDS) {
    const value = item[key];
    if (value === undefined) continue;
    if (['from', 'sender'].includes(key)) {
      if (value !== null) result[key] = participant(value);
    } else if (['toRecipients', 'ccRecipients'].includes(key)) {
      if (!Array.isArray(value)) fail('INVALID_GRAPH_PAGE', 'Graph returned invalid recipients.');
      result[key] = value.map(participant);
    } else if (['isDraft', 'hasAttachments', 'isHidden'].includes(key)) {
      if (typeof value !== 'boolean') fail('INVALID_GRAPH_PAGE', 'Graph returned an invalid metadata flag.');
      result[key] = value;
    } else if (['childFolderCount', 'totalItemCount', 'unreadItemCount'].includes(key)) {
      if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_GRAPH_PAGE', 'Graph returned an invalid folder count.');
      result[key] = value;
    } else {
      if (typeof value !== 'string' || value.length > 32_768) fail('INVALID_GRAPH_PAGE', 'Graph returned invalid metadata.');
      result[key] = value;
    }
  }
  if (kind === 'delta' && item['@removed']) {
    result['@removed'] = { reason: item['@removed'].reason === 'deleted' ? 'deleted' : 'unknown' };
  }
  if (kind === 'folders' && item['@odata.type'] === '#microsoft.graph.mailSearchFolder') {
    result['@odata.type'] = '#microsoft.graph.mailSearchFolder';
  }
  if (kind === 'message') {
    for (const key of ['body', 'uniqueBody']) {
      if (item[key] === undefined) continue;
      if (item[key]?.contentType?.toLowerCase() !== 'text' || typeof item[key].content !== 'string') {
        fail('UNSUPPORTED_MESSAGE_BODY', 'Expected plain-text message content; HTML is not rendered or accepted.');
      }
      result[key] = { contentType: 'text', content: item[key].content };
    }
    if (item.internetMessageHeaders !== undefined) {
      if (!Array.isArray(item.internetMessageHeaders)) fail('INVALID_GRAPH_PAGE', 'Invalid message headers.');
      result.internetMessageHeaders = item.internetMessageHeaders.map(header => {
        if (typeof header?.name !== 'string' || typeof header?.value !== 'string') {
          fail('INVALID_GRAPH_PAGE', 'Invalid message header.');
        }
        return { name: header.name, value: header.value };
      });
    }
  }
  // Content is untrusted data; only readMessage returns explicitly requested text.
  return result;
}

/**
 * Read-only foundation. No token acquisition, scheduler, webhooks, attachment
 * extraction, durable storage, or business-state mutation is hidden here.
 * Inject a trusted token provider bound to tenantId; cursors come from trusted storage.
 */
export function createGraphReader({ tenantId, allowedMailboxIds, getAccessToken,
  fetchImpl = globalThis.fetch, sleep = delay, maxRetries = 3 } = {}) {
  tenantId = guid(tenantId, 'tenantId');
  if (!Array.isArray(allowedMailboxIds) || !allowedMailboxIds.length) {
    fail('INVALID_CONFIG', 'An explicit nonempty mailbox allowlist is required.');
  }
  const allowed = new Set(allowedMailboxIds.map(id => guid(id, 'Mailbox ID')));
  if (typeof getAccessToken !== 'function' || typeof fetchImpl !== 'function' ||
      typeof sleep !== 'function' || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    fail('INVALID_CONFIG', 'Graph reader dependencies or retry limit are invalid.');
  }
  function approveMailbox(id) {
    const normalized = guid(id, 'Mailbox ID');
    if (!allowed.has(normalized)) fail('MAILBOX_NOT_ALLOWED', 'Mailbox is not approved for ingestion.');
    return normalized;
  }
  async function page(url, mailboxId, folderId, kind) {
    validateUrl(url, mailboxId, folderId, kind);
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let token;
      try { token = await getAccessToken({ tenantId, scope: `${GRAPH_ORIGIN}/.default` }); } catch {
        fail('TOKEN_UNAVAILABLE', 'Unable to obtain an approved Graph token.');
      }
      if (typeof token !== 'string' || !token || token.length > 32_768 || /\s/.test(token)) {
        fail('TOKEN_UNAVAILABLE', 'Token provider returned an invalid token.');
      }
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
            Prefer: 'IdType="ImmutableId", odata.maxpagesize=100, outlook.body-content-type="text"' },
        });
      } catch {
        fail('GRAPH_TRANSPORT_ERROR', 'Graph read failed; retry through the durable job queue.');
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel();
        fail('GRAPH_REDIRECT_DENIED', 'Graph redirects are not followed.');
      }
      if ([429, 503].includes(response.status)) {
        const waitMs = retryDelay(response, attempt);
        await response.body?.cancel();
        if (attempt === maxRetries || waitMs > MAX_INLINE_RETRY_MS) {
          fail('GRAPH_RETRY_DEFERRED', 'Graph read must be rescheduled without advancing its cursor.',
            { status: response.status, retryAfterMs: waitMs });
        }
        await sleep(waitMs);
        continue;
      }
      if (!response.ok) {
        const status = response.status;
        let resync = status === 410;
        if ([400, 404].includes(status)) {
          try {
            const errorBody = await readJson(response);
            resync ||= errorBody?.error?.code === 'syncStateNotFound';
          } catch { /* Unreadable provider errors never expose raw response content. */ }
        } else await response.body?.cancel();
        fail(resync ? 'GRAPH_RESYNC_REQUIRED' : 'GRAPH_HTTP_ERROR',
          resync ? 'Graph cursor expired; an approved rebaseline is required.' : 'Graph rejected the read request.',
          { status });
      }
      const data = await readJson(response);
      if (kind === 'message') return data;
      if (!data || !Array.isArray(data.value)) fail('INVALID_GRAPH_PAGE', 'Graph page has no value collection.');
      return data;
    }
  }
  const api = {
    async listFolders(id, { parentFolderId } = {}) {
      const mailboxId = approveMailbox(id);
      if (parentFolderId !== undefined) parentFolderId = folderIdentifier(parentFolderId);
      const childPath = parentFolderId ? `/${encodeURIComponent(parentFolderId)}/childFolders` : '';
      let url = `${GRAPH_ORIGIN}/v1.0/users/${mailboxId}/mailFolders${childPath}?$select=${FOLDER_FIELDS.join(',')}&$top=100`;
      const folders = [];
      const visited = new Set();
      while (url) {
        if (visited.has(url) || visited.size >= MAX_PAGES) fail('GRAPH_PAGE_LIMIT', 'Folder pagination did not terminate safely.');
        visited.add(url);
        const data = await page(url, mailboxId, parentFolderId, 'folders');
        const next = data['@odata.nextLink'];
        if (next !== undefined) validateUrl(next, mailboxId, parentFolderId, 'folders');
        if (folders.length + data.value.length > 5000) fail('GRAPH_FOLDER_LIMIT', 'Folder collection exceeds the reviewed limit.');
        folders.push(...data.value.map(item => projectRecord(item, 'folders')));
        url = next;
      }
      return folders;
    },
    async listFolderTree(id) {
      const mailboxId = approveMailbox(id);
      const folders = [];
      const seen = new Set();
      const pending = [{ parentFolderId: undefined, depth: 0 }];
      for (let index = 0; index < pending.length; index += 1) {
        const { parentFolderId, depth } = pending[index];
        if (depth > 20) fail('GRAPH_FOLDER_LIMIT', 'Folder depth exceeds the reviewed traversal limit.');
        for (const folder of await api.listFolders(mailboxId, { parentFolderId })) {
          if (seen.has(folder.id)) fail('GRAPH_FOLDER_LIMIT', 'Folder discovery repeated a folder identity.');
          seen.add(folder.id);
          if (seen.size > 5000) fail('GRAPH_FOLDER_LIMIT', 'Mailbox exceeds the reviewed folder limit.');
          folders.push(folder);
          // Search folders are virtual views, not separate ingestion collections.
          if (folder.childFolderCount > 0 && folder['@odata.type'] !== '#microsoft.graph.mailSearchFolder') {
            pending.push({ parentFolderId: folder.id, depth: depth + 1 });
          }
        }
      }
      return folders;
    },
    async readMessage(id, messageId) {
      const mailboxId = approveMailbox(id);
      messageId = folderIdentifier(messageId);
      const url = `${GRAPH_ORIGIN}/v1.0/users/${mailboxId}/messages/${encodeURIComponent(messageId)}?$select=${CONTENT_FIELDS.join(',')}`;
      const result = projectRecord(await page(url, mailboxId, messageId, 'message'), 'message');
      if (result.id !== messageId) fail('INVALID_GRAPH_PAGE', 'Graph returned a different immutable message identity.');
      return result;
    },
    async readDelta(id, folderId, { cursor, onPage, commitCursor } = {}) {
      const mailboxId = approveMailbox(id);
      folderId = folderIdentifier(folderId);
      if (typeof onPage !== 'function' || typeof commitCursor !== 'function') {
        fail('INVALID_CALLBACK', 'Durable onPage and commitCursor callbacks are required.');
      }
      let url = cursor ?? `${GRAPH_ORIGIN}/v1.0/users/${mailboxId}/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=${MESSAGE_FIELDS.join(',')}`;
      validateUrl(url, mailboxId, folderId, 'delta');
      const visited = new Set();
      let messages = 0;
      while (true) {
        if (visited.has(url) || visited.size >= MAX_PAGES) fail('GRAPH_PAGE_LIMIT', 'Delta pagination did not terminate safely.');
        visited.add(url);
        const data = await page(url, mailboxId, folderId, 'delta');
        const next = data['@odata.nextLink'];
        const deltaLink = data['@odata.deltaLink'];
        if ((next === undefined) === (deltaLink === undefined)) {
          fail('INVALID_GRAPH_PAGE', 'Delta page must contain exactly one continuation or final cursor.');
        }
        validateUrl(next ?? deltaLink, mailboxId, folderId, 'delta');
        const records = data.value.map(item => projectRecord(item, 'delta'));
        await onPage(records, { tenantId, mailboxId, folderId, pageNumber: visited.size });
        messages += records.length;
        if (deltaLink !== undefined) {
          // Caller must atomically persist this cursor after durable, idempotent page upserts.
          await commitCursor(deltaLink);
          return { deltaLink, pages: visited.size, messages };
        }
        url = next;
      }
    },
  };
  return Object.freeze(api);
}
