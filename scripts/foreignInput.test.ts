// MATLAB asks for input() / pause for a command started elsewhere (the MATLAB terminal): every client gets those events
// ([verified, R2026b]), but our window must not turn its input line into an answer line. Run: npm run test:unit
import * as assert from 'assert';
import { EventEmitter } from 'events';
import { MatlabBackend } from '../src/backend/types';
import { MatlabSession } from '../src/matlabSession';

class StubBackend extends EventEmitter {
  evals: string[] = [];
  /** Pending evals; MATLAB answers the newest first (an input() answer before the command that asked). */
  private done: (() => void)[] = [];
  start() { return Promise.resolve({ release: 'R2026b' }); }
  eval(code: string) { this.evals.push(code); return new Promise<void>(r => { this.done.push(r); }); }
  feval() { return Promise.resolve([]); }
  interrupt() { /* not used */ }
  unpause() { /* not used */ }
  dispose() { /* not used */ }
  finishEval() { this.done.pop()?.(); }
  prompt(state: string, idle: boolean) { this.emit('prompt', state, idle); }
}

async function main(): Promise<void> {
  const b = new StubBackend();
  const s = new MatlabSession(b as unknown as MatlabBackend);
  const inputs: string[] = [];
  const foreign: string[] = [];
  s.on('input', src => inputs.push(src));
  s.on('foreignInput', (src, prompt) => foreign.push(`${src}:${prompt}`));
  b.prompt('READY', true);
  await s.start();
  assert.strictEqual(s.state, 'idle');

  // The terminal runs ask_input: BUSY, then the (global) input prompt and INPUT state.
  b.prompt('BUSY', false);
  b.emit('inputPrompt', 'Enter a number: ');
  b.prompt('INPUT', true);
  b.prompt('INPUT', true);   // repeated events report once
  assert.deepStrictEqual(inputs, [], 'our input line is not taken over');
  assert.deepStrictEqual(foreign, ['input:Enter a number: ']);
  assert.strictEqual(s.state, 'busy', 'shown as busy while MATLAB waits elsewhere');
  b.prompt('BUSY', false);
  b.prompt('READY', true);
  assert.strictEqual(s.state, 'idle');

  // A pause started elsewhere: the same.
  b.prompt('BUSY', false);
  b.prompt('PAUSE', true);
  assert.deepStrictEqual(foreign, ['input:Enter a number: ', 'pause:']);
  b.prompt('READY', true);

  // Our own command asking for input still turns the input line into an answer line.
  const run = s.sendLine("x = input('Name: ')");
  b.prompt('BUSY', false);
  b.emit('inputPrompt', 'Name: ');
  b.prompt('INPUT', true);
  assert.deepStrictEqual(inputs, ['input']);
  assert.strictEqual(s.state, 'input');
  assert.strictEqual(foreign.length, 2, 'no foreign report for our own command');
  s.sendInput('7');
  b.prompt('BUSY', false);
  b.finishEval();   // the answer's eval
  b.finishEval();
  b.prompt('READY', true);
  assert.strictEqual(await run, 'ready');

  // [verified, R2026b] After an input() answer MATLAB can end the command with only its evalResponse (no READY), so
  // the next command goes straight to DEBUG without a new BUSY. It must still finish at K>>.
  const asking = s.sendLine("run('ask_input.m')");
  b.prompt('BUSY', false);
  b.prompt('INPUT', true);
  s.sendInput('7');
  b.prompt('BUSY', false);
  b.finishEval(); b.finishEval();   // answer + run: evalResponses, but no READY prompt follows
  assert.strictEqual(await asking, 'ready');
  const kb = s.sendLine('kb = 1; keyboard');
  b.prompt('DEBUG', true);          // straight to K>>, no BUSY first
  const kind = await Promise.race([kb, new Promise(r => setTimeout(() => r('timeout'), 1000))]);
  assert.strictEqual(kind, 'debug', 'keyboard after an input() answer reaches K>>');
  assert.strictEqual(s.state, 'debug');

  console.log('foreignInput: all assertions passed');
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
