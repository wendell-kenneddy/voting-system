import { createServer, type Server } from 'node:http';
import { createApp } from './app';
import { readConfig, type Config } from './config';

export function closeServer(server: Server, dispose: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => server.closeAllConnections(), 2000);
    deadline.unref();
    server.close(error => {
      clearTimeout(deadline);
      if (error) reject(error); else resolve();
    });
    dispose();
    server.closeIdleConnections();
  });
}

export function startServer(config: Config) {
  const application = createApp(config);
  const server = createServer(application.app);
  let shutdown: Promise<void> | undefined;
  const stop = () => shutdown ??= closeServer(server, application.dispose);
  server.listen(config.port, () => console.log(`Voting API listening on port ${config.port}`));
  return { ...application, server, stop };
}

if (require.main === module) {
  try {
    const { server, stop } = startServer(readConfig(process.env));
    const onSignal = () => {
      void stop().catch(error => { console.error(error); process.exitCode = 1; });
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    server.once('close', () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    });
    server.once('error', error => {
      console.error(error);
      process.exitCode = 1;
      onSignal();
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
