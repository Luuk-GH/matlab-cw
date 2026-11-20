/**
 * A view of the shared MATLAB session's Command Window. The session manager broadcasts everything to all attached
 * views (today only the HTML Command Window; the interface keeps a second view, e.g. a terminal, possible).
 */
export interface ConsoleView {
  /** A command the session runs on the user's behalf (shown as `>> code`). */
  echoCommand(display: string): void;
  /** MATLAB output. */
  writeOutput(text: string, stream: 'out' | 'err'): void;
  /** MATLAB waits for the next command (`debug`: at K>>). */
  showPrompt(kind: 'ready' | 'debug'): void;
  /** A command started running. */
  setBusy(): void;
  /** The running command waits: input() (with its prompt text) or pause without argument. */
  requestInput(source: 'input' | 'pause', prompt: string): void;
  /** A line typed in the Command Window answered input() (`prompt`: input()'s prompt text). */
  echoInput(text: string, prompt: string): void;
  /** clc: clear the view. */
  clearScreen(): void;
  /** An informational line (session started, ended, ...). */
  info(text: string): void;
  /** The session has gone away: forget the prompt and input state. */
  resetInput(): void;
}
