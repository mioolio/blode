type CopyDocument = Pick<Document, 'activeElement' | 'body' | 'createElement' | 'execCommand'>;
interface ClipboardEnvironment {
  document: CopyDocument;
  clipboard?: Pick<Clipboard, 'writeText'>;
}

function copyUsingDocument(text: string, doc: CopyDocument): boolean {
  const previous = doc.activeElement as HTMLElement | null;
  let input: HTMLTextAreaElement | undefined;
  try {
    input = doc.createElement('textarea');
    input.value = text;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0';
    doc.body.append(input);
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, text.length);
    return !!doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    input?.remove();
    try {
      previous?.focus?.({ preventScroll: true });
    } catch {
      /* The previous editor may have closed. */
    }
  }
}

/** Plain HTTP has no Clipboard API; run its DOM fallback within the key event. */
export async function copyTerminalSelection(
  text: string,
  environment?: ClipboardEnvironment,
): Promise<boolean> {
  const doc = environment?.document ?? document;
  try {
    const clipboard = environment ? environment.clipboard : navigator.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Permission failures can still permit the synchronous copy command. */
  }
  return copyUsingDocument(text, doc);
}
