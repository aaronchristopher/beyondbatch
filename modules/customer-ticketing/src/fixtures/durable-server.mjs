import {mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {FixturePipeline} from './durable-pipeline.mjs';
import {seedDurableWorkspace,durableWorkspace} from './durable-workspace.mjs';
import {createDemoServer} from '../server.mjs';
if(!process.argv.includes('--demo')||process.env.NODE_ENV==='production'){
 process.stderr.write('Production startup blocked. This entry point is fictional local persistence only; use npm run demo:durable.\n');process.exitCode=1;
}else{
 const port=Number(process.env.DEMO_PORT||4174);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid DEMO_PORT');
 const file=resolve('.fixture-data/requests.sqlite');mkdirSync(dirname(file),{recursive:true});
 const app=new FixturePipeline(file);await seedDurableWorkspace(app);
 const server=createDemoServer({workspaceProvider:({principal,now})=>durableWorkspace(app,principal,now)});
 server.listen(port,'127.0.0.1',()=>process.stdout.write(`Persisted FICTIONAL waiting list: http://127.0.0.1:${port}\nLocal fixture database: ${file}\nNo live email, real sign-in or outbound sending.\n`));
 const shutdown=()=>server.close(()=>{app.close();process.exitCode=0;});process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
 server.on('error',error=>{app.close();throw error;});
}
