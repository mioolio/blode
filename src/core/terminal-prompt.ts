import { terminalText } from './terminal-text';

/** ConPTY forwards OSC immediately, ahead of its pending screen diff. A completed
 * command becomes idle only after that command's visible prompt reaches the stream.
 */
export class TerminalPrompt {
  private execution = 0;
  private requested = 0;
  private finished = -1;
  private receipt?: { execution: number; code: number; prompt: string };
  private rendered = '';

  awaitingBegin() {
    return this.requested > this.execution;
  }

  request() {
    this.requested = Math.max(this.execution, this.requested) + 1;
    this.receipt = undefined;
    this.rendered = '';
  }

  begin(execution: number) {
    if (execution < this.execution || execution <= this.finished) return false;
    this.execution = execution;
    if (execution < this.requested) return false;
    this.requested = execution;
    this.receipt = undefined;
    this.rendered = '';
    return true;
  }

  prompt(execution: number, code: number, cwd: string, executed: boolean) {
    if (execution < this.execution || execution < this.requested || execution <= this.finished) return;
    this.execution = execution;
    if (!executed && this.requested !== 0) return;
    this.receipt = { execution, code, prompt: `PS ${cwd}> ` };
    return this.finishedPrompt();
  }

  screen(data: string): { code: number; execution: number } | undefined {
    if (this.requested > this.finished) this.rendered = (this.rendered + data).slice(-64000);
    return this.finishedPrompt();
  }

  private finishedPrompt(): { code: number; execution: number } | undefined {
    const receipt = this.receipt;
    if (!receipt) return;
    // ConPTY may wrap a long working directory across screen rows.
    const visible = terminalText(this.rendered).replace(/[\r\n]/g, '');
    // Windows can render the final blank as CSI 1 C instead of a literal space.
    if (!visible.trimEnd().endsWith(receipt.prompt.trimEnd())) return;
    this.receipt = undefined;
    this.finished = receipt.execution;
    return { code: receipt.code, execution: receipt.execution };
  }
}
