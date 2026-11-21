import { expect, it } from 'vitest';
import { nodeScheduler } from '../../src/main';

it('agenda atraso zero de forma síncrona e permite reagendar a mesma ação', () => {
  const seen: number[] = [];
  const action = nodeScheduler.schedule<number>(function (number) {
    if (number === undefined) throw new Error('Ação sem valor.');
    seen.push(number);
    if (number < 3) this.schedule(number + 1);
  }, 0, 1);
  try {
    expect(seen).toEqual([1, 2, 3]);
  } finally {
    action.unsubscribe();
  }
});

it('temporizadores reais longos não mantêm o processo ativo e podem ser cancelados', () => {
  const activeTimers = () => process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
  const before = activeTimers();
  const longDelay = nodeScheduler.schedule(() => { throw new Error('Temporizador longo disparado.'); }, 3_000_000_000);
  try {
    expect(activeTimers()).toBe(before);
  } finally {
    longDelay.unsubscribe();
  }
  expect(longDelay.closed).toBe(true);
});
