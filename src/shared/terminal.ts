export interface TerminalState {
  running: boolean;
  command: string;
  cwd: string;
  lines: string[];
  exitCode: number | null;
}
export interface TerminalApi {
  terminalState(): Promise<TerminalState>;
  terminalRun(request: { command: string }): Promise<TerminalState>;
  terminalStop(): Promise<void>;
}
