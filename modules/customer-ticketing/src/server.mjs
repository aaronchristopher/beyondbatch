import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { makeFixtures, demoPrincipals } from './fixtures.mjs';
import { projectWorkspace } from './security/workspace.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = { '/':['index.html','text/html; charset=utf-8'], '/app.js':['app.js','text/javascript; charset=utf-8'], '/styles.css':['styles.css','text/css; charset=utf-8'] };

/** A read-only loopback development harness. Production intentionally cannot start. */
export function createDemoServer({requests=makeFixtures(), clock=()=>new Date(), managedPreview=false, workspaceProvider=null} = {}) {
  if (workspaceProvider !== null && typeof workspaceProvider !== 'function') throw new TypeError('workspace provider must be a function');
  return createServer(async (req,res) => {
    const headers = {
      'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy':'no-referrer', 'Cross-Origin-Resource-Policy':'same-origin',
    };
    const respond = (status,body,type='application/json; charset=utf-8') => {
      res.writeHead(status,{...headers,'Content-Type':type}); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    // Prevent arbitrary websites from reading or embedding an unauthenticated local preview.
    const allowedHost = managedPreview ? /^(127\.0\.0\.1|localhost|terminal\.local)(:\d+)?$/ : /^(127\.0\.0\.1|localhost)(:\d+)?$/;
    if (!allowedHost.test(req.headers.host || '')) return respond(403,{error:'Approved preview host required'});
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return respond(403,{error:'Origin rejected'});
    if (req.headers['sec-fetch-site'] === 'cross-site') return respond(403,{error:'Cross-site request rejected'});
    if (req.method !== 'GET') return respond(405,{error:'Read-only preview'});
    try {
      const url = new URL(req.url,'http://localhost');
      if (url.pathname === '/health') return respond(200,{mode:'development-demo',microsoftConnected:false,productionReady:false,durableFixture:workspaceProvider !== null});
      if (url.pathname === '/api/workspace') {
        const personaKey=url.searchParams.get('persona') || 'pm';
        const principal=Object.hasOwn(demoPrincipals,personaKey) ? demoPrincipals[personaKey] : null;
        if (!principal) return respond(400,{error:'Unknown demo persona'});
        const now=clock();
        // Provider is injected by local fixture startup, never selected by HTTP input.
        if (workspaceProvider) return respond(200,await workspaceProvider({principal:structuredClone(principal),now}));
        return respond(200,projectWorkspace({principal,requests,now,coverage:{mode:'fictional',status:'Demo only',detail:'Fictional data. Microsoft ingestion and production sign-in are not connected.'}}));
      }
      const asset=assets[url.pathname];
      if (!asset) return respond(404,{error:'Not found'});
      return respond(200,await readFile(resolve(publicDir,asset[0])),asset[1]);
    } catch {
      return respond(500,{error:'Preview request failed'});
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--demo') || process.env.NODE_ENV === 'production') {
    process.stderr.write('Production startup is blocked: Entra sessions, database, and durable ingestion must be implemented and verified. Use npm run demo for fictional local data.\n');
    process.exitCode=1;
  } else {
    const port=Number(process.env.DEMO_PORT || 4173);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DEMO_PORT');
    const managedPreview=process.argv.includes('--managed-preview') && process.env.SITES_MANAGED_LINUX_CONTAINER === '1';
    createDemoServer({managedPreview}).listen(port,managedPreview ? '0.0.0.0' : '127.0.0.1',()=>process.stdout.write(`Fictional development preview: http://${managedPreview ? 'terminal.local' : '127.0.0.1'}:${port}\n`));
  }
}
