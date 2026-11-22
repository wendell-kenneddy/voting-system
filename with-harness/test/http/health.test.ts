import { afterAll, beforeAll, it } from 'vitest';
import { httpFixture } from './fixture';

const fixture = httpFixture();
beforeAll(fixture.start);
afterAll(fixture.stop);

it('responde ao health check em JSON', async () => {
  await fixture.api.get('/health')
    .expect('Content-Type', /application\/json/)
    .expect(200, { status: 'ok' });
});
