export interface LogViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Each output view follows its own tail until the reader scrolls up. */
export class LogScrollController {
  private positions = new Map<string, { top: number; following: boolean }>();
  private key = '';
  private visible = false;

  remember(key: string, viewport: LogViewport) {
    this.positions.set(key, {
      top: viewport.scrollTop,
      following: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 24,
    });
  }

  update(key: string, viewport: LogViewport | null, visible: boolean) {
    if (!viewport || !visible) {
      this.visible = false;
      return;
    }
    const position = this.positions.get(key) ?? { top: 0, following: true };
    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (key !== this.key || !this.visible || position.following)
      viewport.scrollTop = position.following ? maximum : Math.min(position.top, maximum);
    this.positions.set(key, { ...position, top: viewport.scrollTop });
    this.key = key;
    this.visible = true;
  }
}
