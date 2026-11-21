import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/infra/http/app';
import { testRegistry } from './fixture';

const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function registeredOperations(stack: unknown): string[] {
  if (!Array.isArray(stack)) {
    throw new Error('O Express não expôs as operações registradas.');
  }
  return stack.flatMap((layer: unknown) => {
    if (!isRecord(layer) || !isRecord(layer.route)) {
      return [];
    }
    const { path, methods: registered } = layer.route;
    if (typeof path !== 'string' || !isRecord(registered)) {
      throw new Error('Não foi possível inspecionar a rota Express.');
    }
    return Object.keys(registered).filter(method => registered[method] === true)
      .map(method => `${method} ${path.replace(/:(\w+)/g, '{$1}')}`);
  });
}

function checkCoverage(stack: unknown, paths: Record<string, unknown>): void {
  const documented = Object.entries(paths).flatMap(([path, item]) =>
    isRecord(item) ? Object.keys(item).filter(method => methods.has(method))
      .map(method => `${method} ${path}`) : []);
  const actual = registeredOperations(stack);
  const missing = actual.filter(operation => !documented.includes(operation));
  const extra = documented.filter(operation => !actual.includes(operation));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Rotas sem documentação [${missing.join(', ')}] ou sem implementação [${extra.join(', ')}].`);
  }
}

describe('OpenAPI', () => {
  it('valida o esquema e confere as operações efetivamente registradas', async () => {
    const document = await SwaggerParser.validate('openapi.yaml', { resolve: { external: false } });
    expect(document.paths).toBeDefined();
    checkCoverage(createApp(testRegistry()).router.stack, document.paths ?? {});
  });

  it('rejeita a ausência de uma operação registrada', async () => {
    const document = await SwaggerParser.parse('openapi.yaml');
    const paths: Record<string, unknown> = { ...document.paths };
    delete paths['/health'];
    expect(() => checkCoverage(createApp(testRegistry()).router.stack, paths)).toThrow('get /health');
  });
});
