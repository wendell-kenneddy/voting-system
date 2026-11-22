// Diagnóstico da revisão. Não altera as implementações nem integra suas suítes.
// Pré-requisito: npm run build em com-harness/ e without-harness/.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer, request } = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const load = (project, file) => require(path.join(root, project, file));
const { PollRegistry } = load('com-harness', 'dist/application/pollRegistry.js');
const { systemClock, nodeScheduler } = load('com-harness', 'dist/main.js');
const { createApp: harnessApp } = load('com-harness', 'dist/infra/http/app.js');
const { createApp: withoutApp } = load('without-harness', 'dist/app.js');
const { VirtualTimeScheduler } = load('without-harness', 'node_modules/rxjs');
const config = { port: 0, maxVotesPerUser: 3, rankingThrottleMs: 1000 };
const body = { title: 'Diagnóstico', options: ['A', 'B'] };
const vote = { voteId: 'v1', userId: 'u1', option: 'A' };

function value(result) {
  assert.equal(result.ok, true);
  return result.value;
}

function harnessRegistry() {
  let id = 0;
  return new PollRegistry({ clock: systemClock, scheduler: nodeScheduler,
    ids: { next: () => `diagnostico-${id++}` }, ...config });
}

function fanout(project, clients) {
  let inCommand = false;
  let inside = 0;
  let outside = 0;
  const subscriptions = [];
  const next = event => {
    // Exclui o snapshot inicial de cada conexão.
    const version = project === 'com-harness' ? event.ranking?.version : event.data?.version;
    if (version !== 1) return;
    if (inCommand) inside++; else outside++;
  };
  if (project === 'com-harness') {
    const registry = harnessRegistry();
    try {
      const poll = value(registry.create(body));
      for (let i = 0; i < clients; i++) {
        subscriptions.push(value(registry.stream(poll.id)).subscribe({ next }));
      }
      inCommand = true;
      assert.equal(value(registry.vote(poll.id, vote)).status, 'accepted');
      inCommand = false;
    } finally {
      subscriptions.forEach(subscription => subscription.unsubscribe());
      registry.dispose();
    }
  } else {
    const scheduler = new VirtualTimeScheduler();
    const application = withoutApp(config, { scheduler });
    try {
      const poll = application.service.create(body);
      const runtime = application.store.get(poll.id).runtime;
      for (let i = 0; i < clients; i++) subscriptions.push(runtime.events.subscribe({ next }));
      inCommand = true;
      assert.equal(application.service.vote(poll.id, vote).status, 'accepted');
      inCommand = false;
      scheduler.flush();
    } finally {
      subscriptions.forEach(subscription => subscription.unsubscribe());
      application.dispose();
    }
  }
  return { project, clients, notificationsInsideVote: inside, notificationsAfterVote: outside };
}

async function pendingBody(project) {
  const registry = project === 'com-harness' ? harnessRegistry() : null;
  const application = registry ? { app: harnessApp(registry), dispose: () => registry.dispose() }
    : withoutApp(config);
  const server = createServer(application.app);
  let client;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const partialBody = new Promise(resolve => server.once('request', incoming => incoming.once('data', resolve)));
    const response = new Promise((resolve, reject) => {
      client = request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/polls', method: 'POST', headers: { 'Content-Type': 'application/json' } }, incoming => {
        let text = '';
        incoming.setEncoding('utf8');
        incoming.on('data', chunk => { text += chunk; });
        incoming.on('end', () => {
          try { resolve({ status: incoming.statusCode, body: JSON.parse(text) }); }
          catch (error) { reject(error); }
        });
        incoming.on('error', reject);
      });
      client.setTimeout(3000, () => client.destroy(new Error('Timeout no diagnóstico')));
      client.on('error', reject);
      client.write('{"title":"Encerramento",');
    });
    await partialBody;
    // Reproduz a ordem do shutdown de produção: close() antes de dispose().
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    application.dispose();
    client.end('"options":["A","B"],"durationSeconds":60}');
    const result = await response;
    await closed;
    return { project, statusAfterDispose: result.status,
      createdPollAfterDispose: result.status === 201, error: result.body.error ?? null };
  } finally {
    client?.destroy();
    application.dispose();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  const result = {
    node: process.version,
    fanout: ['com-harness', 'without-harness'].flatMap(project => [1, 10, 100].map(n => fanout(project, n))),
    shutdown: [],
  };
  for (const project of ['com-harness', 'without-harness']) result.shutdown.push(await pendingBody(project));
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
