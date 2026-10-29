export interface TerminalChunk {
  sequence: number;
  data: string;
}
export interface TerminalCursor {
  sessionId?: string;
  after?: number;
}
export interface TerminalState {
  running: boolean;
  command: string;
  cwd: string;
  lines: string[];
  exitCode: number | null;
  active?: boolean;
  shell?: string;
  sessionId?: string;
  sequence?: number;
  chunks?: TerminalChunk[];
  reset?: boolean;
  cols?: number;
  rows?: number;
}
export interface TerminalApi {
  terminalState(cursor?: TerminalCursor): Promise<TerminalState>;
  terminalOpen(size?: { cols?: number; rows?: number }): Promise<TerminalState>;
  terminalRun(request: { command: string }): Promise<TerminalState>;
  terminalStop(): Promise<void>;
  terminalWrite(request: { data: string; sessionId?: string }): Promise<void>;
  terminalResize(request: { cols: number; rows: number; sessionId?: string }): Promise<void>;
  terminalClose(): Promise<void>;
}
