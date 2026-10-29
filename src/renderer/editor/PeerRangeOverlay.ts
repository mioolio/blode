import type * as monaco from 'monaco-editor';
import type { CollaborationPeer } from '../../shared/collaboration';
import { clipPeerRange, peerRangeMotion, type PeerRangeRect } from './peerRangeGeometry';
import './peer-range-overlay.css';

interface PaintedPeer {
  element: HTMLDivElement;
  rect: PeerRangeRect;
}
const FADE_MS = 180;

/** Stable, pointer-transparent bands animate presence without editing Monaco's text or scroll. */
export class PeerRangeOverlay implements monaco.editor.IOverlayWidget {
  private readonly node = document.createElement('div');
  private readonly entries = new Map<string, PaintedPeer>();
  private readonly retiring = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  private readonly frames = new Map<HTMLElement, number>();
  private readonly subscriptions: monaco.IDisposable[] = [];
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly motionChanged = () => this.paint(false);
  private peers: readonly CollaborationPeer[] = [];
  private expectedUri = '';
  private disposed = false;

  constructor(private readonly editor: monaco.editor.IStandaloneCodeEditor) {
    this.node.className = 'collaboration-peer-ranges';
    this.node.setAttribute('aria-hidden', 'true');
    editor.addOverlayWidget(this);
    this.subscriptions.push(
      editor.onDidScrollChange(() => this.paint(false)),
      editor.onDidLayoutChange(() => this.paint(false)),
      editor.onDidChangeHiddenAreas(() => this.paint(false)),
      editor.onDidChangeModelContent(() => this.paint(false)),
      editor.onDidChangeModel(() => {
        this.clear();
        this.paint(false);
      }),
      editor.onDidDispose(() => this.dispose()),
    );
    this.motion.addEventListener('change', this.motionChanged);
  }

  getId() {
    return `blode-peer-ranges-${this.editor.getId()}`;
  }
  getDomNode() {
    return this.node;
  }
  getPosition() {
    return null;
  }

  update(peers: readonly CollaborationPeer[], path: string, modelUri: string, animate: boolean) {
    if (this.disposed) return;
    if (this.expectedUri !== modelUri) this.clear();
    this.expectedUri = modelUri;
    this.peers = path ? peers.filter((peer) => peer.attention !== 'inactive' && peer.path === path) : [];
    this.paint(animate);
  }

  private cancelFrame(element: HTMLElement) {
    const frame = this.frames.get(element);
    if (frame !== undefined) cancelAnimationFrame(frame);
    this.frames.delete(element);
  }

  private reveal(element: HTMLElement) {
    this.cancelFrame(element);
    this.frames.set(
      element,
      requestAnimationFrame(() => {
        this.frames.delete(element);
        if (!this.disposed && element.isConnected) element.style.opacity = '1';
      }),
    );
  }

  private retire(entry: PaintedPeer, animate: boolean) {
    this.cancelFrame(entry.element);
    if (!animate || this.motion.matches) {
      entry.element.remove();
      return;
    }
    const element = entry.element;
    // Freeze the currently displayed geometry if a previous short move is still easing.
    const current = window.getComputedStyle(element);
    element.style.transform = current.transform;
    element.style.height = current.height;
    element.removeAttribute('data-peer-id');
    element.dataset.retiring = 'true';
    element.dataset.motion = 'fade';
    element.style.opacity = '0';
    this.retiring.set(
      element,
      setTimeout(() => {
        element.remove();
        this.retiring.delete(element);
      }, FADE_MS + 30),
    );
  }

  private clearRetiring() {
    for (const [element, timer] of this.retiring) {
      clearTimeout(timer);
      element.remove();
    }
    this.retiring.clear();
  }

  private clear() {
    for (const element of this.frames.keys()) this.cancelFrame(element);
    this.clearRetiring();
    for (const entry of this.entries.values()) entry.element.remove();
    this.entries.clear();
  }

  private paint(remoteChange: boolean) {
    if (this.disposed) return;
    // A local scroll/fold/resize takes priority over a fading previous reader location.
    if (!remoteChange) this.clearRetiring();
    const model = this.editor.getModel();
    if (!model || model.uri.toString() !== this.expectedUri) {
      this.clear();
      return;
    }
    const layout = this.editor.getLayoutInfo();
    const height = Math.max(0, layout.height - layout.horizontalScrollbarHeight);
    this.node.style.left = `${layout.contentLeft}px`;
    this.node.style.width = `${Math.max(0, layout.contentWidth)}px`;
    this.node.style.height = `${height}px`;
    const live = new Set<string>();
    const scrollTop = this.editor.getScrollTop();
    for (const peer of this.peers) {
      const first = Math.max(1, Math.min(model.getLineCount(), peer.startLine));
      const last = Math.max(first, Math.min(model.getLineCount(), peer.endLine));
      const rect = clipPeerRange(
        this.editor.getTopForLineNumber(first),
        this.editor.getBottomForLineNumber(last),
        scrollTop,
        height,
      );
      if (!rect) continue;
      live.add(peer.peerId);
      let entry = this.entries.get(peer.peerId);
      const movement = peerRangeMotion(entry?.rect, rect, height, remoteChange, this.motion.matches);
      if (entry && movement === 'crossfade') {
        this.retire(entry, true);
        this.entries.delete(peer.peerId);
        entry = undefined;
      }
      if (!entry) {
        const element = document.createElement('div');
        element.className = 'collaboration-peer-range';
        element.dataset.peerId = peer.peerId;
        element.style.opacity = remoteChange && !this.motion.matches ? '0' : '1';
        entry = { element, rect };
        this.entries.set(peer.peerId, entry);
        this.node.append(element);
        if (remoteChange && !this.motion.matches) this.reveal(element);
      } else if (!remoteChange || this.motion.matches) {
        this.cancelFrame(entry.element);
        entry.element.style.opacity = '1';
      }
      entry.rect = rect;
      entry.element.dataset.motion = movement;
      entry.element.dataset.editing = String(peer.editing);
      entry.element.style.setProperty(
        '--peer-range-color',
        /^#[a-f0-9]{6}$/i.test(peer.color) ? peer.color : '#2563eb',
      );
      entry.element.style.transform = `translateY(${rect.top}px)`;
      entry.element.style.height = `${rect.height}px`;
    }
    for (const [id, entry] of this.entries)
      if (!live.has(id)) {
        this.entries.delete(id);
        this.retire(entry, remoteChange);
      }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.motion.removeEventListener('change', this.motionChanged);
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.clear();
    this.editor.removeOverlayWidget(this);
    this.node.remove();
  }
}
