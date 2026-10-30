export interface TerminalChunk {
  sequence: number;
  data: string;
}
export interface TerminalCursor {
  terminalId?: string;
  sessionId?: string;
  after?: number;
}
export interface TerminalState {
  terminalId?: string;
  name?: string;
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
export interface TerminalTarget {
  terminalId?: string;
  sessionId?: string;
}
export interface TerminalOpenOptions {
  terminalId?: string;
  name?: string;
  create?: boolean;
  cols?: number;
  rows?: number;
}
export interface TerminalSessionInfo {
  terminalId: string;
  name: string;
  sessionId?: string;
  active: boolean;
  running: boolean;
  cwd: string;
  shell?: string;
  exitCode: number | null;
}
export interface TerminalApi {
  terminalSessions(): Promise<TerminalSessionInfo[]>;
  terminalState(cursor?: TerminalCursor): Promise<TerminalState>;
  terminalOpen(options?: TerminalOpenOptions): Promise<TerminalState>;
  terminalRun(request: TerminalTarget & { command: string }): Promise<TerminalState>;
  terminalStop(target?: TerminalTarget): Promise<void>;
  terminalWrite(request: TerminalTarget & { data: string }): Promise<void>;
  terminalResize(request: TerminalTarget & { cols: number; rows: number }): Promise<void>;
  terminalClose(target?: TerminalTarget): Promise<void>;
}
